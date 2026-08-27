import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
let server;

before(async () => {
  created = createApp({
    databaseFilename: ":memory:",
    publicUrl: "http://127.0.0.1",
  });
  const identity = createTestIdentity(created.database);
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(baseUrl));

  const now = new Date().toISOString();
  const connection = created.database.prepare("SELECT id FROM integration_connections").get();
  created.database
    .prepare(
      `INSERT INTO evidence_events
        (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
         client_id, client_classification, tool_name, idempotency_key, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "evidence_A",
      identity.workspace_id,
      "project_switchboard_launch",
      '{"fixture":"A"}',
      "host",
      connection.id,
      "test-client",
      "test",
      "test_fixture",
      "fixture-A",
      "fixture-hash",
      now,
    );
  created.database
    .prepare(
      `INSERT INTO candidate_claims
        (id, workspace_id, project_id, evidence_id, state_key, value_json, summary, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "candidate_A",
      identity.workspace_id,
      "project_switchboard_launch",
      "evidence_A",
      "launch.icp",
      JSON.stringify("Independent product consultants"),
      "Fixture A",
      "accepted",
      now,
    );
  created.database
    .prepare(
      `INSERT INTO accepted_project_state
        (id, workspace_id, project_id, candidate_id, evidence_id, state_key, value_json, version, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "accepted_A",
      identity.workspace_id,
      "project_switchboard_launch",
      "candidate_A",
      "evidence_A",
      "launch.icp",
      JSON.stringify("Independent product consultants"),
      1,
      now,
    );
  created.database
    .prepare(
      `INSERT INTO candidate_claims
        (id, workspace_id, project_id, evidence_id, state_key, value_json, summary, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "candidate_pending",
      identity.workspace_id,
      "project_switchboard_launch",
      "evidence_A",
      "launch.pending",
      JSON.stringify("must not leak"),
      "Pending fixture",
      "pending",
      now,
    );
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("lists only projects in the authenticated workspace", async () => {
  createTestIdentity(created.database, {
    email: "other@alice.example",
    password: "another correct horse battery staple",
    projectId: "project_other",
  });

  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.result.structuredContent.projects.map((project) => project.id),
    ["project_switchboard_launch"],
  );
});

test("advertises least-privilege OAuth scopes in ChatGPT-compatible tool metadata", async () => {
  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/list");
  assert.equal(response.status, 200);

  const toolsByName = Object.fromEntries(payload.result.tools.map((tool) => [tool.name, tool]));
  for (const name of ["list_projects", "get_project_context"]) {
    assert.deepEqual(toolsByName[name]._meta.securitySchemes, [
      { type: "oauth2", scopes: ["mcp:read"] },
    ]);
  }
  assert.deepEqual(toolsByName.save_project_update._meta.securitySchemes, [
    { type: "oauth2", scopes: ["mcp:write"] },
  ]);
});

test("returns accepted context with provenance and excludes pending candidates", async () => {
  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: {
      project_id: "project_switchboard_launch",
      task: "Prepare launch",
      context_budget: 2_000,
    },
  });
  assert.equal(response.status, 200);
  const context = payload.result.structuredContent;
  assert.equal(context.accepted_decisions.length, 1);
  assert.equal(context.accepted_decisions[0].state_key, "launch.icp");
  assert.deepEqual(context.accepted_decisions[0].provenance, {
    candidate_id: "candidate_A",
    evidence_id: "evidence_A",
  });
  assert.doesNotMatch(JSON.stringify(context), /must not leak/);
  assert.equal(context.package.omission_count, 0);
});

test("fails closed for a project outside the authenticated workspace", async () => {
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: { project_id: "project_other", task: "Steal context" },
  });
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /not found/i);
});
