import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  ARTIFACT_READ_RECEIPT_LIFETIME_MS,
  changeArtifactLifecycle,
  createArtifactSavePreview,
  createProject,
  normalizeArtifactSearchText,
  resolveArtifactDecisionConflict,
} from "@alice/domain";
import { createApp as createMcpApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let chatGptToken;
let claudeToken;
let cookie;
let database;
let identity;
let mcpBaseUrl;
let mcpServer;
let webBaseUrl;
let webServer;

function snapshot({
  content,
  idempotencyKey,
  title = "Stablecoin agent payments",
  decisionRecords = [],
}) {
  return {
    project_id: identity.project_id,
    title,
    artifact_type: "article",
    category: "content",
    tags: ["content", "research", "audience"],
    content,
    handoff: {
      goal: "Explain why AI agents may use stablecoins for payments.",
      summary: "An accessible article for fintech professionals.",
      decisions: ["Audience is fintech professionals", "Focus on payments, not speculation"],
      decision_records: decisionRecords,
      constraints: ["No em dashes", "Avoid deep protocol detail"],
      rejected_directions: [
        {
          direction: "Add a long section on consensus protocols",
          reason: "It distracts from the core argument",
        },
      ],
      open_questions: ["Which real-world example is strongest?"],
      next_steps: ["Strengthen the conclusion"],
      relevant_context: ["The reader understands digital payments"],
    },
    idempotency_key: idempotencyKey,
  };
}

async function commit(token, prepared) {
  const preview = prepared.payload.result.structuredContent;
  const authority = prepared.payload.result._meta["alice/saveAuthority"];
  return await callMcp(mcpBaseUrl, token, "tools/call", {
    name: "alice_commit_artifact_save",
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: authority.token,
    },
  });
}

async function saveNewArtifact(token, payload) {
  const prepared = await callMcp(mcpBaseUrl, token, "tools/call", {
    name: "save_to_alice",
    arguments: { save_type: "artifact", ...payload },
  });
  assert.equal(prepared.payload.error, undefined);
  assert.equal(prepared.payload.result.isError, undefined);
  return await commit(token, prepared);
}

