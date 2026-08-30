import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { openDatabase } from "@alice/database";
import {
  acceptCandidate,
  getProjectContext,
  saveCandidateUpdate,
  supersedeAcceptedState,
} from "@alice/domain";
import { createTestIdentity } from "../helpers.ts";

const connectionString = process.env.ALICE_TEST_DATABASE_URL;
assert.ok(connectionString, "ALICE_TEST_DATABASE_URL is required for PostgreSQL tests.");

const schema = `test_${randomUUID().replaceAll("-", "_")}`;
let database;
let owner;
let other;

const clientId = "client_postgres_concurrency";
const connectionId = "connection_postgres_concurrency";

function payload(idempotencyKey, value = 24) {
  return {
    project_id: owner.project_id,
    summary: "PostgreSQL concurrency fixture",
    candidate_claims: [
      {
        state_key: "launch.monthly_price_usd",
        value,
        summary: "Monthly price",
      },
    ],
    source_context: "Exact source bytes retained as text.",
    idempotency_key: idempotencyKey,
  };
}

async function capture(idempotencyKey, value = 24) {
  return saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl: "https://app.alice.example",
    userId: owner.id,
    payload: payload(idempotencyKey, value),
  });
}

before(async () => {
  database = await openDatabase({ connectionString, schema, maxConnections: 20 });
  owner = await createTestIdentity(database, {
    email: "postgres-owner@alice.example",
    password: "postgres owner private password",
    projectId: "project_postgres_owner",
  });
  other = await createTestIdentity(database, {
    email: "postgres-other@alice.example",
    password: "postgres other private password",
    projectId: "project_postgres_other",
  });
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, '[]', 'none', ?)`,
    )
    .run(clientId, "PostgreSQL concurrency fixture", now);
  await database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES (?, ?, ?, ?, 'test', 'mcp:read mcp:write', ?, ?)`,
    )
    .run(connectionId, owner.id, owner.workspace_id, clientId, now, now);
});

after(async () => {
  await database.close();
});

test("versioned migration is repeatable on the same PostgreSQL schema", async () => {
  const migration = await database
    .prepare("SELECT version, filename FROM alice_schema_migrations ORDER BY version")
    .all();
  assert.deepEqual(migration, [{ version: 1, filename: "001_initial.sql" }]);

  const reopened = await openDatabase({ connectionString, schema, maxConnections: 2 });
  assert.equal(
    (await reopened.prepare("SELECT COUNT(*) AS count FROM alice_schema_migrations").get()).count,
    1,
  );
  await reopened.close();
});

test("concurrent identical capture is atomic and idempotent with byte-exact evidence text", async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () => capture("postgres-identical-capture")),
  );
  assert.equal(new Set(results.map((result) => result.evidence_id)).size, 1);
  assert.equal(new Set(results.map((result) => result.audit_event_id)).size, 1);
  assert.equal(results.filter((result) => result.deduplicated === false).length, 1);

  const evidence = await database
    .prepare("SELECT exact_payload_json, payload_hash FROM evidence_events WHERE id = ?")
    .get(results[0].evidence_id);
  const exact = JSON.stringify(payload("postgres-identical-capture"));
  assert.equal(evidence.exact_payload_json, exact);
  assert.equal(evidence.payload_hash, createHash("sha256").update(exact).digest("hex"));
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM candidate_claims").get()).count,
    1,
  );
});

test("concurrent conflicting idempotency-key reuse fails closed without duplication", async () => {
  const [left, right] = await Promise.all([
    capture("postgres-conflicting-capture", 29),
    capture("postgres-conflicting-capture", 31),
  ]);
  assert.equal([left, right].filter((result) => !result.error).length, 1);
  assert.equal([left, right].filter((result) => result.error).length, 1);
  assert.match(left.error || right.error, /different payload/i);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM evidence_events WHERE idempotency_key = ?")
        .get("postgres-conflicting-capture")
    ).count,
    1,
  );
});

test("human acceptance and concurrent supersession preserve one version chain", async () => {
  const initial = await capture("postgres-accept-initial", 40);
  const accepted = await acceptCandidate(database, {
    candidateId: initial.candidate_ids[0],
    userId: owner.id,
  });
  assert.equal(accepted.version, 1);

  const [candidateA, candidateB] = await Promise.all([
    capture("postgres-supersede-a", 41),
    capture("postgres-supersede-b", 42),
  ]);
  const attempts = await Promise.all([
    supersedeAcceptedState(database, {
      candidateId: candidateA.candidate_ids[0],
      supersededAcceptedStateId: accepted.acceptedStateId,
      userId: owner.id,
    }),
    supersedeAcceptedState(database, {
      candidateId: candidateB.candidate_ids[0],
      supersededAcceptedStateId: accepted.acceptedStateId,
      userId: owner.id,
    }),
  ]);
  assert.equal(attempts.filter(Boolean).length, 1);
  const versions = await database
    .prepare(
      `SELECT version FROM accepted_project_state
       WHERE project_id = ? AND state_key = ?
       ORDER BY version`,
    )
    .all(owner.project_id, "launch.monthly_price_usd");
  assert.deepEqual(
    versions.map(({ version }) => version),
    [1, 2],
  );
  assert.equal(
    (
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM candidate_claims
           WHERE project_id = ? AND state_key = ? AND status = 'pending'
             AND id IN (?, ?)`,
        )
        .get(
          owner.project_id,
          "launch.monthly_price_usd",
          candidateA.candidate_ids[0],
          candidateB.candidate_ids[0],
        )
    ).count,
    1,
  );
});

test("PostgreSQL rejects immutable history rewrites through the application role", async () => {
  await assert.rejects(
    database.prepare("UPDATE evidence_events SET exact_payload_json = '{}'").run(),
    /immutable/i,
  );
  await assert.rejects(database.prepare("DELETE FROM audit_events").run(), /immutable/i);
  await assert.rejects(
    database.prepare("UPDATE accepted_project_state SET value_json = '0'").run(),
    /immutable/i,
  );
});

test("cross-tenant and mismatched-connection access disclose nothing and mutate nothing", async () => {
  const context = await getProjectContext(database, {
    userId: other.id,
    projectId: owner.project_id,
    task: "Guess private launch price",
    contextBudget: 4_000,
  });
  assert.equal(context, undefined);
  const before = await database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get();
  const denied = await saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl: "https://app.alice.example",
    userId: other.id,
    payload: {
      ...payload("postgres-denied-cross-tenant"),
      project_id: other.project_id,
    },
  });
  assert.match(denied.error, /tenant context is missing/i);
  const afterCount = await database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get();
  assert.equal(afterCount.count, before.count);
});
