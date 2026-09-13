import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp } from "../apps/mcp/src/app.ts";
import { createTestIdentity, TEST_EMAIL, TEST_PASSWORD } from "./helpers.ts";

let baseUrl;
let created;
let server;

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  await createTestIdentity(created.database);
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("publishes OAuth resource and authorization metadata", async () => {
  const resourceResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource, "http://127.0.0.1/mcp");
  assert.deepEqual(resource.authorization_servers, ["http://127.0.0.1"]);

  const authorizationResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationResponse.status, 200);
  const authorization = await authorizationResponse.json();
  assert.equal(authorization.code_challenge_methods_supported[0], "S256");
  assert.equal(authorization.registration_endpoint, "http://127.0.0.1/register");
});

test("rejects an unauthenticated MCP request with a discovery challenge", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate");
  assert.match(challenge, /resource_metadata=/);
  assert.match(challenge, /scope="mcp:read mcp:write"/);
});

test("completes DCR, authorization-code PKCE, authenticated MCP, and revocation", async () => {
  const redirectUri = "http://127.0.0.1/callback";
  const registrationResponse = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Endpoint integration test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const client = await registrationResponse.json();
  assert.equal(client.scope, "mcp:read mcp:write offline_access");

  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const readOnlyConsentUrl = new URL(`${baseUrl}/authorize`);
  readOnlyConsentUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:read offline_access",
    resource: "http://127.0.0.1/mcp",
  });
  const readOnlyConsentResponse = await fetch(readOnlyConsentUrl, { redirect: "manual" });
  assert.equal(readOnlyConsentResponse.status, 303);
  const consentHandoff = new URL(readOnlyConsentResponse.headers.get("location"));
  assert.equal(consentHandoff.pathname, "/oauth/consent");
  assert.match(consentHandoff.searchParams.get("request"), /^alice_consent_/);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM integration_connections").get().count,
    0,
  );

  const authorizationBody = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:read mcp:write offline_access",
    resource: "http://127.0.0.1/mcp",
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  const authorizationResponse = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizationBody,
    redirect: "manual",
  });
  assert.equal(authorizationResponse.status, 303);
  const redirect = new URL(authorizationResponse.headers.get("location"));
  assert.equal(redirect.searchParams.get("state"), "test-state");

  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: redirect.searchParams.get("code"),
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: "http://127.0.0.1/mcp",
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.match(tokens.access_token, /^alice_access_/);
  assert.match(tokens.refresh_token, /^alice_refresh_/);

  const initializeResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "endpoint-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(initializeResponse.status, 200);
  assert.match(await initializeResponse.text(), /alice-mcp/);

  const connection = created.database
    .prepare("SELECT * FROM integration_connections WHERE client_id = ?")
    .get(client.client_id);
  const user = created.database.prepare("SELECT * FROM users WHERE email = ?").get(TEST_EMAIL);
  const workspace = created.database
    .prepare("SELECT * FROM workspaces WHERE user_id = ?")
    .get(user.id);
  assert.equal(connection.user_id, user.id);
  assert.equal(connection.workspace_id, workspace.id);
  assert.equal(connection.client_classification, "unknown_mcp_client");
  assert.equal(connection.granted_scopes, "mcp:read mcp:write offline_access");
  assert.equal(connection.revoked_at, null);

  const accessRow = created.database.prepare("SELECT * FROM oauth_access_tokens").get();
  const refreshRow = created.database.prepare("SELECT * FROM oauth_refresh_tokens").get();
  assert.equal(
    accessRow.token_hash,
    createHash("sha256").update(tokens.access_token).digest("hex"),
  );
  assert.equal(
    refreshRow.token_hash,
    createHash("sha256").update(tokens.refresh_token).digest("hex"),
  );
  assert.notEqual(accessRow.token_hash, tokens.access_token);
  assert.notEqual(refreshRow.token_hash, tokens.refresh_token);
  assert.equal(accessRow.connection_id, connection.id);
  assert.equal(refreshRow.connection_id, connection.id);

  const revokeResponse = await fetch(`${baseUrl}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      token: tokens.access_token,
    }),
  });
  assert.equal(revokeResponse.status, 200);
  const revoked = created.database
    .prepare("SELECT revoked_at FROM integration_connections WHERE id = ?")
    .get(connection.id);
  assert.ok(revoked.revoked_at);
  const revokeAudit = created.database
    .prepare("SELECT safe_metadata_json FROM audit_events WHERE action = ?")
    .get("integration_connection_revoked");
  assert.equal(JSON.parse(revokeAudit.safe_metadata_json).connection_id, connection.id);
  assert.doesNotMatch(revokeAudit.safe_metadata_json, /alice_(access|refresh)_/);

  const rejectedResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  assert.equal(rejectedResponse.status, 401);
});

test("stores confidential client credentials only as hashes", async () => {
  const response = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Confidential MCP client",
      redirect_uris: ["https://client.alice.example/callback"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  assert.equal(response.status, 201);
  const client = await response.json();
  assert.match(client.client_secret, /^alice_secret_/);
  const stored = created.database
    .prepare("SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?")
    .get(client.client_id);
  assert.equal(
    stored.client_secret_hash,
    createHash("sha256").update(client.client_secret).digest("hex"),
  );
  assert.notEqual(stored.client_secret_hash, client.client_secret);
});
