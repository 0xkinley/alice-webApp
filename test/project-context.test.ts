import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createProject, createWorkContext, getProjectContext } from "@alice/domain";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity, getProjectDefaultContext } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
let fixtureTimestamp;
let identity;
let server;

async function insertAcceptedFixture({ contextId, stateKey, valueJson, version, suffix }) {
  const connection = created.database
    .prepare("SELECT * FROM integration_connections LIMIT 1")
    .get();
  const timestamp = new Date(Date.now() + version).toISOString();
  created.database
    .prepare(
      `INSERT INTO evidence_events
        (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
         connection_workspace_id, client_id, client_classification, tool_name,
         idempotency_key, payload_hash, created_at)
       VALUES (?, ?, ?, '{}', 'host', ?, ?, ?, ?, 'legacy_fixture', ?, ?, ?)`,
    )
    .run(
      `evidence_${suffix}`,
      identity.workspace_id,
      identity.project_id,
      connection.id,
      identity.workspace_id,
      connection.client_id,
      connection.client_classification,
      `legacy-${suffix}`,
      `hash-${suffix}`,
      timestamp,
    );
  created.database
    .prepare(
      `INSERT INTO candidate_claims
        (id, workspace_id, project_id, evidence_id, state_key, value_json, summary,
         status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
    )
    .run(
      `candidate_${suffix}`,
      identity.workspace_id,
      identity.project_id,
      `evidence_${suffix}`,
      stateKey,
      valueJson,
      `Legacy ${suffix}`,
      timestamp,
    );
  created.database
    .prepare(
      `INSERT INTO accepted_project_state
        (id, workspace_id, project_id, candidate_id, evidence_id, state_key,
         value_json, version, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `accepted_${suffix}`,
      identity.workspace_id,
      identity.project_id,
      `candidate_${suffix}`,
      `evidence_${suffix}`,
      stateKey,
      valueJson,
      version,
      timestamp,
    );
  created.database
    .prepare(
      `INSERT INTO accepted_context_entries
        (accepted_state_id, workspace_id, project_id, context_id, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`accepted_${suffix}`, identity.workspace_id, identity.project_id, contextId, timestamp);
}

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
  const projectWide = await getProjectDefaultContext(created.database, identity.project_id);
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
  assert.equal(payload.result.structuredContent.contract_version, "2.3");
  assert.deepEqual(
    payload.result.structuredContent.projects.map((project) => project.id),
    ["project_switchboard_launch"],
  );
  assert.equal(payload.result.structuredContent.projects[0].accepted_state_count, 1);
  assert.equal(payload.result.structuredContent.projects[0].brief, undefined);
  assert.equal(
    payload.result.structuredContent.projects[0].accepted_state_updated_at,
    fixtureTimestamp,
  );
  assert.equal(payload.result.structuredContent.projects[0].contexts, undefined);
  assert.equal(payload.result.structuredContent.active_target, undefined);
});

test("uses the only accessible project without a stored active target", async () => {
  const general = await getProjectDefaultContext(created.database, identity.project_id);
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_active_context",
    arguments: { task: "Continue launch planning" },
  });
  const context = payload.result.structuredContent;
  assert.equal(context.project.brief, undefined);
  assert.equal(context.project.id, identity.project_id);
  assert.equal(context.context, undefined);
  assert.equal(context.accepted_decisions[0].state_key, "launch.icp");
  const receipt = created.database
    .prepare(
      `SELECT status, failure_code, requested_via, project_id, context_id,
              package_version, package_utf8_bytes
       FROM context_read_events WHERE status = 'succeeded'`,
    )
    .get();
  assert.deepEqual(
    { ...receipt },
    {
      status: "succeeded",
      failure_code: null,
      requested_via: "active_target",
      project_id: identity.project_id,
      context_id: general.id,
      package_version: context.package.version,
      package_utf8_bytes: context.package.budget.used,
    },
  );
  assert.throws(
    () =>
      created.database
        .prepare("UPDATE context_read_events SET status = 'failed' WHERE id = ?")
        .run(
          created.database
            .prepare("SELECT id FROM context_read_events WHERE status = 'succeeded'")
            .get().id,
        ),
    /append-only|immutable/i,
  );
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
  assert.match(toolsByName.get_active_context.description, /exactly one accessible/i);
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
    /initial call creates no evidence, candidate, Needs attention item, or accepted state/,
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
  assert.equal(context.contract_version, "2.3");
  assert.equal(context.package.selection_strategy, "deterministic_full_text_v2");
  assert.equal(context.context, undefined);
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

test("records an inaccessible explicit read without retaining foreign target metadata", async () => {
  const foreign = await createTestIdentity(created.database, {
    email: "foreign-context-read@alice.example",
    password: "foreign context read private password",
    projectId: "project_foreign_context_read",
  });
  const before = created.database
    .prepare("SELECT COUNT(*) AS count FROM context_read_events")
    .get().count;
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: {
      project_id: foreign.project_id,
      task: "Attempt inaccessible read",
    },
  });
  assert.equal(payload.result.isError, true);
  const failed = created.database
    .prepare(
      `SELECT status, failure_code, requested_via, project_id, context_id
       FROM context_read_events
       WHERE failure_code = 'not_accessible' AND requested_via = 'explicit_fallback'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get();
  assert.deepEqual(
    { ...failed },
    {
      status: "failed",
      failure_code: "not_accessible",
      requested_via: "explicit_fallback",
      project_id: null,
      context_id: null,
    },
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM context_read_events").get().count,
    before + 1,
  );
});

test("saves require an exact accessible project and no active target", async () => {
  const saved = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: identity.project_id,
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
  const preview = saved.payload.result.structuredContent;
  assert.equal(preview.destination.project_id, identity.project_id);
  assert.equal(preview.destination.context_id, undefined);
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM candidate_claims WHERE state_key = 'launch.channel'")
      .get().count,
    0,
  );
  const committed = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: saved.payload.result._meta["alice/saveAuthority"].token,
    },
  });
  assert.equal(committed.payload.result.structuredContent.context_id, undefined);

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
  assert.match(mismatched.payload.result.content[0].text, /unavailable/i);
});

