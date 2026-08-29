import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "@alice/database";
import { getProjectContext } from "@alice/domain";
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

  return { database, identity };
}

test("deterministically prioritizes task-relevant latest accepted state", () => {
  const { database, identity } = createContextFixture();
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
});
