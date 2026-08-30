import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp } from "../apps/mcp/src/app.ts";
import { saveCandidateUpdate } from "@alice/domain";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
let initialCaptureResult;
let server;

const update = {
  project_id: "project_switchboard_launch",
  summary: "Save canonical decisions A-C",
  candidate_claims: [
    { state_key: "launch.icp", value: "Independent product consultants", summary: "ICP" },
    {
      state_key: "launch.product_form",
      value: "Web control plane plus authenticated remote MCP server",
      summary: "Product form",
    },
    { state_key: "launch.monthly_price_usd", value: 24, summary: "Monthly price" },
  ],
  source_note: "Explicitly supplied by the tester",
  idempotency_key: "chatgpt-leg-1-A-C",
};

function captureCounts() {
  return created.database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence,
        (SELECT COUNT(*) FROM candidate_claims) AS candidates,
        (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
        (SELECT COUNT(*) FROM audit_events) AS audit`,
    )
    .get();
}

function authenticatedCaptureSubject() {
  return created.database
    .prepare(
      `SELECT client_id, user_id, connection_id
       FROM oauth_access_tokens WHERE token_hash = ?`,
    )
    .get(createHash("sha256").update(accessToken).digest("hex"));
}

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  await createTestIdentity(created.database);
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(baseUrl));
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("explicit save creates pending candidates without changing trusted state", async () => {
  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: update,
  });
  assert.equal(response.status, 200);
  const result = payload.result.structuredContent;
  initialCaptureResult = result;
  assert.equal(result.candidate_ids.length, 3);
  assert.deepEqual(
    result.candidate_statuses.map(({ status }) => status),
    ["pending", "pending", "pending"],
  );
  assert.match(result.audit_event_id, /^audit_/);
  assert.match(result.correlation_id, /^capture_/);
  assert.equal(result.trusted_state_changed, false);
  assert.equal(result.deduplicated, false);
  assert.match(
    result.review_url,
    /\/review\?project_id=project_switchboard_launch&context_id=context_/,
  );
  assert.match(result.context_id, /^context_/);
  assert.deepEqual(result.provenance, {
    actor_type: "mcp_host",
    connection_id: authenticatedCaptureSubject().connection_id,
    client_id: authenticatedCaptureSubject().client_id,
    client_classification: "unknown_mcp_client",
    tool_name: "save_project_update",
    payload_hash: result.provenance.payload_hash,
    captured_at: result.provenance.captured_at,
  });
  assert.match(result.provenance.payload_hash, /^[a-f0-9]{64}$/);
  assert.match(result.provenance.captured_at, /^\d{4}-\d{2}-\d{2}T/);

  const candidates = created.database
    .prepare("SELECT status FROM candidate_claims WHERE evidence_id = ?")
    .all(result.evidence_id);
  assert.deepEqual(
    candidates.map(({ status }) => status),
    ["pending", "pending", "pending"],
  );
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM candidate_context_targets WHERE context_id = ?")
      .get(result.context_id).count,
    3,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    0,
  );

  const evidence = created.database
    .prepare("SELECT exact_payload_json, payload_hash FROM evidence_events WHERE id = ?")
    .get(result.evidence_id);
  assert.equal(evidence.exact_payload_json, JSON.stringify(update));
  assert.equal(
    evidence.payload_hash,
    createHash("sha256").update(evidence.exact_payload_json).digest("hex"),
  );
  const orderedStateKeys = result.candidate_ids.map(
    (candidateId) =>
      created.database
        .prepare("SELECT state_key FROM candidate_claims WHERE id = ?")
        .get(candidateId).state_key,
  );
  assert.deepEqual(
    orderedStateKeys,
    update.candidate_claims.map(({ state_key }) => state_key),
  );

  const audit = created.database
    .prepare("SELECT * FROM audit_events WHERE id = ?")
    .get(result.audit_event_id);
  assert.equal(audit.correlation_id, result.correlation_id);
  assert.deepEqual(JSON.parse(audit.safe_metadata_json), {
    evidence_id: result.evidence_id,
    candidate_ids: result.candidate_ids,
    candidate_count: 3,
    context_id: result.context_id,
    connection_id: result.provenance.connection_id,
    payload_hash: result.provenance.payload_hash,
  });
  assert.doesNotMatch(audit.safe_metadata_json, /Explicitly supplied by the tester/);
});

test("an idempotent retry returns the original evidence and candidates", async () => {
  const first = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: update,
  });
  const second = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: update,
  });
  assert.equal(
    first.payload.result.structuredContent.evidence_id,
    second.payload.result.structuredContent.evidence_id,
  );
  assert.deepEqual(
    initialCaptureResult.candidate_ids,
    first.payload.result.structuredContent.candidate_ids,
  );
  assert.deepEqual(
    initialCaptureResult.candidate_ids,
    second.payload.result.structuredContent.candidate_ids,
  );
  assert.equal(
    first.payload.result.structuredContent.audit_event_id,
    initialCaptureResult.audit_event_id,
  );
  assert.equal(
    first.payload.result.structuredContent.correlation_id,
    initialCaptureResult.correlation_id,
  );
  assert.equal(second.payload.result.structuredContent.deduplicated, true);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM candidate_claims").get().count,
    3,
  );
  assert.equal(
    created.database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'candidate_update_submitted'",
      )
      .get().count,
    1,
  );
});

test("idempotency-key reuse with different evidence is rejected", async () => {
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: { ...update, summary: "Different submitted evidence" },
  });
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /different payload/i);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
});

test("candidate insertion failure rolls back evidence and audit creation", async () => {
  const beforeFailure = captureCounts();
  created.database.exec(`
    CREATE TRIGGER force_candidate_capture_failure
    BEFORE INSERT ON candidate_claims
    BEGIN
      SELECT RAISE(ABORT, 'forced candidate failure');
    END;
  `);
  try {
    const subject = authenticatedCaptureSubject();
    await assert.rejects(
      () =>
        saveCandidateUpdate(created.database, {
          clientId: subject.client_id,
          connectionId: subject.connection_id,
          publicUrl: "http://127.0.0.1",
          userId: subject.user_id,
          payload: { ...update, idempotency_key: "forced-candidate-failure" },
        }),
      /forced candidate failure/,
    );
  } finally {
    created.database.exec("DROP TRIGGER force_candidate_capture_failure");
  }
  assert.deepEqual(captureCounts(), beforeFailure);
});

test("audit insertion failure rolls back evidence and every candidate", async () => {
  const beforeFailure = captureCounts();
  created.database.exec(`
    CREATE TRIGGER force_capture_audit_failure
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'candidate_update_submitted'
    BEGIN
      SELECT RAISE(ABORT, 'forced capture audit failure');
    END;
  `);
  try {
    const subject = authenticatedCaptureSubject();
    await assert.rejects(
      () =>
        saveCandidateUpdate(created.database, {
          clientId: subject.client_id,
          connectionId: subject.connection_id,
          publicUrl: "http://127.0.0.1",
          userId: subject.user_id,
          payload: { ...update, idempotency_key: "forced-audit-failure" },
        }),
      /forced capture audit failure/,
    );
  } finally {
    created.database.exec("DROP TRIGGER force_capture_audit_failure");
  }
  assert.deepEqual(captureCounts(), beforeFailure);
});

test("database guards prevent evidence update and deletion", () => {
  assert.throws(
    () => created.database.prepare("UPDATE evidence_events SET exact_payload_json = '{}' ").run(),
    /evidence events are immutable/,
  );
  assert.throws(
    () => created.database.prepare("DELETE FROM evidence_events").run(),
    /evidence events are immutable/,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
  assert.throws(
    () => created.database.prepare("UPDATE audit_events SET action = 'rewritten'").run(),
    /audit events are append-only/,
  );
  assert.throws(
    () => created.database.prepare("DELETE FROM audit_events").run(),
    /audit events are append-only/,
  );
});

test("a read-only token cannot call the write tool", async () => {
  created.database
    .prepare("UPDATE oauth_access_tokens SET scope = 'mcp:read' WHERE token_hash = ?")
    .run(createHash("sha256").update(accessToken).digest("hex"));
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: { ...update, idempotency_key: "read-only-attempt" },
  });
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /does not grant mcp:write/);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
});
