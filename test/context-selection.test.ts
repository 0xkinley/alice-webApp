import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "@alice/database";
import { ContextBudgetError, getProjectContext } from "@alice/domain";
import { createTestIdentity } from "./helpers.ts";

function createContextFixture() {
  const database = openDatabase(":memory:");
  const identity = createTestIdentity(database);
  const timestamp = "2026-08-30T08:00:00.000Z";
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('fixture-client', 'Fixture client', '[]', 'none', ?)`,
    )
    .run(timestamp);
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('fixture-connection', ?, ?, 'fixture-client', 'test', 'mcp:read', ?, ?)`,
    )
    .run(identity.id, identity.workspace_id, timestamp, timestamp);

  function addClaim({ id, stateKey, value, status = "accepted", version = undefined }) {
    const evidenceId = `evidence_${id}`;
    const candidateId = `candidate_${id}`;
    database
      .prepare(
        `INSERT INTO evidence_events
          (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
           client_id, client_classification, tool_name, idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, '{}', 'mcp_host', 'fixture-connection', 'fixture-client', 'test',
                 'save_project_update', ?, ?, ?)`,
      )
      .run(
        evidenceId,
        identity.workspace_id,
        identity.project_id,
        `fixture-${id}`,
        `hash-${id}`,
        timestamp,
      );
    database
      .prepare(
        `INSERT INTO candidate_claims
          (id, workspace_id, project_id, evidence_id, state_key, value_json, summary,
           status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidateId,
        identity.workspace_id,
        identity.project_id,
        evidenceId,
        stateKey,
        JSON.stringify(value),
        `${stateKey} fixture`,
        status,
        timestamp,
      );
    if (version) {
      database
        .prepare(
          `INSERT INTO accepted_project_state
            (id, workspace_id, project_id, candidate_id, evidence_id, state_key,
             value_json, version, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `accepted_${id}`,
          identity.workspace_id,
          identity.project_id,
          candidateId,
          evidenceId,
          stateKey,
          JSON.stringify(value),
          version,
          timestamp,
        );
    }
  }

  addClaim({
    id: "price_v1",
    stateKey: "launch.monthly_price_usd",
    value: 19,
    version: 1,
  });
  addClaim({
    id: "price_v2",
    stateKey: "launch.monthly_price_usd",
    value: 24,
    version: 2,
  });
  addClaim({
    id: "runtime",
    stateKey: "engineering.runtime_notes",
    value: `Node.js ${"x".repeat(1_300)}`,
    version: 1,
  });
  addClaim({
    id: "tax",
    stateKey: "finance.tax_policy",
    value: `Tax ${"y".repeat(1_300)}`,
    version: 1,
  });
  addClaim({
    id: "question",
    stateKey: "open_questions.launch_copy",
    value: "Which launch message should lead the onboarding page?",
    version: 1,
  });
  addClaim({
    id: "artifact",
    stateKey: "artifacts.launch_brief",
    value: { title: "Launch brief", url: "https://example.invalid/launch-brief" },
    version: 1,
  });
  addClaim({
    id: "price_alternative",
    stateKey: "launch.monthly_price_usd",
    value: 30,
    status: "pending",
  });
  addClaim({
    id: "price_rejected",
    stateKey: "launch.monthly_price_usd",
    value: 99,
    status: "rejected",
  });
  addClaim({
    id: "pending",
    stateKey: "launch.pending_secret",
    value: "pending must not appear",
    status: "pending",
  });
  addClaim({
    id: "rejected",
    stateKey: "launch.rejected_secret",
    value: "rejected must not appear",
    status: "rejected",
  });

  return { addClaim, database, identity };
}