test("fails closed for a project outside the authenticated workspace", async () => {
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: { project_id: "project_other", task: "Steal context" },
  });
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /not found/i);
});

test("project-level reads merge equal legacy values and fail closed on disagreement", async () => {
  const legacyOne = await createWorkContext(created.database, {
    userId: identity.id,
    projectId: identity.project_id,
    input: { name: "Legacy one", description: "First retained legacy scope." },
  });
  const legacyTwo = await createWorkContext(created.database, {
    userId: identity.id,
    projectId: identity.project_id,
    input: { name: "Legacy two", description: "Second retained legacy scope." },
  });
  await insertAcceptedFixture({
    contextId: legacyOne.id,
    stateKey: "legacy.equal",
    valueJson: '{"alpha":1,"beta":2}',
    version: 1,
    suffix: "legacy_equal_one",
  });
  await insertAcceptedFixture({
    contextId: legacyTwo.id,
    stateKey: "legacy.equal",
    valueJson: '{"beta":2,"alpha":1}',
    version: 2,
    suffix: "legacy_equal_two",
  });
  await insertAcceptedFixture({
    contextId: legacyOne.id,
    stateKey: "legacy.conflict",
    valueJson: '"private alternative one"',
    version: 1,
    suffix: "legacy_conflict_one",
  });
  await insertAcceptedFixture({
    contextId: legacyTwo.id,
    stateKey: "legacy.conflict",
    valueJson: '"private alternative two"',
    version: 2,
    suffix: "legacy_conflict_two",
  });

  const unresolved = await getProjectContext(created.database, {
    userId: identity.id,
    projectId: identity.project_id,
    task: "Review legacy information",
    contextBudget: 16_000,
  });
  assert.deepEqual(
    unresolved.accepted_decisions
      .filter(({ state_key: key }) => key === "legacy.equal")
      .map(({ value }) => value),
    [{ beta: 2, alpha: 1 }],
  );
  assert.equal(
    unresolved.accepted_decisions.some(({ state_key: key }) => key === "legacy.conflict"),
    false,
  );
  assert.deepEqual(
    unresolved.unresolved_conflicts.find(({ state_key: key }) => key === "legacy.conflict"),
    {
      state_key: "legacy.conflict",
      status: "unresolved",
      saved_value_count: 2,
      notice:
        "Saved project information disagrees. Review it and save one project-level resolution before using this item.",
    },
  );
  assert.doesNotMatch(
    JSON.stringify(unresolved),
    /private alternative one|private alternative two|Legacy one|Legacy two/,
  );

  const projectDefault = await getProjectDefaultContext(created.database, identity.project_id);
  await insertAcceptedFixture({
    contextId: projectDefault.id,
    stateKey: "legacy.conflict",
    valueJson: '"human resolved value"',
    version: 3,
    suffix: "legacy_conflict_resolution",
  });
  const resolved = await getProjectContext(created.database, {
    userId: identity.id,
    projectId: identity.project_id,
    task: "Use the resolved legacy information",
    contextBudget: 16_000,
  });
  assert.equal(
    resolved.accepted_decisions.find(({ state_key: key }) => key === "legacy.conflict").value,
    "human resolved value",
  );
  assert.equal(
    resolved.unresolved_conflicts.some(({ state_key: key }) => key === "legacy.conflict"),
    false,
  );
});

test("asks for an exact project when more than one accessible project exists", async () => {
  const secondProject = await createProject(created.database, identity.id, {
    name: "Second accessible project",
  });
  assert.ok(secondProject);

  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_active_context",
    arguments: { task: "Continue the work" },
  });

  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /several alice\. projects/i);
  assert.match(payload.result.content[0].text, /project named|which project/i);
});
