import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { setActiveConnectionTarget } from "@alice/domain";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
let fixtureTimestamp;
let identity;
let connectionId;
let server;

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  identity = await createTestIdentity(created.database);
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(baseUrl));

  const now = new Date().toISOString();
  fixtureTimestamp = now;
  const connection = created.database.prepare("SELECT id FROM integration_connections").get();
  connectionId = connection.id;
  created.database
    .prepare(
      `INSERT INTO evidence_events
        (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
         connection_workspace_id, client_id, client_classification, tool_name,
         idempotency_key, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "evidence_A",
      identity.workspace_id,
      "project_switchboard_launch",
      '{"fixture":"A"}',
      "host",
      connection.id,
      identity.workspace_id,
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
  const projectWide = created.database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'project_wide'`,
    )
    .get(identity.workspace_id, identity.project_id);
  created.database
    .prepare(
      `INSERT INTO accepted_context_entries
        (accepted_state_id, workspace_id, project_id, context_id, added_at)
       VALUES ('accepted_A', ?, ?, ?, ?)`,
    )
    .run(identity.workspace_id, identity.project_id, projectWide.id, now);
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
  created.database.close();
});

test("lists only projects in the authenticated workspace", async () => {
  await createTestIdentity(created.database, {
    email: "other@alice.example",
    password: "another correct horse battery staple",
    projectId: "project_other",
  });

  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.equal(response.status, 200);
  assert.equal(payload.result.structuredContent.contract_version, "2.0");
  assert.deepEqual(
    payload.result.structuredContent.projects.map((project) => project.id),
    ["project_switchboard_launch"],
  );
  assert.equal(payload.result.structuredContent.projects[0].accepted_state_count, 1);
  assert.equal(
    payload.result.structuredContent.projects[0].accepted_state_updated_at,
    fixtureTimestamp,
  );
  assert.deepEqual(
    payload.result.structuredContent.projects[0].contexts.map(({ name }) => name),
    ["General"],
  );
  assert.equal(payload.result.structuredContent.active_target, null);
});