test("deterministically prioritizes task-relevant latest accepted state", () => {
  const { addClaim, database, identity } = createContextFixture();
  const request = {
    userId: identity.id,
    projectId: identity.project_id,
    task: "Prepare the monthly launch price in USD",
    contextBudget: 2_000,
  };

  const first = getProjectContext(database, request);
  const second = getProjectContext(database, request);

  assert.deepEqual(second, first);
  assert.equal(first.accepted_decisions[0].state_key, "launch.monthly_price_usd");
  assert.equal(first.accepted_decisions[0].value, 24);
  assert.equal(first.accepted_decisions[0].version, 2);
  assert.equal(first.accepted_decisions[0].provenance.accepted_state_id, "accepted_price_v2");
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(
    serialized,
    /accepted_price_v1|pending must not appear|rejected must not appear/,
  );
  assert.equal(first.package.version, second.package.version);
  assert.equal(Buffer.byteLength(serialized, "utf8"), first.package.budget.used);
  assert.ok(first.package.budget.used <= first.package.budget.limit);
  assert.ok(first.package.omissions.total > 0);
  assert.equal(first.package.omissions.reason, "budget_exhausted");

  addClaim({
    id: "omitted_legal",
    stateKey: "legal.omitted_notes",
    value: `Legal ${"z".repeat(1_300)}`,
    version: 1,
  });
  const changed = getProjectContext(database, request);
  assert.notEqual(changed.package.version, first.package.version);
  assert.equal(changed.accepted_decisions[0].state_key, "launch.monthly_price_usd");
});

test("separates accepted questions, artifact references, and unresolved conflict notices", () => {
  const { database, identity } = createContextFixture();
  const context = getProjectContext(database, {
    userId: identity.id,
    projectId: identity.project_id,
    task: "Review launch price, launch copy question, and launch brief artifact",
    contextBudget: 16_000,
  });

  assert.deepEqual(
    context.open_questions.map((item) => [item.state_key, item.status]),
    [["open_questions.launch_copy", "open"]],
  );
  assert.deepEqual(
    context.artifacts.map((item) => [item.state_key, item.handling]),
    [["artifacts.launch_brief", "reference_only"]],
  );
  assert.equal(context.unresolved_conflicts.length, 1);
  assert.equal(context.unresolved_conflicts[0].state_key, "launch.monthly_price_usd");
  assert.equal(context.unresolved_conflicts[0].trusted_current.version, 2);
  assert.deepEqual(context.unresolved_conflicts[0].unreviewed_alternatives, [
    {
      candidate_id: "candidate_price_alternative",
      evidence_id: "evidence_price_alternative",
      evidence_payload_hash: "hash-price_alternative",
      evidence_captured_at: "2026-08-30T08:00:00.000Z",
      review_status: "pending",
    },
  ]);
  const conflictJson = JSON.stringify(context.unresolved_conflicts);
  assert.doesNotMatch(conflictJson, /candidate_price_rejected|"value":(?:30|99)/);
  assert.match(context.unresolved_conflicts[0].notice, /not alice\.-verified/);
});

test("context assembly does not mutate captured or trusted project state", () => {
  const { database, identity } = createContextFixture();
  const snapshot = () =>
    database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM evidence_events) AS evidence,
          (SELECT COUNT(*) FROM candidate_claims) AS candidates,
          (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
          (SELECT COUNT(*) FROM audit_events) AS audit,
          (SELECT COUNT(*) FROM projects) AS projects`,
      )
      .get();
  const before = snapshot();

  const context = getProjectContext(database, {
    userId: identity.id,
    projectId: identity.project_id,
    task: "Read the complete launch context",
    contextBudget: 16_000,
  });

  assert.deepEqual(snapshot(), before);
  assert.equal(Buffer.byteLength(JSON.stringify(context), "utf8"), context.package.budget.used);
  assert.ok(context.package.budget.used <= context.package.budget.limit);
});

test("fails closed when the required package envelope cannot fit", () => {
  const { database, identity } = createContextFixture();
  database
    .prepare("UPDATE projects SET brief = ? WHERE id = ?")
    .run("b".repeat(4_000), identity.project_id);
  const before = database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;

  assert.throws(
    () =>
      getProjectContext(database, {
        userId: identity.id,
        projectId: identity.project_id,
        task: "t".repeat(2_000),
        contextBudget: 2_000,
      }),
    ContextBudgetError,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, before);
});