before(async () => {
  database = openSqliteTestDatabase();
  identity = await createTestIdentity(database, {
    email: "artifact-handoff@alice.example",
    password: "artifact handoff private password",
    projectId: "project_artifact_handoff",
  });
  const mcp = await createMcpApp({ database, publicUrl: "http://127.0.0.1" });
  mcpServer = mcp.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => mcpServer.once("listening", resolve));
  mcpBaseUrl = `http://127.0.0.1:${mcpServer.address().port}`;
  ({
    tokens: { access_token: chatGptToken },
  } = await authorize(mcpBaseUrl, {
    email: identity.email,
    password: "artifact handoff private password",
    clientName: "ChatGPT artifact handoff test",
  }));
  ({
    tokens: { access_token: claudeToken },
  } = await authorize(mcpBaseUrl, {
    email: identity.email,
    password: "artifact handoff private password",
    clientName: "Claude artifact handoff test",
  }));

  const web = await createWebApp({ database, publicUrl: "http://127.0.0.1" });
  webServer = web.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => webServer.once("listening", resolve));
  webBaseUrl = `http://127.0.0.1:${webServer.address().port}`;
  const login = await fetch(`${webBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: identity.email,
      password: "artifact handoff private password",
      next: "/",
    }),
    redirect: "manual",
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  await Promise.all(
    [mcpServer, webServer].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  database.close();
});

test("ChatGPT saves once and Claude retrieves, revises, and returns the current handoff state", async () => {
  const originalContent = "AI agents need a dependable way to pay for services across borders.";
  const prepared = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "artifact",
      ...snapshot({ content: originalContent, idempotencyKey: "artifact-v1-001" }),
    },
  });
  assert.equal(prepared.payload.result.structuredContent.status, "awaiting_save");
  assert.equal(prepared.payload.result.structuredContent.source_host, "chatgpt");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM artifact_versions").get().count, 0);

  const preview = prepared.payload.result.structuredContent;
  const previewPage = await fetch(
    `${webBaseUrl}/artifact-save-previews/${encodeURIComponent(preview.preview_id)}`,
    { headers: { cookie } },
  );
  assert.equal(previewPage.status, 200);
  const previewHtml = await previewPage.text();
  assert.match(previewHtml, /Artifact Save preview/);
  assert.match(previewHtml, /Full artifact/);
  assert.match(previewHtml, new RegExp(originalContent));
  assert.match(previewHtml, />Save</);

  const created = await commit(chatGptToken, prepared);
  assert.equal(created.payload.result.structuredContent.status, "saved");
  assert.equal(created.payload.result.structuredContent.version, 1);
  const artifactId = created.payload.result.structuredContent.artifact_id;
  assert.equal(
    created.payload.result.structuredContent.contract_version,
    "alice_save_confirmation_receipt_v1",
  );

  const restored = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "alice_get_save_status",
    arguments: { preview_id: preview.preview_id },
  });
  assert.equal(restored.payload.result.structuredContent.status, "saved");
  assert.equal(restored.payload.result.structuredContent.artifact_id, artifactId);
  assert.match(restored.payload.result.structuredContent.view_url, /\/artifacts\//);

  const search = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "stablecoin" },
  });
  assert.equal(search.payload.result.structuredContent.status, "ok");
  assert.equal(search.payload.result.structuredContent.results[0].artifact_id, artifactId);
  assert.equal(search.payload.result.structuredContent.results[0].content, undefined);

  const retrieved = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId },
  });
  const artifact = retrieved.payload.result.structuredContent.artifact;
  assert.equal(artifact.content, originalContent);
  assert.equal(artifact.current_version, 1);
  assert.equal(artifact.source, "chatgpt");
  assert.deepEqual(artifact.handoff.constraints, ["No em dashes", "Avoid deep protocol detail"]);
  assert.equal(artifact.history, undefined);
  assert.equal(artifact.content_sha256, undefined);

  const revisedContent = `${originalContent} Stablecoins can provide programmable settlement without a card account.`;
  const revised = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: artifact.retrieval_receipt.token,
      ...snapshot({ content: revisedContent, idempotencyKey: "artifact-v2-001" }),
    },
  });
  assert.equal(revised.payload.result.structuredContent.artifact.version, 2);
  assert.equal(revised.payload.result.structuredContent.source_host, "claude");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM artifact_versions").get().count, 1);
  const savedRevision = await commit(claudeToken, revised);
  assert.equal(savedRevision.payload.result.structuredContent.version, 2);

  const current = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId, include_history: true },
  });
  assert.equal(current.payload.result.structuredContent.artifact.content, revisedContent);
  assert.equal(current.payload.result.structuredContent.artifact.current_version, 2);
  assert.equal(current.payload.result.structuredContent.artifact.source, "claude");
  assert.deepEqual(
    current.payload.result.structuredContent.artifact.history.map(({ version, source }) => ({
      version,
      source,
    })),
    [
      { version: 2, source: "claude" },
      { version: 1, source: "chatgpt" },
    ],
  );

  const old = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId, version: 1 },
  });
  assert.equal(old.payload.result.structuredContent.artifact.content, originalContent);
  assert.equal(old.payload.result.structuredContent.artifact.selected_version, 1);
  assert.equal(old.payload.result.structuredContent.artifact.current_version, 2);

  const changes = await fetch(`${webBaseUrl}/projects/${identity.project_id}/changes`, {
    headers: { cookie },
  });
  const changeHtml = await changes.text();
  assert.match(changeHtml, /Artifact saved/);
  assert.match(changeHtml, /Version 2 saved/);
  assert.match(changeHtml, /From ChatGPT/);
  assert.match(changeHtml, /From Claude/);
  assert.doesNotMatch(changeHtml, new RegExp(revisedContent));
  assert.doesNotMatch(changeHtml, /content_sha256|tags_json|<pre/i);
});

test("Claude JSON-encoded nested artifact fields normalize before the same strict save validation", async () => {
  const original = snapshot({
    content: "A complete script preserved through Claude's nested-string compatibility path.",
    idempotencyKey: "claude-json-artifact-001",
    title: "Claude compatibility artifact",
  });
  const prepared = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      ...original,
      save_type: "artifact",
      tags: JSON.stringify(original.tags),
      handoff: JSON.stringify(original.handoff),
    },
  });
  assert.equal(prepared.payload.error, undefined);
  assert.equal(prepared.payload.result.structuredContent.status, "awaiting_save");
  assert.deepEqual(prepared.payload.result.structuredContent.artifact.tags, original.tags);
  assert.deepEqual(prepared.payload.result.structuredContent.artifact.handoff, original.handoff);
  assert.equal(prepared.payload.result.structuredContent.source_host, "claude");

  const created = await commit(claudeToken, prepared);
  assert.equal(created.payload.result.structuredContent.status, "saved");
  const artifactId = created.payload.result.structuredContent.artifact_id;

  const revision = snapshot({
    content: `${original.content} The revised version remains complete.`,
    idempotencyKey: "claude-json-artifact-002",
    title: original.title,
  });
  const current = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId },
  });
  const preparedRevision = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: current.payload.result.structuredContent.artifact.retrieval_receipt.token,
      ...revision,
      tags: JSON.stringify(revision.tags),
      handoff: JSON.stringify(revision.handoff),
    },
  });
  assert.equal(preparedRevision.payload.error, undefined);
  assert.equal(preparedRevision.payload.result.structuredContent.artifact.version, 2);
  assert.deepEqual(preparedRevision.payload.result.structuredContent.artifact.tags, revision.tags);
  assert.deepEqual(
    preparedRevision.payload.result.structuredContent.artifact.handoff,
    revision.handoff,
  );
  const savedRevision = await commit(claudeToken, preparedRevision);
  assert.equal(savedRevision.payload.result.structuredContent.status, "saved");
  assert.equal(savedRevision.payload.result.structuredContent.version, 2);

  const previewsBeforeInvalidCompatibilityInput = database
    .prepare("SELECT COUNT(*) AS count FROM artifact_save_previews")
    .get().count;

  const invalidTag = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      ...original,
      idempotency_key: "claude-json-invalid-tag",
      save_type: "artifact",
      tags: JSON.stringify(["host-invented-tag"]),
      handoff: JSON.stringify(original.handoff),
    },
  });
  assert.ok(invalidTag.payload.error || invalidTag.payload.result.isError);

  const malformedHandoff = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      ...original,
      idempotency_key: "claude-json-invalid-handoff",
      save_type: "artifact",
      tags: JSON.stringify(original.tags),
      handoff: JSON.stringify({ ...original.handoff, unapproved_field: "must fail closed" }),
    },
  });
  assert.ok(malformedHandoff.payload.error || malformedHandoff.payload.result.isError);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM artifact_save_previews").get().count,
    previewsBeforeInvalidCompatibilityInput,
  );
});

test("artifact tool schemas advertise the bounded nested-string compatibility path without downgrade", async () => {
  const listed = await callMcp(mcpBaseUrl, claudeToken, "tools/list");
  for (const name of ["save_to_alice", "save_artifact_version"]) {
    const tool = listed.payload.result.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.match(tool.description, /never (?:retry|fall back)/i);
    const inputSchema = JSON.stringify(tool.inputSchema);
    assert.match(inputSchema, /Compatibility form for hosts/);
    assert.match(inputSchema, /JSON-encoded artifact tag array/);
    assert.match(inputSchema, /JSON-encoded artifact handoff object/);
    assert.match(inputSchema, /"type":"array"/);
    assert.match(inputSchema, /"type":"object"/);
    assert.match(inputSchema, /"type":"string"/);
  }
});

test("canonical tags and exact project routing prevent host-invented taxonomy or broad retrieval", async () => {
  const invented = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "artifact",
      ...snapshot({ content: "Invalid tag attempt", idempotencyKey: "artifact-invalid-tag-001" }),
      tags: ["host-invented-tag"],
    },
  });
  assert.ok(invented.payload.error || invented.payload.result.isError);

  await createProject(database, identity.id, { name: "Second project" });
  const ambiguous = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { query: "stablecoin" },
  });
  assert.equal(ambiguous.payload.result.isError, true);
  assert.match(
    ambiguous.payload.result.content[0].text,
    /Available projects: Private project, Second project/,
  );
  assert.doesNotMatch(ambiguous.payload.result.content[0].text, /project_artifact_handoff/);
});

test("artifact search normalizes natural-language metadata and finds the exact Thursday incident", async () => {
  assert.equal(
    normalizeArtifactSearchText("  THURSDAY\u00a0AI—Problem: Café?!  "),
    "thursday ai problem cafe",
  );
  const saved = await saveNewArtifact(chatGptToken, {
    ...snapshot({
      content: "The complete Thursday script body must not participate in metadata search.",
      idempotencyKey: "thursday-search-regression-001",
      title: "Thursday AI Problem — Make AI Interview You First — Script V1",
    }),
    handoff: {
      ...snapshot({ content: "x", idempotencyKey: "unused" }).handoff,
      goal: "Avoid generic answers by making the AI interview the user before drafting.",
      summary: "A Thursday social script about better prompting.",
    },
  });
  const artifactId = saved.payload.result.structuredContent.artifact_id;

  for (const token of [chatGptToken, claudeToken]) {
    const found = await callMcp(mcpBaseUrl, token, "tools/call", {
      name: "search_alice",
      arguments: {
        project_id: identity.project_id,
        query: "Thursday generic answers interview you first",
      },
    });
    const output = found.payload.result.structuredContent;
    assert.equal(output.result_count, 1);
    assert.equal(output.returned_count, 1);
    assert.equal(output.applied_limit, 20);
    assert.equal(output.truncated, false);
    assert.equal(output.continuation, null);
    assert.equal(output.results[0].artifact_id, artifactId);
    assert.equal(output.results[0].match.quality, "all_tokens_across_metadata");
    assert.equal(output.results[0].content, undefined);
    assert.match(found.payload.result.content[0].text, /Thursday AI Problem/);
    assert.match(found.payload.result.content[0].text, /Alice version 1/);
  }
});

test("artifact search ranks deterministically, identifies partials, paginates, and does not search bodies", async () => {
  const fixtures = [
    ["Rank Signal", "ranking-exact-title-001", "A browse fixture."],
    ["Rank Signal extended phrase", "ranking-title-phrase-001", "A browse fixture."],
    ["Signal Rank notes", "ranking-all-title-001", "A browse fixture."],
    ["Distributed metadata", "ranking-distributed-001", "Rank and signal appear in the goal."],
    ["Only rank present", "ranking-partial-001", "A partial fixture."],
  ];
  for (const [title, idempotencyKey, goal] of fixtures) {
    const base = snapshot({ content: "Body-only-never-search-9f24.", idempotencyKey, title });
    await saveNewArtifact(chatGptToken, {
      ...base,
      content: "9f24bodysecret",
      handoff: { ...base.handoff, goal },
    });
  }

  const ranked = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "rank signal", limit: 3 },
  });
  const first = ranked.payload.result.structuredContent;
  assert.deepEqual(
    first.results.map((result) => result.match.quality),
    ["exact_title", "title_phrase", "all_tokens_in_title"],
  );
  assert.equal(first.result_count, 5);
  assert.equal(first.returned_count, 3);
  assert.equal(first.applied_limit, 3);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.continuation, { next_offset: 3 });

  const continued = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "rank signal", limit: 3, offset: 3 },
  });
  const second = continued.payload.result.structuredContent;
  assert.deepEqual(
    second.results.map((result) => result.match.quality),
    ["all_tokens_across_metadata", "partial_tokens"],
  );
  assert.equal(second.results[1].match.partial, true);
  assert.match(continued.payload.result.content[0].text, /partial match/);
  assert.equal(second.truncated, false);

  const bodyOnly = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "9f24bodysecret" },
  });
  assert.equal(bodyOnly.payload.result.structuredContent.result_count, 0);
  assert.match(bodyOnly.payload.result.content[0].text, /does not prove the artifact is absent/i);
  assert.match(
    bodyOnly.payload.result.content[0].text,
    /Do not overwrite or version a nearby artifact/i,
  );
  assert.match(bodyOnly.payload.result.content[0].text, /safe broader search/i);
});

test("artifact version previews require a fresh single-use receipt bound to the exact connection and identity", async () => {
  const base = snapshot({
    content: "Receipt-bound artifact version one.",
    idempotencyKey: "receipt-bound-v1-001",
    title: "Receipt-bound artifact",
  });
  const created = await saveNewArtifact(chatGptToken, base);
  const artifactId = created.payload.result.structuredContent.artifact_id;

  const missing = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      ...snapshot({
        content: "Missing receipt attempt.",
        idempotencyKey: "receipt-missing-001",
        title: base.title,
      }),
    },
  });
  assert.ok(missing.payload.error || missing.payload.result.isError);

  const read = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId },
  });
  const receipt = read.payload.result.structuredContent.artifact.retrieval_receipt;
  assert.match(receipt.token, /^alice_artifact_read_/);
  assert.match(read.payload.result.content[0].text, /Fresh version receipt/);

  const distractor = await saveNewArtifact(
    chatGptToken,
    snapshot({
      content: "A different artifact in the same project.",
      idempotencyKey: "receipt-wrong-artifact-fixture",
      title: "Receipt distractor",
    }),
  );
  const wrongArtifact = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: distractor.payload.result.structuredContent.artifact_id,
      retrieval_receipt: receipt.token,
      ...snapshot({
        content: "Wrong artifact attempt.",
        idempotencyKey: "receipt-wrong-artifact-001",
        title: "Receipt distractor",
      }),
    },
  });
  assert.equal(wrongArtifact.payload.result.isError, true);

  const secondProject = await createProject(database, identity.id, {
    name: "Receipt boundary project",
  });
  const secondProjectArtifact = await saveNewArtifact(chatGptToken, {
    ...snapshot({
      content: "An artifact in a different project.",
      idempotencyKey: "receipt-wrong-project-fixture",
      title: "Cross-project receipt fixture",
    }),
    project_id: secondProject.id,
  });
  const wrongProject = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: secondProjectArtifact.payload.result.structuredContent.artifact_id,
      retrieval_receipt: receipt.token,
      ...snapshot({
        content: "Wrong project attempt.",
        idempotencyKey: "receipt-wrong-project-001",
        title: "Cross-project receipt fixture",
      }),
      project_id: secondProject.id,
    },
  });
  assert.equal(wrongProject.payload.result.isError, true);
  assert.equal(
    wrongProject.payload.result.content[0].text,
    wrongArtifact.payload.result.content[0].text,
  );

  const foreignConnection = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: receipt.token,
      ...snapshot({
        content: "Wrong connection attempt.",
        idempotencyKey: "receipt-foreign-001",
        title: base.title,
      }),
    },
  });
  assert.equal(foreignConnection.payload.result.isError, true);
  assert.match(foreignConnection.payload.result.content[0].text, /fresh exact current artifact/i);

  const guessed = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: `alice_artifact_read_${"a".repeat(43)}`,
      ...snapshot({
        content: "Guessed receipt attempt.",
        idempotencyKey: "receipt-guessed-001",
        title: base.title,
      }),
    },
  });
  assert.equal(guessed.payload.result.isError, true);
  assert.equal(
    guessed.payload.result.content[0].text,
    foreignConnection.payload.result.content[0].text,
  );

  const prepared = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: receipt.token,
      ...snapshot({
        content: "Receipt-bound artifact version two.",
        idempotencyKey: "receipt-bound-v2-001",
        title: base.title,
      }),
    },
  });
  assert.equal(prepared.payload.result.structuredContent.artifact.identity.conflict, false);
  assert.equal(
    prepared.payload.result.structuredContent.artifact.identity.authoritative_current_alice_version,
    1,
  );
  assert.equal(
    prepared.payload.result.structuredContent.artifact.identity.proposed_next_alice_version,
    2,
  );

  const replay = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: receipt.token,
      ...snapshot({
        content: "Receipt replay attempt.",
        idempotencyKey: "receipt-replay-001",
        title: base.title,
      }),
    },
  });
  assert.equal(replay.payload.result.isError, true);
  await commit(claudeToken, prepared);

  const staleRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId },
  });
  const staleReceipt = staleRead.payload.result.structuredContent.artifact.retrieval_receipt.token;
  const winningRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId },
  });
  const winning = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt:
        winningRead.payload.result.structuredContent.artifact.retrieval_receipt.token,
      ...snapshot({
        content: "Receipt-bound artifact version three.",
        idempotencyKey: "receipt-bound-v3-001",
        title: base.title,
      }),
    },
  });
  await commit(claudeToken, winning);
  const stale = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: staleReceipt,
      ...snapshot({
        content: "Stale receipt attempt.",
        idempotencyKey: "receipt-stale-001",
        title: base.title,
      }),
    },
  });
  assert.equal(stale.payload.result.isError, true);

  const latestRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId },
  });
  const connection = database
    .prepare(
      `SELECT id, client_id FROM integration_connections
       WHERE user_id = ? AND client_classification = 'claude'`,
    )
    .get(identity.id);
  const expired = await createArtifactSavePreview(database, {
    userId: identity.id,
    connectionId: connection.id,
    clientId: connection.client_id,
    publicUrl: "http://127.0.0.1",
    payload: snapshot({
      content: "Expired receipt attempt.",
      idempotencyKey: "receipt-expired-001",
      title: base.title,
    }),
    artifactId,
    retrievalReceipt: latestRead.payload.result.structuredContent.artifact.retrieval_receipt.token,
    now: new Date(Date.now() + ARTIFACT_READ_RECEIPT_LIFETIME_MS + 1),
  });
  assert.deepEqual(expired, {
    error: "A fresh exact current artifact retrieval is required before versioning.",
  });
});

test("version-like title labels are neutralized and conflicts remain explicit across MCP and web surfaces", async () => {
  const conflictingCreate = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "artifact",
      ...snapshot({
        content: "Conflicting initial title label.",
        idempotencyKey: "title-conflicting-create-001",
        title: "Conflicting initial story V4",
      }),
    },
  });
  assert.equal(conflictingCreate.payload.result.structuredContent.can_save, false);
  assert.equal(
    conflictingCreate.payload.result.structuredContent.artifact.title_version_integrity.status,
    "conflicting_label",
  );
  assert.equal((await commit(chatGptToken, conflictingCreate)).payload.result.isError, true);

  const matching = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "artifact",
      ...snapshot({
        content: "Title integrity version one.",
        idempotencyKey: "title-integrity-v1-001",
        title: "Title integrity story V1",
      }),
    },
  });
  const matchingPreview = matching.payload.result.structuredContent;
  assert.equal(matchingPreview.artifact.title, "Title integrity story");
  assert.equal(matchingPreview.artifact.title_version_integrity.status, "matching_label");
  const saved = await commit(chatGptToken, matching);
  const artifactId = saved.payload.result.structuredContent.artifact_id;

  database.exec("DROP TRIGGER artifact_versions_no_update");
  database
    .prepare("UPDATE artifact_versions SET title = ? WHERE artifact_id = ? AND version = 1")
    .run("Title integrity story V1", artifactId);
  database.exec(`CREATE TRIGGER artifact_versions_no_update
    BEFORE UPDATE ON artifact_versions
    BEGIN SELECT RAISE(ABORT, 'artifact versions are immutable'); END`);

  const matchingSearch = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "title integrity story" },
  });
  assert.equal(
    matchingSearch.payload.result.structuredContent.results[0].title_version_integrity.status,
    "matching_label",
  );
  assert.equal(
    matchingSearch.payload.result.structuredContent.results[0].title,
    "Title integrity story",
  );
  const matchingRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId, include_history: true },
  });
  assert.equal(
    matchingRead.payload.result.structuredContent.artifact.title_version_integrity.status,
    "matching_label",
  );
  assert.equal(
    matchingRead.payload.result.structuredContent.artifact.history[0].title_version_integrity
      .status,
    "matching_label",
  );
  const matchingDetail = await fetch(
    `${webBaseUrl}/projects/${identity.project_id}/artifacts/${artifactId}`,
    { headers: { cookie } },
  );
  assert.match(await matchingDetail.text(), /included a matching V1 label/);

  database.exec("DROP TRIGGER artifact_versions_no_update");
  database
    .prepare("UPDATE artifact_versions SET title = ? WHERE artifact_id = ? AND version = 1")
    .run("Title integrity story V4", artifactId);
  database.exec(`CREATE TRIGGER artifact_versions_no_update
    BEFORE UPDATE ON artifact_versions
    BEGIN SELECT RAISE(ABORT, 'artifact versions are immutable'); END`);

  const search = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "title integrity story" },
  });
  const result = search.payload.result.structuredContent.results[0];
  assert.equal(result.title, "Title integrity story");
  assert.equal(result.current_version, 1);
  assert.equal(result.title_version_integrity.status, "conflicting_label");
  assert.match(search.payload.result.content[0].text, /Alice version 1/);
  assert.match(search.payload.result.content[0].text, /included V4/);

  const retrieved = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId, include_history: true },
  });
  const artifact = retrieved.payload.result.structuredContent.artifact;
  assert.equal(artifact.title, "Title integrity story");
  assert.equal(artifact.title_version_integrity.status, "conflicting_label");
  assert.equal(artifact.history[0].title, "Title integrity story");
  assert.equal(artifact.history[0].title_version_integrity.status, "conflicting_label");

  const detail = await fetch(
    `${webBaseUrl}/projects/${identity.project_id}/artifacts/${artifactId}`,
    { headers: { cookie } },
  );
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Alice version 1 of 1/);
  assert.match(detailHtml, /included V4, but Alice version 1 is authoritative/);
  const activity = await fetch(`${webBaseUrl}/projects/${identity.project_id}/changes`, {
    headers: { cookie },
  });
  const activityHtml = await activity.text();
  assert.match(activityHtml, /Title integrity story/);
  assert.doesNotMatch(activityHtml, /Title integrity story V4/);

  const wrongIdentity = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt: artifact.retrieval_receipt.token,
      ...snapshot({
        content: "Wrong identity content.",
        idempotencyKey: "title-wrong-identity-001",
        title: "Different Thursday artifact V2",
      }),
    },
  });
  const wrongPreview = wrongIdentity.payload.result.structuredContent;
  assert.equal(wrongPreview.can_save, false);
  assert.equal(wrongPreview.artifact.identity.existing_artifact, "Title integrity story");
  assert.equal(wrongPreview.artifact.identity.proposed_title, "Different Thursday artifact");
  assert.equal(wrongPreview.artifact.identity.conflict, true);
  const previewPage = await fetch(
    `${webBaseUrl}/artifact-save-previews/${encodeURIComponent(wrongPreview.preview_id)}`,
    { headers: { cookie } },
  );
  const previewHtml = await previewPage.text();
  assert.match(previewHtml, /Existing artifact/);
  assert.match(previewHtml, /Authoritative current Alice version/);
  assert.match(previewHtml, /Proposed next Alice version/);
  assert.match(previewHtml, /Identity\/title conflict/);
  assert.match(previewHtml, /Save blocked/);
  assert.doesNotMatch(previewHtml, /<button type="submit">Save<\/button>/);
  const blocked = await commit(claudeToken, wrongIdentity);
  assert.equal(blocked.payload.result.isError, true);

  const correctedRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId },
  });
  const corrected = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
      retrieval_receipt:
        correctedRead.payload.result.structuredContent.artifact.retrieval_receipt.token,
      ...snapshot({
        content: "Corrected title integrity version two.",
        idempotencyKey: "title-integrity-v2-001",
        title: "Title integrity story V2",
      }),
    },
  });
  assert.equal(corrected.payload.result.structuredContent.can_save, true);
  assert.equal(
    corrected.payload.result.structuredContent.artifact.replaces.title_version_integrity.status,
    "conflicting_label",
  );
  await commit(claudeToken, corrected);
  const current = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: artifactId, include_history: true },
  });
  assert.equal(current.payload.result.structuredContent.artifact.current_version, 2);
  assert.equal(current.payload.result.structuredContent.artifact.title, "Title integrity story");
  assert.equal(
    current.payload.result.structuredContent.artifact.title_version_integrity.status,
    "version_neutral",
  );
  assert.equal(
    current.payload.result.structuredContent.artifact.history[1].title_version_integrity.status,
    "conflicting_label",
  );
});

test("authenticated humans control append-only active, archived, restored, and superseded artifact lifecycle", async () => {
  const canonical = await saveNewArtifact(
    chatGptToken,
    snapshot({
      content: "Canonical Thursday lineage.",
      idempotencyKey: "lifecycle-canonical-001",
      title: "Thursday interview-first script",
    }),
  );
  const duplicate = await saveNewArtifact(
    claudeToken,
    snapshot({
      content: "Duplicate Thursday lineage.",
      idempotencyKey: "lifecycle-duplicate-001",
      title: "Thursday interview first script duplicate",
    }),
  );
  const canonicalId = canonical.payload.result.structuredContent.artifact_id;
  const duplicateId = duplicate.payload.result.structuredContent.artifact_id;
  const activeRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: duplicateId },
  });
  const preLifecycleReceipt =
    activeRead.payload.result.structuredContent.artifact.retrieval_receipt.token;

  const archive = await fetch(
    `${webBaseUrl}/projects/${identity.project_id}/artifacts/${duplicateId}/lifecycle`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "archive", expected_version: "0" }),
      redirect: "manual",
    },
  );
  assert.equal(archive.status, 303);

  const defaultSearch = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "Thursday interview first script" },
  });
  assert.ok(
    defaultSearch.payload.result.structuredContent.results.every(
      (item) => item.artifact_id !== duplicateId,
    ),
  );
  const archivedSearch = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: {
      project_id: identity.project_id,
      query: "Thursday interview first script",
      lifecycle: "archived",
    },
  });
  assert.equal(archivedSearch.payload.result.structuredContent.results[0].artifact_id, duplicateId);
  assert.equal(
    archivedSearch.payload.result.structuredContent.results[0].lifecycle.state,
    "archived",
  );
  const archivedRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: duplicateId },
  });
  assert.equal(archivedRead.payload.result.structuredContent.artifact.lifecycle.state, "archived");
  assert.equal(archivedRead.payload.result.structuredContent.artifact.retrieval_receipt, undefined);
  assert.match(archivedRead.payload.result.content[0].text, /Version writes are disabled/);
  const archivedVersion = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: duplicateId,
      retrieval_receipt: preLifecycleReceipt,
      ...snapshot({
        content: "Archived write attempt.",
        idempotencyKey: "lifecycle-archived-write-001",
        title: "Thursday interview first script duplicate",
      }),
    },
  });
  assert.equal(archivedVersion.payload.result.isError, true);
  assert.match(archivedVersion.payload.result.content[0].text, /cannot receive versions/i);

  const restore = await fetch(
    `${webBaseUrl}/projects/${identity.project_id}/artifacts/${duplicateId}/lifecycle`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "restore", expected_version: "1" }),
      redirect: "manual",
    },
  );
  assert.equal(restore.status, 303);
  const restoredRead = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: duplicateId },
  });
  const restoredReceipt =
    restoredRead.payload.result.structuredContent.artifact.retrieval_receipt.token;

  const supersede = await fetch(
    `${webBaseUrl}/projects/${identity.project_id}/artifacts/${duplicateId}/lifecycle`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "supersede",
        expected_version: "2",
        replacement_artifact_id: canonicalId,
      }),
      redirect: "manual",
    },
  );
  assert.equal(supersede.status, 303);
  const supersededRead = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: duplicateId },
  });
  const supersededArtifact = supersededRead.payload.result.structuredContent.artifact;
  assert.equal(supersededArtifact.lifecycle.state, "superseded");
  assert.equal(supersededArtifact.lifecycle.replacement.artifact_id, canonicalId);
  assert.equal(supersededArtifact.lifecycle.replacement.title, "Thursday interview-first script");
  assert.match(supersededRead.payload.result.content[0].text, /Canonical replacement/);
  assert.equal(supersededArtifact.retrieval_receipt, undefined);
  const supersededDetail = await fetch(
    `${webBaseUrl}/projects/${identity.project_id}/artifacts/${duplicateId}`,
    { headers: { cookie } },
  );
  const supersededHtml = await supersededDetail.text();
  assert.match(supersededHtml, /Superseded/);
  assert.match(supersededHtml, /Thursday interview-first script/);
  assert.match(supersededHtml, /Restore artifact/);

  const staleAfterLifecycle = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: duplicateId,
      retrieval_receipt: restoredReceipt,
      ...snapshot({
        content: "Superseded write attempt.",
        idempotencyKey: "lifecycle-superseded-write-001",
        title: "Thursday interview first script duplicate",
      }),
    },
  });
  assert.equal(staleAfterLifecycle.payload.result.isError, true);
  assert.match(staleAfterLifecycle.payload.result.content[0].text, /cannot receive versions/i);

  const staleHumanAction = await changeArtifactLifecycle(database, {
    userId: identity.id,
    projectId: identity.project_id,
    artifactId: duplicateId,
    action: "restore",
    expectedVersion: 2,
  }).catch((error) => error);
  assert.match(staleHumanAction.message, /lifecycle changed/i);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM artifact_lifecycle_events WHERE artifact_id = ?")
      .get(duplicateId).count,
    3,
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT lifecycle_state, version FROM artifact_lifecycle_events
         WHERE artifact_id = ? ORDER BY version`,
      )
      .all(duplicateId)
      .map((row) => ({ lifecycle_state: row.lifecycle_state, version: Number(row.version) })),
    [
      { lifecycle_state: "archived", version: 1 },
      { lifecycle_state: "active", version: 2 },
      { lifecycle_state: "superseded", version: 3 },
    ],
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE artifact_lifecycle_events SET lifecycle_state = 'active' WHERE artifact_id = ?",
        )
        .run(duplicateId),
    /immutable/,
  );

  const viewer = await createTestIdentity(database, {
    email: "artifact-lifecycle-viewer@alice.example",
    password: "artifact lifecycle viewer password",
    projectId: "project_artifact_lifecycle_viewer",
  });
  const membershipTime = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO project_memberships
        (id, workspace_id, project_id, user_id, role, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
    )
    .run(
      "membership_artifact_lifecycle_viewer",
      identity.workspace_id,
      identity.project_id,
      viewer.id,
      identity.id,
      membershipTime,
      membershipTime,
    );
  assert.equal(
    await changeArtifactLifecycle(database, {
      userId: viewer.id,
      projectId: identity.project_id,
      artifactId: canonicalId,
      action: "archive",
      expectedVersion: 0,
    }),
    undefined,
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM artifact_lifecycle_events WHERE artifact_id = ?")
      .get(canonicalId).count,
    0,
  );

  const tools = await callMcp(mcpBaseUrl, claudeToken, "tools/list");
  const names = tools.payload.result.tools.map((tool) => tool.name);
  assert.ok(
    !names.some((name) => /archive_artifact|supersede_artifact|restore_artifact/.test(name)),
  );
});

