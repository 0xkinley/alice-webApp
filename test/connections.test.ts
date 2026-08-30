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
  assert.match(html, /https:\/\/mcp\.alice\.example\/mcp/);
  assert.doesNotMatch(html, /Claude Desktop/);
  assert.doesNotMatch(html, /owner-token-hash/);
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
