import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp as createMcpApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let cookie;
let database;
let identity;
let mcpBaseUrl;
let mcpServer;
let webBaseUrl;
let webServer;

function projectStateCounts() {
  return database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence,
        (SELECT COUNT(*) FROM candidate_claims) AS candidates,
        (SELECT COUNT(*) FROM accepted_project_state) AS accepted`,
    )
    .get();
}

before(async () => {
  database = openSqliteTestDatabase();
  identity = await createTestIdentity(database, {
    email: "single-save@alice.example",
    password: "single save private password",
    projectId: "project_single_save",
  });
  const mcp = await createMcpApp({ database, publicUrl: "http://127.0.0.1" });
  mcpServer = mcp.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => mcpServer.once("listening", resolve));
  mcpBaseUrl = `http://127.0.0.1:${mcpServer.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(mcpBaseUrl, {
    email: identity.email,
    password: "single save private password",
    clientName: "ChatGPT single Save card test",
  }));
  const web = await createWebApp({ database, publicUrl: "http://127.0.0.1" });
  webServer = web.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => webServer.once("listening", resolve));
  webBaseUrl = `http://127.0.0.1:${webServer.address().port}`;
  const login = await fetch(`${webBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: identity.email,
      password: "single save private password",
      next: "/",
    }),
    redirect: "manual",
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  await Promise.all(
    [mcpServer, webServer].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  database.close();
});

async function prepare(key: string, value: string) {
  return callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: identity.project_id,
      summary: "Save the exact launch message",
      candidate_claims: [{ state_key: "launch.message", value, summary: "Launch message" }],
      source_context: `The exact proposed message is ${value}.`,
      idempotency_key: key,
    },
  });
}

test("the authenticated web fallback has one Save action and atomically accepts it", async () => {
  const before = projectStateCounts();
  const prepared = await prepare("single-save-web-001", "Keep the plot");
  const preview = prepared.payload.result.structuredContent;
  assert.deepEqual(projectStateCounts(), before);

  const unauthenticated = await fetch(
    `${webBaseUrl}/save-previews/${encodeURIComponent(preview.preview_id)}`,
    { redirect: "manual" },
  );
  assert.equal(unauthenticated.status, 303);

  const page = await fetch(
    `${webBaseUrl}/save-previews/${encodeURIComponent(preview.preview_id)}`,
    {
      headers: { cookie },
    },
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Save this to Private project\?/);
  assert.match(html, /data-app-shell/);
  assert.match(html, /Keep the plot/);
  assert.doesNotMatch(html, /General|Work context/);
  assert.match(html, />Save</);
  assert.doesNotMatch(html, />Cancel|value="cancelled"/i);
  assert.deepEqual(projectStateCounts(), before);

  const saved = await fetch(
    `${webBaseUrl}/save-previews/${encodeURIComponent(preview.preview_id)}`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ preview_version: preview.preview_version }),
    },
  );
  assert.equal(saved.status, 200);
  assert.match(saved.url, new RegExp(`/projects/${identity.project_id}/changes$`));
  const savedHtml = await saved.text();
  assert.match(savedHtml, /Latest changes/);
  assert.deepEqual({ ...projectStateCounts() }, { evidence: 1, candidates: 1, accepted: 1 });
});

test("an ignored or stale card creates no additional project state", async () => {
  const ignored = await prepare("single-save-ignored-001", "Ignored value");
  assert.equal(ignored.payload.result.structuredContent.status, "awaiting_save");
  const before = projectStateCounts();

  const stale = await prepare("single-save-stale-001", "Stale value");
  const stalePreview = stale.payload.result.structuredContent;
  const denied = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: stalePreview.preview_id,
      preview_version: "0".repeat(64),
      authority_token: stale.payload.result._meta["alice/saveAuthority"].token,
    },
  });
  assert.equal(denied.payload.result.isError, true);
  assert.match(denied.payload.result.content[0].text, /preview changed/i);
  assert.deepEqual(projectStateCounts(), before);
});