test("uses the per-connection active project and work context without target arguments", async () => {
  const beforeSelection = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_active_context",
    arguments: { task: "Continue launch planning" },
  });
  assert.equal(beforeSelection.payload.result.isError, true);
  assert.match(beforeSelection.payload.result.content[0].text, /no active/i);

  const general = created.database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'work'`,
    )
    .get(identity.workspace_id, identity.project_id);
  const selected = await setActiveConnectionTarget(created.database, {
    userId: identity.id,
    connectionId,
    projectId: identity.project_id,
    contextId: general.id,
    expectedVersions: { [connectionId]: null },
  });
  assert.equal(selected.conflict, false);

  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_active_context",
    arguments: { task: "Continue launch planning" },
  });
  const context = payload.result.structuredContent;
  assert.equal(context.project.id, identity.project_id);
  assert.equal(context.context.id, general.id);
  assert.equal(context.context.name, "General");
  assert.equal(context.context.includes_project_wide, true);
  assert.equal(context.accepted_decisions[0].state_key, "launch.icp");

  const listing = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.equal(listing.payload.result.structuredContent.active_target.context_id, general.id);
});

test("advertises least-privilege OAuth scopes in ChatGPT-compatible tool metadata", async () => {
  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/list");
  assert.equal(response.status, 200);

  const toolsByName = Object.fromEntries(payload.result.tools.map((tool) => [tool.name, tool]));
  for (const name of ["list_projects", "get_active_context", "get_project_context"]) {
    assert.deepEqual(toolsByName[name]._meta.securitySchemes, [
      { type: "oauth2", scopes: ["mcp:read"] },
    ]);
  }
  assert.equal(toolsByName.list_projects.inputSchema.additionalProperties, false);
  assert.equal(toolsByName.list_projects.outputSchema.additionalProperties, false);
  assert.equal(toolsByName.get_project_context.inputSchema.additionalProperties, false);
  assert.equal(
    toolsByName.get_project_context.inputSchema.properties.context_budget.minimum,
    2_000,
  );
  assert.equal(
    toolsByName.get_project_context.inputSchema.properties.context_budget.maximum,
    32_000,
  );
  assert.equal(toolsByName.get_project_context.outputSchema.additionalProperties, false);
  assert.match(toolsByName.get_project_context.description, /deterministic/);
  assert.match(toolsByName.get_project_context.description, /cannot mutate project/i);
  assert.equal(toolsByName.get_active_context.inputSchema.properties.project_id, undefined);
  assert.equal(toolsByName.get_active_context.inputSchema.properties.context_id, undefined);
  assert.match(toolsByName.get_active_context.description, /exact AI connection/i);
  assert.deepEqual(toolsByName.save_project_update._meta.securitySchemes, [
    { type: "oauth2", scopes: ["mcp:write"] },
  ]);
  assert.match(toolsByName.save_project_update.description, /explicitly asks to save or record/);
  assert.match(
    toolsByName.save_project_update.description,
    /Do not call for ordinary project work/,
  );
  assert.match(
    toolsByName.save_project_update.description,
    /Never accepts, rejects, supersedes, or otherwise changes trusted project state/,
  );
  assert.equal(toolsByName.save_project_update.inputSchema.additionalProperties, false);
  assert.equal(
    toolsByName.save_project_update.inputSchema.properties.candidate_claims.maxItems,
    20,
  );
  assert.equal(
    toolsByName.save_project_update.inputSchema.properties.source_context.maxLength,
    12_000,
  );
  assert.equal(
    toolsByName.save_project_update.inputSchema.properties.idempotency_key.maxLength,
    128,
  );
});

test("returns accepted context with provenance and excludes pending candidates", async () => {
  const before = created.database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence,
        (SELECT COUNT(*) FROM candidate_claims) AS candidates,
        (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
        (SELECT COUNT(*) FROM audit_events) AS audit`,
    )
    .get();
  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: {
      project_id: "project_switchboard_launch",
      task: "Prepare launch",
      context_budget: 2_000,
    },
  });
  assert.equal(response.status, 200);
  assert.ok(payload.result.structuredContent, JSON.stringify(payload.result));
  const context = payload.result.structuredContent;
  assert.equal(context.accepted_decisions.length, 1);
  assert.equal(context.accepted_decisions[0].state_key, "launch.icp");
  assert.deepEqual(context.accepted_decisions[0].provenance, {
    accepted_state_id: "accepted_A",
    candidate_id: "candidate_A",
    evidence_id: "evidence_A",
    evidence_payload_hash: "fixture-hash",
    evidence_captured_at: fixtureTimestamp,
  });
  assert.doesNotMatch(JSON.stringify(context), /must not leak/);
  assert.equal(context.contract_version, "2.0");
  assert.equal(context.package.selection_strategy, "deterministic_full_text_v2");
  assert.equal(context.context.includes_project_wide, true);
  assert.equal(context.package.budget.unit, "utf8_bytes");
  assert.equal(context.package.budget.limit, 2_000);
  assert.equal(Buffer.byteLength(JSON.stringify(context), "utf8"), context.package.budget.used);
  assert.ok(context.package.budget.used <= context.package.budget.limit);
  assert.equal(context.package.omissions.total, 0);
  assert.deepEqual(
    created.database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM evidence_events) AS evidence,
          (SELECT COUNT(*) FROM candidate_claims) AS candidates,
          (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
          (SELECT COUNT(*) FROM audit_events) AS audit`,
      )
      .get(),
    before,
  );
});

test("active-target saves need no destination and explicit mismatches fail closed", async () => {
  const saved = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      summary: "Remember the launch channel",
      candidate_claims: [
        {
          state_key: "launch.channel",
          value: "Founder communities",
          summary: "Initial launch channel",
        },
      ],
      idempotency_key: "active-target-save-1",
    },
  });
  assert.equal(saved.payload.result.isError, undefined);
  const candidateId = saved.payload.result.structuredContent.candidate_ids[0];
  const target = created.database
    .prepare("SELECT context_id FROM candidate_context_targets WHERE candidate_id = ?")
    .get(candidateId);
  const active = created.database
    .prepare("SELECT context_id FROM active_connection_targets WHERE connection_id = ?")
    .get(connectionId);
  assert.equal(target.context_id, active.context_id);

  const mismatched = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: "project_other",
      summary: "Attempt a mismatched destination",
      candidate_claims: [{ state_key: "launch.channel", value: "Wrong", summary: "Wrong target" }],
      idempotency_key: "active-target-save-2",
    },
  });
  assert.equal(mismatched.payload.result.isError, true);
  assert.match(mismatched.payload.result.content[0].text, /does not match/i);
});

test("fails closed for a project outside the authenticated workspace", async () => {
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: { project_id: "project_other", task: "Steal context" },
  });
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /not found/i);
});
