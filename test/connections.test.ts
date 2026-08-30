import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createUserSession } from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";
import { createTestIdentity } from "./helpers.ts";

let baseUrl;
let cookie;
let created;
let owner;
let other;
let server;

before(async () => {
  const database = openSqliteTestDatabase();
  owner = await createTestIdentity(database, {
    email: "connection-owner@alice.example",
    projectId: "project_connection_owner",
  });
  other = await createTestIdentity(database, {
    email: "connection-other@alice.example",
    projectId: "project_connection_other",
  });
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, '[]', 'none', ?)`,
    )
    .run("client_owner_chatgpt", "ChatGPT web", now);
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, '[]', 'none', ?)`,
    )
    .run("client_other_claude", "Claude Desktop", now);
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, '[]', 'none', ?)`,
    )
    .run("client_owner_claude", "Claude web", now);
  for (const [identity, connectionId, clientId, classification] of [
    [owner, "connection_owner", "client_owner_chatgpt", "chatgpt"],
    [other, "connection_other", "client_other_claude", "claude"],
  ]) {
    database
      .prepare(
        `INSERT INTO integration_connections
          (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
           first_connected_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, 'mcp:read mcp:write', ?, ?)`,
      )
      .run(connectionId, identity.id, identity.workspace_id, clientId, classification, now, now);
  }
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('connection_owner_claude', ?, ?, 'client_owner_claude', 'claude',
               'mcp:read mcp:write', ?, ?)`,
    )
    .run(owner.id, owner.workspace_id, now, now);
  database
    .prepare(
      `INSERT INTO oauth_access_tokens
        (token_hash, client_id, user_id, connection_id, scope, resource, expires_at)
       VALUES ('owner-token-hash', 'client_owner_chatgpt', ?, 'connection_owner',
               'mcp:read mcp:write', 'http://127.0.0.1/mcp', 9999999999)`,
    )
    .run(owner.id);

  created = await createApp({
    database,
    mcpPublicUrl: "https://mcp.alice.example",
    publicUrl: "http://127.0.0.1",
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const session = await createUserSession(database, owner.id);
  cookie = `alice_session=${encodeURIComponent(session.token)}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("connection center exposes only the current user's safe connection metadata", async () => {
  const response = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ChatGPT web/);
  assert.match(html, /Claude web/);
  assert.match(html, /https:\/\/mcp\.alice\.example\/mcp/);
  assert.match(html, /Active project and work context/);
  assert.doesNotMatch(html, /Claude Desktop/);
  assert.doesNotMatch(html, /owner-token-hash/);
});

test("a user explicitly selects one permitted target for all active AI connections", async () => {
  const general = created.database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE project_id = ? AND context_kind = 'work' AND name = 'General'`,
    )
    .get(owner.project_id);
  const response = await fetch(`${baseUrl}/connections/connection_owner/target`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      target: `${owner.project_id}|${general.id}`,
      apply_all: "yes",
      expected_versions: JSON.stringify({
        connection_owner: null,
        connection_owner_claude: null,
      }),
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/connections");
  const targets = created.database
    .prepare(
      `SELECT connection_id, project_id, context_id, selection_version
       FROM active_connection_targets ORDER BY connection_id`,
    )
    .all();
  assert.deepEqual(
    targets.map(({ connection_id: connectionId, project_id: projectId, context_id: contextId }) => [
      connectionId,
      projectId,
      contextId,
    ]),
    [
      ["connection_owner", owner.project_id, general.id],
      ["connection_owner_claude", owner.project_id, general.id],
    ],
  );
  assert.equal(new Set(targets.map(({ selection_version: version }) => version)).size, 1);
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM context_history_events WHERE action = ?")
      .get("active_target_selected").count,
    2,
  );

  const page = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
  assert.match(await page.text(), /Active target:<\/strong> Private project \/ General/);
});

test("a stale selection cannot silently overwrite a newer target", async () => {
  const general = created.database
    .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND name = 'General'")
    .get(owner.project_id);
  const response = await fetch(`${baseUrl}/connections/connection_owner/target`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      target: `${owner.project_id}|${general.id}`,
      expected_versions: JSON.stringify({ connection_owner: null }),
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 409);
});

test("foreign connection and context identifiers disclose nothing and select nothing", async () => {
  const foreignGeneral = created.database
    .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND name = 'General'")
    .get(other.project_id);
  const response = await fetch(`${baseUrl}/connections/connection_other/target`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      target: `${other.project_id}|${foreignGeneral.id}`,
      expected_versions: JSON.stringify({ connection_other: null }),
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 404);
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM active_connection_targets WHERE connection_id = ?")
      .get("connection_other").count,
    0,
  );
});

test("foreign connection identifiers disclose nothing and perform no revocation", async () => {
  const response = await fetch(`${baseUrl}/connections/connection_other/revoke`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(response.status, 404);
  assert.equal(
    created.database
      .prepare("SELECT revoked_at FROM integration_connections WHERE id = 'connection_other'")
      .get().revoked_at,
    null,
  );
});

test("authenticated revocation invalidates the user's connection and bearer tokens", async () => {
  const response = await fetch(`${baseUrl}/connections/connection_owner/revoke`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/connections");
  assert.ok(
    created.database
      .prepare("SELECT revoked_at FROM integration_connections WHERE id = 'connection_owner'")
      .get().revoked_at,
  );
  assert.ok(
    created.database
      .prepare("SELECT revoked_at FROM oauth_access_tokens WHERE token_hash = 'owner-token-hash'")
      .get().revoked_at,
  );
});
