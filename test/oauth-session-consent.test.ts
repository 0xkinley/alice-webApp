import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp as createMcpApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { createTestIdentity, TEST_EMAIL, TEST_PASSWORD } from "./helpers.ts";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("OAuth reuses the signed-in alice. session and requires explicit consent", async () => {
  const database = openSqliteTestDatabase();
  await createTestIdentity(database);
  const [webPort, mcpPort] = await Promise.all([availablePort(), availablePort()]);
  const webUrl = `http://127.0.0.1:${webPort}`;
  const mcpUrl = `http://127.0.0.1:${mcpPort}`;
  const web = await createWebApp({ database, publicUrl: webUrl, mcpPublicUrl: mcpUrl });
  const mcp = await createMcpApp({ database, publicUrl: mcpUrl, reviewUrl: webUrl });
  const webServer = web.app.listen(webPort, "127.0.0.1");
  const mcpServer = mcp.app.listen(mcpPort, "127.0.0.1");
  await Promise.all([
    new Promise((resolve) => webServer.once("listening", resolve)),
    new Promise((resolve) => mcpServer.once("listening", resolve)),
  ]);

  try {
    const redirectUri = "http://127.0.0.1/provider-callback";
    const registration = await fetch(`${mcpUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await registration.json();
    const verifier = "b".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = new URL(`${mcpUrl}/authorize`);
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "provider-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write offline_access",
      resource: `${mcpUrl}/mcp`,
    });

    const handoff = await fetch(authorization, { redirect: "manual" });
    assert.equal(handoff.status, 303);
    const consentUrl = handoff.headers.get("location")!;
    assert.match(consentUrl, new RegExp(`^${webUrl.replaceAll(".", "\\.")}/oauth/consent`));

    const signedOutConsent = await fetch(consentUrl, { redirect: "manual" });
    assert.equal(signedOutConsent.status, 303);
    const loginUrl = new URL(signedOutConsent.headers.get("location")!, webUrl);
    assert.equal(loginUrl.pathname, "/auth/login");

    const login = await fetch(`${webUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        next: loginUrl.searchParams.get("next")!,
      }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /SameSite=Lax/);
    const sessionCookie = cookie.split(";")[0];

    const consent = await fetch(consentUrl, { headers: { cookie: sessionCookie } });
    assert.equal(consent.status, 200);
    const consentHtml = await consent.text();
    assert.match(consentHtml, /Connect ChatGPT to alice/);
    assert.match(consentHtml, /only the exact project named or selected/);
    assert.match(consentHtml, /only your authenticated Save action/);
    assert.doesNotMatch(consentHtml, /type="password"/);
    assert.doesNotMatch(consentHtml, /mcp:write|offline_access|client_id/);

    const requestToken = new URL(consentUrl).searchParams.get("request")!;
    const approval = await fetch(`${webUrl}/oauth/consent`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ request: requestToken }),
      redirect: "manual",
    });
    assert.equal(approval.status, 303);
    assert.match(
      approval.headers.get("location")!,
      new RegExp(`^${mcpUrl.replaceAll(".", "\\.")}/authorize/complete`),
    );

    const completion = await fetch(approval.headers.get("location")!, { redirect: "manual" });
    assert.equal(completion.status, 303);
    const providerCallback = new URL(completion.headers.get("location")!);
    assert.equal(providerCallback.origin + providerCallback.pathname, redirectUri);
    assert.equal(providerCallback.searchParams.get("state"), "provider-state");
    assert.match(providerCallback.searchParams.get("code"), /^alice_code_/);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM integration_connections").get().count,
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM oauth_consent_transactions").get().count,
      0,
    );

    const replay = await fetch(approval.headers.get("location")!, { redirect: "manual" });
    assert.equal(replay.status, 400);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM integration_connections").get().count,
      1,
    );
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        webServer.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        mcpServer.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
    database.close();
  }
});
