import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.js";

let baseUrl;
let server;

before(async () => {
  const created = createApp({
    databaseFilename: ":memory:",
    passphrase: "correct horse battery staple",
    publicUrl: "http://127.0.0.1",
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
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
  assert.match(response.headers.get("www-authenticate"), /resource_metadata=/);
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

  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationBody = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:read mcp:write offline_access",
    resource: "http://127.0.0.1/mcp",
    passphrase: "correct horse battery staple",
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
  assert.match(await initializeResponse.text(), /alice-mcp-compatibility-spike/);

  const revokeResponse = await fetch(`${baseUrl}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      token: tokens.access_token,
    }),
  });
  assert.equal(revokeResponse.status, 200);

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
