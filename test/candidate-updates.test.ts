import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
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

before(async () => {
  created = createApp({
    databaseFilename: ":memory:",
    publicUrl: "http://127.0.0.1",
  });
  createTestIdentity(created.database);
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
});

test("explicit save creates pending candidates without changing trusted state", async () => {
  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: update,
  });
  assert.equal(response.status, 200);
  const result = payload.result.structuredContent;
  assert.equal(result.candidate_ids.length, 3);
  assert.equal(result.trusted_state_changed, false);
  assert.equal(result.deduplicated, false);
  assert.match(result.review_url, /\/review\?project_id=project_switchboard_launch$/);

  const candidates = created.database
    .prepare("SELECT status FROM candidate_claims WHERE evidence_id = ?")
    .all(result.evidence_id);
  assert.deepEqual(
    candidates.map(({ status }) => status),
    ["pending", "pending", "pending"],
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
    first.payload.result.structuredContent.candidate_ids,
    second.payload.result.structuredContent.candidate_ids,
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
