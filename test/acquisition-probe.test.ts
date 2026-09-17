import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ACQUISITION_INPUT_JSON_SCHEMA,
  ACQUISITION_TOOL_DESCRIPTION,
  capturePreValidationToolArguments,
  createAcquisitionProbeApp,
} from "../diagnostics/acquisition-probe/src/app.ts";
import { generateAcquisitionFixture } from "../diagnostics/acquisition-probe/src/fixture.ts";
import { createScoreReport } from "../diagnostics/acquisition-probe/src/scoring.ts";
import { FileDiagnosticStore, sha256 } from "../diagnostics/acquisition-probe/src/storage.ts";
import {
  ACQUISITION_TOOL_NAME,
  type AcquisitionRunMetadata,
} from "../diagnostics/acquisition-probe/src/types.ts";

function runMetadata(overrides: Partial<AcquisitionRunMetadata> = {}): AcquisitionRunMetadata {
  return {
    fixture_id: "alice-acquisition-test",
    provider: "chatgpt",
    account_plan: "test-plan",
    region: "test-region",
    surface: "web",
    host_version: "not exposed",
    entry_position: "new project conversation",
    acquisition_leg: "ambient",
    call_mode: "single-call-v1",
    trial: 1,
    exact_prompt: "Exact synthetic prompt",
    exact_prompt_sha256: sha256("Exact synthetic prompt"),
    ...overrides,
  };
}

test("generates the complete marker fixture and valid file formats", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alice-acquisition-fixture-"));
  let markerNumber = 1000;
  const { directory, manifest } = await generateAcquisitionFixture({
    outputDirectory: root,
    now: new Date("2026-09-17T08:00:00.000Z"),
    fixtureNonce: "test01",
    nextMarkerNumber: () => markerNumber++,
  });
  assert.equal(manifest.conversations.length, 5);
  assert.equal(
    manifest.conversations.flatMap((conversation) => conversation.message_markers).length,
    20,
  );
  assert.equal(manifest.contract_version, "alice_acquisition_fixture_v2");
  assert.equal(manifest.counts.designated_user_messages, 20);
  assert.equal(manifest.counts.expected_provider_setup_replies, 20);
  assert.equal(manifest.setup.expected_provider_reply, "ACK");
  assert.equal(manifest.setup.provider_generated_replies_are_fixture_evidence, false);
  assert.equal(manifest.decisions.length, 6);
  assert.equal(manifest.decisions.filter((decision) => decision.status === "superseded").length, 1);
  assert.equal(manifest.open_questions.length, 3);
  assert.equal(manifest.files.filter((file) => file.required).length, 4);
  assert.equal(manifest.files.filter((file) => !file.required).length, 1);
  assert.equal(manifest.expected_markers.length, 41);
  assert.equal(manifest.negative_markers.length, 5);
  assert.equal(new Set(manifest.expected_markers).size, manifest.expected_markers.length);
  assert.equal(new Set(manifest.negative_markers).size, manifest.negative_markers.length);

  const pdf = await readFile(path.join(directory, "provider-upload", "northstar-brief.pdf"));
  const png = await readFile(path.join(directory, "provider-upload", "northstar-marker.png"));
  const docx = await readFile(path.join(directory, "provider-upload", "northstar-optional.docx"));
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(docx.readUInt32LE(0), 0x04034b50);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(directory, file.relative_path));
    assert.equal(bytes.length, file.byte_size);
    assert.equal(sha256(bytes), file.sha256);
  }

  const providerSourceFiles = [
    ...(await readdir(path.join(directory, "conversations"))).map((name) =>
      path.join(directory, "conversations", name),
    ),
    ...(await readdir(path.join(directory, "provider-upload"))).map((name) =>
      path.join(directory, "provider-upload", name),
    ),
    path.join(directory, "operator-only", "project-instructions.txt"),
    path.join(directory, manifest.artifact.relative_path),
  ];
  const providerSource = Buffer.concat(
    await Promise.all(providerSourceFiles.map((file) => readFile(file))),
  );
  for (const falseMarker of manifest.negative_markers) {
    assert.equal(providerSource.includes(Buffer.from(falseMarker)), false);
  }
});

test("stores an exact pre-validation snapshot once and expires or deletes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alice-acquisition-store-"));
  const store = new FileDiagnosticStore(root);
  const created = await store.createSession(runMetadata(), {
    now: new Date("2026-09-17T08:00:00.000Z"),
    ttlMs: 60_000,
  });
  assert.equal(
    (await store.resolveSessionToken(created.token, new Date("2026-09-17T08:00:30.000Z")))
      ?.session_id,
    created.session.session_id,
  );
  assert.equal(await store.resolveSessionToken("wrong-token"), undefined);

  const argumentsObject = {
    arbitrary_provider_shape: {
      messages: [{ role: "user", content: "ALICE_MESSAGE_01_1000" }],
      unanticipated_field: true,
    },
  };
  const exactJson = JSON.stringify(argumentsObject);
  const captured = await store.capture(
    created.session,
    exactJson,
    argumentsObject,
    new Date("2026-09-17T08:00:31.000Z"),
  );
  assert.equal(captured.received_arguments.exact_json, exactJson);
  assert.equal(captured.received_arguments.sha256, sha256(exactJson));
  assert.deepEqual(captured.parsed_arguments, argumentsObject);
  await assert.rejects(
    store.capture(
      created.session,
      exactJson,
      argumentsObject,
      new Date("2026-09-17T08:00:32.000Z"),
    ),
    /one permitted call/,
  );

  const pruned = await store.pruneExpired(new Date("2026-09-17T08:01:01.000Z"));
  assert.deepEqual(pruned, { sessions_deleted: 1, records_deleted: 1 });

  const second = await store.createSession(runMetadata({ trial: 2 }));
  const deleted = await store.deleteSession(second.session.session_id);
  assert.deepEqual(deleted, { session_deleted: true, record_deleted: false });
  assert.equal(await store.resolveSessionToken(second.token), undefined);
});

