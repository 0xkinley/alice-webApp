import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createProject } from "@alice/domain";
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

function snapshot({ content, idempotencyKey, title = "Stablecoin agent payments" }) {
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
  const preparedRevision = await callMcp(mcpBaseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      artifact_id: artifactId,
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
