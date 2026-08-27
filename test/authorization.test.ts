import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "@alice/database";
import {
  acceptCandidate,
  createProject,
  getProject,
  getProjectContext,
  getReviewQueue,
  listProjects,
  saveCandidateUpdate,
  tenantScopeForConnection,
  tenantScopeForUser,
} from "@alice/domain";
import { createTestIdentity } from "./helpers.ts";

function insertConnection(database, identity, { id, clientId, revoked = false }) {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO oauth_clients
        (client_id, client_secret_hash, client_name, redirect_uris_json,
         token_endpoint_auth_method, created_at)
       VALUES (?, NULL, ?, '[]', 'none', ?)`,
    )
    .run(clientId, "Authorization policy fixture", now);
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, 'unknown_mcp_client', 'mcp:read mcp:write', ?, ?, ?)`,
    )
    .run(id, identity.id, identity.workspace_id, clientId, now, now, revoked ? now : null);
}

test("tenant policies deny missing, unknown, mismatched, and revoked principals", () => {
  const database = openDatabase(":memory:");
  const owner = createTestIdentity(database, {
    email: "policy-owner@alice.example",
    password: "policy owner private password",
    projectId: "project_policy_owner",
  });
  const other = createTestIdentity(database, {
    email: "policy-other@alice.example",
    password: "policy other private password",
    projectId: "project_policy_other",
  });
  insertConnection(database, owner, {
    id: "connection_policy_owner",
    clientId: "client_policy_owner",
  });
  insertConnection(database, owner, {
    id: "connection_policy_revoked",
    clientId: "client_policy_revoked",
    revoked: true,
  });

  assert.equal(tenantScopeForUser(database, undefined), undefined);
  assert.equal(tenantScopeForUser(database, "user_guessed"), undefined);
  assert.deepEqual(tenantScopeForUser(database, owner.id), {
    userId: owner.id,
    workspaceId: owner.workspace_id,
  });
  assert.equal(
    tenantScopeForConnection(database, {
      userId: other.id,
      connectionId: "connection_policy_owner",
    }),
    undefined,
  );
  assert.equal(
    tenantScopeForConnection(database, {
      userId: owner.id,
      connectionId: "connection_policy_revoked",
    }),
    undefined,
  );

  assert.deepEqual(listProjects(database, undefined), []);
  assert.equal(getProject(database, other.id, owner.project_id), undefined);
  assert.equal(
    createProject(database, "user_guessed", { name: "Denied", brief: "Denied" }),
    undefined,
  );
  assert.equal(
    getProjectContext(database, {
      userId: other.id,
      projectId: owner.project_id,
      task: "Guess",
      contextBudget: 2_000,
    }),
    undefined,
  );
  assert.equal(
    getReviewQueue(database, { userId: other.id, projectId: owner.project_id }),
    undefined,
  );
  assert.equal(
    acceptCandidate(database, { userId: other.id, candidateId: "candidate_guessed" }),
    undefined,
  );

  const deniedCapture = saveCandidateUpdate(database, {
    clientId: "client_policy_owner",
    connectionId: "connection_policy_owner",
    publicUrl: "http://127.0.0.1",
    userId: other.id,
    payload: {
      project_id: other.project_id,
      summary: "Attempt confused deputy write",
      candidate_claims: [{ state_key: "private.value", value: "denied", summary: "Denied" }],
      idempotency_key: "policy-denied-capture",
    },
  });
  assert.match(deniedCapture.error, /tenant context is missing/i);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM candidate_claims").get().count, 0);
  database.close();
});

test("database tenant constraints reject cross-workspace ownership", () => {
  const database = openDatabase(":memory:");
  const owner = createTestIdentity(database, {
    email: "constraint-owner@alice.example",
    password: "constraint owner private password",
    projectId: "project_constraint_owner",
  });
  const other = createTestIdentity(database, {
    email: "constraint-other@alice.example",
    password: "constraint other private password",
    projectId: "project_constraint_other",
  });
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_secret_hash, client_name, redirect_uris_json,
         token_endpoint_auth_method, created_at)
       VALUES ('client_constraint', NULL, 'Fixture', '[]', 'none', ?)`,
    )
    .run(new Date().toISOString());
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO integration_connections
            (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
             first_connected_at, last_used_at)
           VALUES ('connection_crossed', ?, ?, 'client_constraint', 'unknown', 'mcp:read', ?, ?)`,
        )
        .run(owner.id, other.workspace_id, new Date().toISOString(), new Date().toISOString()),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      database
        .prepare("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
        .run("workspace_second", owner.id, "Second", new Date().toISOString()),
    /UNIQUE constraint failed: workspaces.user_id/,
  );
  database.close();
});