test("scores exact markers, negative controls, order, and original file bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alice-acquisition-score-"));
  let markerNumber = 2000;
  const { directory, manifest } = await generateAcquisitionFixture({
    outputDirectory: root,
    fixtureNonce: "score1",
    nextMarkerNumber: () => markerNumber++,
  });
  const exactFile = manifest.files.find((file) => file.required);
  assert.ok(exactFile);
  const exactBytes = await readFile(path.join(directory, exactFile.relative_path));
  const argumentsObject = {
    project: manifest.markers.project[0],
    conversations: manifest.markers.conversations,
    messages: manifest.markers.messages,
    negative_control_claim: manifest.negative_markers[0],
    exact_file_base64: exactBytes.toString("base64"),
  };
  const exactJson = JSON.stringify(argumentsObject);
  const sessionId = crypto.randomUUID();
  const noEvidenceSessionId = crypto.randomUUID();
  const report = createScoreReport(
    manifest,
    [
      {
        contract_version: "alice_acquisition_probe_v1",
        record_id: crypto.randomUUID(),
        session_id: sessionId,
        tool_name: ACQUISITION_TOOL_NAME,
        received_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        run: runMetadata({ fixture_id: manifest.fixture_id }),
        received_arguments: {
          exact_json: exactJson,
          sha256: sha256(exactJson),
          utf8_bytes: Buffer.byteLength(exactJson),
        },
        parsed_arguments: argumentsObject,
      },
    ],
    [
      {
        contract_version: "alice_acquisition_probe_v1",
        outcome_id: crypto.randomUUID(),
        session_id: sessionId,
        observed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        source: "operator",
        kind: "provider_observed_success",
        value: "yes",
        detail_code: "host_confirmed",
      },
      {
        contract_version: "alice_acquisition_probe_v1",
        outcome_id: crypto.randomUUID(),
        session_id: noEvidenceSessionId,
        observed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        source: "runtime",
        kind: "payload_ceiling_reached",
        value: "yes",
        detail_code: "request_body_over_5_mib",
      },
    ],
  );
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].marker_counts.conversations.recovered, 5);
  assert.equal(report.runs[0].marker_counts.messages.recovered, 20);
  assert.equal(report.runs[0].conversation_order_preserved_for_recovered_markers, true);
  assert.equal(report.runs[0].message_order_preserved_for_recovered_markers, true);
  assert.equal(report.runs[0].call_mode, "single-call-v1");
  assert.equal(report.runs[0].outcomes.provider_observed_success, "yes");
  assert.equal(report.runs[0].bounded_multi_call_triggered, true);
  assert.equal(report.outcomes_without_evidence[0]?.session_id, noEvidenceSessionId);
  assert.ok(report.bounded_multi_call_trigger_session_ids.includes(noEvidenceSessionId));
  assert.deepEqual(report.runs[0].false_markers_returned, [manifest.negative_markers[0]]);
  assert.equal(
    report.runs[0].exact_file_bytes.find((file) => file.name === exactFile.name)?.matched,
    true,
  );
});

test("advertises one maximally permissive neutral tool and captures its exact argument object", async () => {
  assert.deepEqual(ACQUISITION_INPUT_JSON_SCHEMA, { type: "object", additionalProperties: true });
  assert.equal(
    ACQUISITION_TOOL_DESCRIPTION,
    "Submit diagnostic acquisition evidence for this test.",
  );
  const arbitrary = { nested: { any_key: [1, "two", { three: true }] }, extra: null };
  assert.deepEqual(
    capturePreValidationToolArguments({
      jsonrpc: "2.0",
      id: "one",
      method: "tools/call",
      params: { name: ACQUISITION_TOOL_NAME, arguments: arbitrary },
    }),
    { toolName: ACQUISITION_TOOL_NAME, exactJson: JSON.stringify(arbitrary), parsed: arbitrary },
  );

  const root = await mkdtemp(path.join(tmpdir(), "alice-acquisition-http-"));
  const store = new FileDiagnosticStore(root);
  const { session } = await store.createSession(runMetadata());
  const app = createAcquisitionProbeApp({ store });
  assert.equal(typeof app, "function");
  const stored = await store.capture(session, JSON.stringify(arbitrary), arbitrary);
  assert.equal(stored.received_arguments.exact_json, JSON.stringify(arbitrary));
  assert.deepEqual(stored.parsed_arguments, arbitrary);
});

test("the probe has no Alice-state dependency and is absent from the production image inputs", async () => {
  const sourceRoot = path.resolve("diagnostics/acquisition-probe/src");
  const runtimeSources = ["app.ts", "lambda.ts", "s3-storage.ts", "server.ts", "storage.ts"];
  for (const source of runtimeSources) {
    const text = await readFile(path.join(sourceRoot, source), "utf8");
    assert.doesNotMatch(text, /@alice\//);
    assert.doesNotMatch(
      text,
      /openDatabase|ALICE_DATABASE_URL|migration_sessions|accepted_project_state/,
    );
  }
  const dockerfile = await readFile(path.resolve("Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /COPY\s+diagnostics/);
  const dockerignore = await readFile(path.resolve(".dockerignore"), "utf8");
  assert.match(dockerignore, /^diagnostics$/m);
});
