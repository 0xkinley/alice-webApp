import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { getReviewQueue, listReviewProjects, rejectCandidate } from "@alice/domain";
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

test("an explicit authenticated human rejection is terminal and preserves provenance", async () => {
  const rejectionPayload = {
    project_id: "project_switchboard_launch",
    summary: "Option for explicit rejection",
    candidate_claims: [
      {
        state_key: "launch.rejected_option",
        value: "Do not trust this option",
        summary: "Rejected launch option",
      },
    ],
    source_note: "Review fixture source",
    idempotency_key: "review-fixture-rejection",
  };
  const { payload: capture } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: rejectionPayload,
  });
  const rejectedCandidateId = capture.result.structuredContent.candidate_ids[0];
  const evidenceId = capture.result.structuredContent.evidence_id;
  const acceptedBefore = created.database
    .prepare("SELECT COUNT(*) AS count FROM accepted_project_state")
    .get().count;

  const unauthenticated = await fetch(`${webUrl}/review/candidates/${rejectedCandidateId}/reject`, {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(unauthenticated.status, 303);
  assert.match(unauthenticated.headers.get("location"), /^\/auth\/login/);
  assert.equal(
    created.database
      .prepare("SELECT status FROM candidate_claims WHERE id = ?")
      .get(rejectedCandidateId).status,
    "pending",
  );

  const reject = await fetch(`${webUrl}/review/candidates/${rejectedCandidateId}/reject`, {
    method: "POST",
    headers: { cookie: reviewCookie },
    redirect: "manual",
  });
  assert.equal(reject.status, 303);
  assert.equal(
    created.database
      .prepare("SELECT status FROM candidate_claims WHERE id = ?")
      .get(rejectedCandidateId).status,
    "rejected",
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    acceptedBefore,
  );
  const audit = created.database
    .prepare("SELECT * FROM audit_events WHERE action = 'candidate_rejected'")
    .get();
  assert.equal(audit.actor_type, "human_reviewer");
  assert.deepEqual(JSON.parse(audit.safe_metadata_json), {
    candidate_id: rejectedCandidateId,
    evidence_id: evidenceId,
    state_key: "launch.rejected_option",
  });

  const rejectedResponse = await fetch(
    `${webUrl}/review?project_id=project_switchboard_launch&status=rejected`,
    { headers: { cookie: reviewCookie } },
  );
  const rejectedHtml = await rejectedResponse.text();
  assert.match(rejectedHtml, new RegExp(rejectedCandidateId));
  assert.match(rejectedHtml, new RegExp(evidenceId));
  assert.match(rejectedHtml, new RegExp(audit.id));
  assert.match(rejectedHtml, /Review fixture source/);

  const auditCountBeforeRepeat = created.database
    .prepare("SELECT COUNT(*) AS count FROM audit_events")
    .get().count;
  for (const decision of ["accept", "reject"]) {
    const repeated = await fetch(`${webUrl}/review/candidates/${rejectedCandidateId}/${decision}`, {
      method: "POST",
      headers: { cookie: reviewCookie },
      redirect: "manual",
    });
    assert.equal(repeated.status, 409);
  }
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
    auditCountBeforeRepeat,
  );

  const { payload: retry } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: rejectionPayload,
  });
  assert.equal(retry.result.structuredContent.status, "reviewed");
  assert.deepEqual(retry.result.structuredContent.candidate_statuses, [
    { candidate_id: rejectedCandidateId, status: "rejected" },
  ]);
  assert.equal(retry.result.structuredContent.trusted_state_changed, false);

  const { payload: context } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: { project_id: "project_switchboard_launch", task: "Exclude rejected options" },
  });
  assert.doesNotMatch(JSON.stringify(context.result.structuredContent), /Do not trust this option/);
});

test("a failed rejection audit rolls the candidate status back to pending", async () => {
  const { payload: capture } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: "project_switchboard_launch",
      summary: "Rollback rejection fixture",
      candidate_claims: [
        { state_key: "launch.rollback_rejection", value: true, summary: "Must stay pending" },
      ],
      idempotency_key: "review-rejection-rollback",
    },
  });
  const candidateId = capture.result.structuredContent.candidate_ids[0];
  const userId = created.database
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(TEST_EMAIL).id;
  const auditCountBefore = created.database
    .prepare("SELECT COUNT(*) AS count FROM audit_events")
    .get().count;
  created.database.exec(`
    CREATE TRIGGER force_rejection_audit_failure
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'candidate_rejected'
    BEGIN
      SELECT RAISE(ABORT, 'forced rejection audit failure');
    END;
  `);
  try {
    assert.throws(
      () => rejectCandidate(created.database, { candidateId, userId }),
      /forced rejection audit failure/,
    );
  } finally {
    created.database.exec("DROP TRIGGER force_rejection_audit_failure");
  }
  assert.equal(
    created.database.prepare("SELECT status FROM candidate_claims WHERE id = ?").get(candidateId)
      .status,
    "pending",
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
    auditCountBefore,
  );
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
