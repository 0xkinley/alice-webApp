import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { authorize, callMcp, createTestIdentity, TEST_EMAIL, TEST_PASSWORD } from "./helpers.ts";

let accessToken;
let baseUrl;
let candidateId;
let created;
let server;
let webServer;
let webUrl;

before(async () => {
  created = createApp({
    databaseFilename: ":memory:",
    publicUrl: "http://127.0.0.1",
  });
  createTestIdentity(created.database);
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const web = createWebApp({
    database: created.database,
    publicUrl: "http://127.0.0.1",
  });
  webServer = web.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => webServer.once("listening", resolve));
  webUrl = `http://127.0.0.1:${webServer.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(baseUrl));
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: "project_switchboard_launch",
      summary: "Candidate for review",
      candidate_claims: [{ state_key: "launch.monthly_price_usd", value: 24, summary: "Price" }],
      idempotency_key: "review-fixture-price",
    },
  });
  [candidateId] = payload.result.structuredContent.candidate_ids;
});

after(async () => {
  await new Promise((resolve, reject) =>
    webServer.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("review candidates are hidden until the human signs in", async () => {
  const response = await fetch(`${webUrl}/review?project_id=project_switchboard_launch`, {
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /^\/auth\/login/);
});

test("an explicit authenticated review accepts a candidate into versioned trusted state", async () => {
  const loginResponse = await fetch(`${webUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      next: "/review?project_id=project_switchboard_launch",
    }),
    redirect: "manual",
  });
  assert.equal(loginResponse.status, 303);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const reviewResponse = await fetch(`${webUrl}/review?project_id=project_switchboard_launch`, {
    headers: { cookie },
  });
  assert.equal(reviewResponse.status, 200);
  assert.match(await reviewResponse.text(), new RegExp(candidateId));

  const acceptResponse = await fetch(`${webUrl}/review/candidates/${candidateId}/accept`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(acceptResponse.status, 303);
  const accepted = created.database
    .prepare("SELECT * FROM accepted_project_state WHERE candidate_id = ?")
    .get(candidateId);
  assert.equal(accepted.version, 1);
  assert.equal(accepted.evidence_id.startsWith("evidence_"), true);
  assert.equal(
    created.database.prepare("SELECT status FROM candidate_claims WHERE id = ?").get(candidateId)
      .status,
    "accepted",
  );
  const audit = created.database
    .prepare("SELECT * FROM audit_events WHERE action = 'candidate_accepted'")
    .get();
  assert.equal(audit.actor_type, "human_reviewer");

  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: { project_id: "project_switchboard_launch", task: "Read accepted price" },
  });
  assert.equal(payload.result.structuredContent.accepted_decisions[0].value, 24);
});

test("MCP exposes no trusted-state review action", async () => {
  const { payload } = await callMcp(baseUrl, accessToken, "tools/list");
  const tools = payload.result.tools.map(({ name }) => name);
  assert.deepEqual(tools.sort(), ["get_project_context", "list_projects", "save_project_update"]);
});
