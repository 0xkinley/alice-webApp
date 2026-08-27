import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { getReviewQueue, listReviewProjects } from "@alice/domain";
import { authorize, callMcp, createTestIdentity, TEST_EMAIL, TEST_PASSWORD } from "./helpers.ts";

let accessToken;
let baseUrl;
let candidateId;
let created;
let reviewCookie;
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
      source_note: "The user explicitly chose the launch price.",
      source_context: "Launch plan excerpt: charge USD 24 per month.",
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
  const indexResponse = await fetch(`${webUrl}/review`, { redirect: "manual" });
  assert.equal(indexResponse.status, 303);
  assert.match(indexResponse.headers.get("location"), /^\/auth\/login/);
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
  reviewCookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const queueIndexResponse = await fetch(`${webUrl}/review`, {
    headers: { cookie: reviewCookie },
  });
  assert.equal(queueIndexResponse.status, 200);
  const queueIndexHtml = await queueIndexResponse.text();
  assert.match(queueIndexHtml, /Candidate review queue/);
  assert.match(queueIndexHtml, /Switchboard Launch/);
  assert.match(queueIndexHtml, /1 pending/);

  const reviewResponse = await fetch(`${webUrl}/review?project_id=project_switchboard_launch`, {
    headers: { cookie: reviewCookie },
  });
  assert.equal(reviewResponse.status, 200);
  const reviewHtml = await reviewResponse.text();
  assert.match(reviewHtml, new RegExp(candidateId));
  assert.match(reviewHtml, /Pending \(1\)/);
  assert.match(reviewHtml, /Candidate for review/);
  assert.match(reviewHtml, /The user explicitly chose the launch price/);
  assert.match(reviewHtml, /Launch plan excerpt: charge USD 24 per month/);
  assert.match(reviewHtml, /Payload hash/);
  assert.match(reviewHtml, /unknown_mcp_client/);

  const userId = created.database
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(TEST_EMAIL).id;
  assert.equal(listReviewProjects(created.database, userId)[0].pending_count, 1);
  const boundedQueue = getReviewQueue(created.database, {
    userId,
    projectId: "project_switchboard_launch",
    status: "pending",
    page: 999,
    pageSize: 999,
  });
  assert.equal(boundedQueue.pagination.page_size, 50);
  assert.equal(boundedQueue.pagination.page, 1);
  assert.equal(boundedQueue.pagination.selected_total, 1);

  const acceptResponse = await fetch(`${webUrl}/review/candidates/${candidateId}/accept`, {
    method: "POST",
    headers: { cookie: reviewCookie },
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

  const pendingResponse = await fetch(`${webUrl}/review?project_id=project_switchboard_launch`, {
    headers: { cookie: reviewCookie },
  });
  const pendingHtml = await pendingResponse.text();
  assert.match(pendingHtml, /No pending candidates/);
  assert.doesNotMatch(pendingHtml, new RegExp(candidateId));
  const acceptedResponse = await fetch(
    `${webUrl}/review?project_id=project_switchboard_launch&status=accepted`,
    { headers: { cookie: reviewCookie } },
  );
  const acceptedHtml = await acceptedResponse.text();
  assert.match(acceptedHtml, new RegExp(candidateId));
  assert.match(acceptedHtml, new RegExp(accepted.id));
  assert.match(acceptedHtml, /Version 1/);

  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: { project_id: "project_switchboard_launch", task: "Read accepted price" },
  });
  assert.equal(payload.result.structuredContent.accepted_decisions[0].value, 24);
});

test("a later human acceptance creates a traceable version without rewriting history", async () => {
  const { payload: capture } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: "project_switchboard_launch",
      summary: "Revise price",
      candidate_claims: [
        { state_key: "launch.monthly_price_usd", value: 29, summary: "Revised price" },
      ],
      idempotency_key: "review-fixture-revised-price",
    },
  });
  const secondCandidateId = capture.result.structuredContent.candidate_ids[0];
  const secondEvidenceId = capture.result.structuredContent.evidence_id;
  const accept = await fetch(`${webUrl}/review/candidates/${secondCandidateId}/accept`, {
    method: "POST",
    headers: { cookie: reviewCookie },
    redirect: "manual",
  });
  assert.equal(accept.status, 303);

  const versions = created.database
    .prepare(
      `SELECT id, candidate_id, evidence_id, value_json, version
       FROM accepted_project_state
       WHERE state_key = 'launch.monthly_price_usd'
       ORDER BY version`,
    )
    .all();
  assert.equal(versions.length, 2);
  assert.deepEqual(
    versions.map(({ version }) => version),
    [1, 2],
  );
  assert.equal(JSON.parse(versions[0].value_json), 24);
  assert.equal(JSON.parse(versions[1].value_json), 29);
  assert.equal(versions[1].candidate_id, secondCandidateId);
  assert.equal(versions[1].evidence_id, secondEvidenceId);

  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: { project_id: "project_switchboard_launch", task: "Read current price" },
  });
  const [current] = payload.result.structuredContent.accepted_decisions;
  assert.equal(current.value, 29);
  assert.equal(current.version, 2);
  assert.deepEqual(current.provenance, {
    candidate_id: secondCandidateId,
    evidence_id: secondEvidenceId,
  });

  assert.throws(
    () => created.database.prepare("UPDATE accepted_project_state SET value_json = '30'").run(),
    /versioned and immutable/,
  );
  assert.throws(
    () => created.database.prepare("DELETE FROM accepted_project_state").run(),
    /versioned and immutable/,
  );
  assert.throws(
    () => created.database.prepare("DELETE FROM candidate_claims").run(),
    /preserve history/,
  );
});

test("MCP exposes no trusted-state review action", async () => {
  const { payload } = await callMcp(baseUrl, accessToken, "tools/list");
  const tools = payload.result.tools.map(({ name }) => name);
  assert.deepEqual(tools.sort(), ["get_project_context", "list_projects", "save_project_update"]);
});