test("explicit structured decision keys expose exact conflicts for separate human resolution", async () => {
  const firstPrepared = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "artifact",
      ...snapshot({
        content: "Launch through the customer email list.",
        idempotencyKey: "decision-conflict-email-001",
        title: "Decision collision email plan",
        decisionRecords: [{ decision_key: "launch.channel", value: { channel: "email", wave: 1 } }],
      }),
    },
  });
  const firstPreview = firstPrepared.payload.result.structuredContent;
  const previewResponse = await fetch(
    `${webBaseUrl}/artifact-save-previews/${encodeURIComponent(firstPreview.preview_id)}`,
    { headers: { cookie } },
  );
  const previewHtml = await previewResponse.text();
  assert.match(previewHtml, /Structured decision records/);
  assert.match(previewHtml, /launch\.channel/);
  assert.match(previewHtml, /email/);
  const first = await commit(chatGptToken, firstPrepared);
  const firstId = first.payload.result.structuredContent.artifact_id;

  const second = await saveNewArtifact(
    claudeToken,
    snapshot({
      content: "Launch through the partner social accounts.",
      idempotencyKey: "decision-conflict-social-001",
      title: "Decision collision social plan",
      decisionRecords: [{ decision_key: "launch.channel", value: { wave: 1, channel: "social" } }],
    }),
  );
  const secondId = second.payload.result.structuredContent.artifact_id;

  const search = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "decision collision" },
  });
  const conflicts = search.payload.result.structuredContent.decision_conflicts;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].decision_key, "launch.channel");
  assert.equal(conflicts[0].status, "unresolved");
  assert.deepEqual(
    conflicts[0].records
      .map((record) => ({
        title: record.title,
        source: record.source,
        value: record.value,
      }))
      .sort((left, right) => left.title.localeCompare(right.title)),
    [
      {
        title: "Decision collision email plan",
        source: "chatgpt",
        value: { channel: "email", wave: 1 },
      },
      {
        title: "Decision collision social plan",
        source: "claude",
        value: { wave: 1, channel: "social" },
      },
    ],
  );
  assert.match(conflicts[0].limitation, /free-form semantic contradictions are not inferred/);
  assert.match(search.payload.result.content[0].text, /exact value \{"channel":"email","wave":1\}/);
  assert.match(search.payload.result.content[0].text, /does not choose which value is correct/);

  const read = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: firstId },
  });
  assert.equal(read.payload.result.structuredContent.artifact.decision_conflicts.length, 1);
  assert.deepEqual(read.payload.result.structuredContent.artifact.handoff.decision_records, [
    { decision_key: "launch.channel", value: { channel: "email", wave: 1 } },
  ]);
  assert.match(read.payload.result.content[0].text, /Structured decision records/);

  const listPage = await fetch(`${webBaseUrl}/projects/${identity.project_id}/artifacts`, {
    headers: { cookie },
  });
  const listHtml = await listPage.text();
  assert.match(listHtml, /Decision conflicts/);
  assert.match(listHtml, /Record human selection/);
  assert.match(listHtml, /not Alice verification/);

  const fingerprint = conflicts[0].conflict_fingerprint;
  const selected = conflicts[0].records.find((record) => record.artifact_id === firstId);
  const resolved = await fetch(
    `${webBaseUrl}/projects/${identity.project_id}/artifact-decision-conflicts/${fingerprint}/resolve`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ selected_version_id: selected.version_id }),
      redirect: "manual",
    },
  );
  assert.equal(resolved.status, 303);

  const resolvedSearch = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "decision collision" },
  });
  const resolvedConflict = resolvedSearch.payload.result.structuredContent.decision_conflicts[0];
  assert.equal(resolvedConflict.status, "human_resolved");
  assert.deepEqual(resolvedConflict.resolution.selected_value, { channel: "email", wave: 1 });
  assert.match(resolvedConflict.resolution.notice, /does not verify which value is correct/);
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE artifact_decision_resolutions SET decision_key = 'changed' WHERE conflict_fingerprint = ?",
        )
        .run(fingerprint),
    /immutable/,
  );

  const viewer = await createTestIdentity(database, {
    email: "artifact-decision-viewer@alice.example",
    password: "artifact decision viewer password",
    projectId: "project_artifact_decision_viewer",
  });
  const membershipTime = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO project_memberships
        (id, workspace_id, project_id, user_id, role, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
    )
    .run(
      "membership_artifact_decision_viewer",
      identity.workspace_id,
      identity.project_id,
      viewer.id,
      identity.id,
      membershipTime,
      membershipTime,
    );
  assert.equal(
    await resolveArtifactDecisionConflict(database, {
      userId: viewer.id,
      projectId: identity.project_id,
      conflictFingerprint: fingerprint,
      selectedVersionId: selected.version_id,
    }),
    undefined,
  );

  const latestRead = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: identity.project_id, artifact_id: secondId },
  });
  const revised = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: secondId,
      retrieval_receipt:
        latestRead.payload.result.structuredContent.artifact.retrieval_receipt.token,
      ...snapshot({
        content: "Launch through a partner webinar.",
        idempotencyKey: "decision-conflict-webinar-002",
        title: "Decision collision social plan",
        decisionRecords: [
          { decision_key: "launch.channel", value: { channel: "webinar", wave: 1 } },
        ],
      }),
    },
  });
  await commit(chatGptToken, revised);
  const changedSearch = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "decision collision" },
  });
  assert.equal(
    changedSearch.payload.result.structuredContent.decision_conflicts[0].status,
    "unresolved",
  );
  assert.notEqual(
    changedSearch.payload.result.structuredContent.decision_conflicts[0].conflict_fingerprint,
    fingerprint,
  );
  const stale = await resolveArtifactDecisionConflict(database, {
    userId: identity.id,
    projectId: identity.project_id,
    conflictFingerprint: fingerprint,
    selectedVersionId: selected.version_id,
  }).catch((error) => error);
  assert.match(stale.message, /conflict changed/i);

  await saveNewArtifact(
    claudeToken,
    snapshot({
      content: "A corroborating email launch record.",
      idempotencyKey: "decision-conflict-email-same-001",
      title: "Decision collision corroborating plan",
      decisionRecords: [{ decision_key: "launch.channel", value: { wave: 1, channel: "email" } }],
    }),
  );
  await changeArtifactLifecycle(database, {
    userId: identity.id,
    projectId: identity.project_id,
    artifactId: secondId,
    action: "archive",
    expectedVersion: 0,
  });
  const equalValuesOnly = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "decision collision" },
  });
  assert.equal(equalValuesOnly.payload.result.structuredContent.decision_conflicts.length, 0);
  await changeArtifactLifecycle(database, {
    userId: identity.id,
    projectId: identity.project_id,
    artifactId: secondId,
    action: "restore",
    expectedVersion: 1,
  });
  const restoredConflict = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "decision collision" },
  });
  assert.equal(restoredConflict.payload.result.structuredContent.decision_conflicts.length, 1);

  const semanticOnly = await saveNewArtifact(
    chatGptToken,
    snapshot({
      content: "Free-form prose says the launch channel is events.",
      idempotencyKey: "decision-conflict-semantic-only-001",
      title: "Decision prose only",
    }),
  );
  assert.ok(semanticOnly.payload.result.structuredContent.artifact_id);
  const afterSemantic = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: identity.project_id, query: "decision collision" },
  });
  assert.equal(afterSemantic.payload.result.structuredContent.decision_conflicts.length, 1);

  const invalid = await callMcp(mcpBaseUrl, chatGptToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "artifact",
      ...snapshot({
        content: "Invalid structured key.",
        idempotencyKey: "decision-conflict-invalid-001",
        title: "Invalid decision record",
        decisionRecords: [
          { decision_key: "Launch Channel!", value: "email" },
          { decision_key: "Launch Channel!", value: "social" },
        ],
      }),
    },
  });
  assert.equal(invalid.payload.result.isError, true);

  const tools = await callMcp(mcpBaseUrl, claudeToken, "tools/list");
  const names = tools.payload.result.tools.map((tool) => tool.name);
  assert.ok(!names.some((name) => /resolve.*decision|decision.*resolve/.test(name)));
});
