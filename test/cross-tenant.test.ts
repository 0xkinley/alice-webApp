import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createProjectInvitation, createWorkContext, saveCandidateUpdate } from "@alice/domain";
import { createApp as createMcpApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let database;
let mcpBaseUrl;
let mcpServer;
let webBaseUrl;
let webServer;

const tenants: Record<string, any> = {
  alpha: {
    email: "tenant-alpha@alice.example",
    password: "tenant alpha private password",
    projectId: "project_tenant_alpha",
    projectName: "Alpha Confidential Project",
    acceptedValue: "alpha accepted secret",
    pendingValue: "alpha pending secret",
  },
  beta: {
    email: "tenant-beta@alice.example",
    password: "tenant beta private password",
    projectId: "project_tenant_beta",
    projectName: "Beta Confidential Project",
    acceptedValue: "beta accepted secret",
    pendingValue: "beta pending secret",
  },
};

async function login(identity) {
  const response = await fetch(`${webBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: identity.email,
      password: identity.password,
      next: "/",
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function captureFixture(key) {
  const identity = tenants[key];
  const subject = database
    .prepare(
      `SELECT user_id, connection_id, client_id FROM oauth_access_tokens
       WHERE token_hash = ?`,
    )
    .get(createHash("sha256").update(identity.accessToken).digest("hex"));
  const captured = await saveCandidateUpdate(database, {
    userId: subject.user_id,
    connectionId: subject.connection_id,
    clientId: subject.client_id,
    publicUrl: "http://127.0.0.1",
    payload: {
      project_id: identity.projectId,
      summary: `${key} tenant fixture`,
      candidate_claims: [
        {
          state_key: "tenant.accepted_value",
          value: identity.acceptedValue,
          summary: `${key} accepted fixture`,
        },
        {
          state_key: "tenant.pending_value",
          value: identity.pendingValue,
          summary: `${key} pending fixture`,
        },
      ],
      idempotency_key: `tenant-${key}-fixture`,
    },
  });
  identity.evidenceId = captured.evidence_id;
  [identity.acceptedCandidateId, identity.pendingCandidateId] = captured.candidate_ids;
}

const authorizationTables = [
  "projects",
  "work_contexts",
  "project_memberships",
  "project_invitations",
  "context_access_grants",
  "active_connection_targets",
  "evidence_events",
  "candidate_claims",
  "accepted_project_state",
  "context_entry_exclusions",
  "file_reference_exclusions",
  "project_deletion_requests",
  "audit_events",
];

function authorizationSnapshot() {
  return Object.fromEntries(
    authorizationTables.map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
}

function normalizedDenial(body, ids) {
  return Object.values(ids).reduce(
    (text, id) => (typeof id === "string" ? text.replaceAll(id, "opaque_identifier") : text),
    body,
  );
}

async function deniedRequest(cookie, request) {
  const response = await fetch(`${webBaseUrl}${request.path}`, {
    method: request.method || "GET",
    headers: {
      cookie,
      ...(request.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: request.body ? new URLSearchParams(request.body) : undefined,
    redirect: "manual",
  });
  return { status: response.status, body: await response.text() };
}

function authorizationRequests(ids) {
  const project = encodeURIComponent(ids.projectId);
  const context = encodeURIComponent(ids.contextId);
  const accepted = encodeURIComponent(ids.acceptedStateId);
  const evidence = encodeURIComponent(ids.evidenceId);
  const candidate = encodeURIComponent(ids.candidateId);
  const membership = encodeURIComponent(ids.membershipId);
  const invitation = encodeURIComponent(ids.invitationId);
  const grant = encodeURIComponent(ids.grantId);
  const validContext = {
    name: "Denied context",
    description: "Must not be created.",
    visibility: "all_members",
  };
  return [
    { path: `/projects/${project}` },
    { path: `/projects/${project}/access` },
    { path: `/projects/${project}/collaborators` },
    { path: `/projects/${project}/lifecycle` },
    { path: `/projects/${project}/export.json` },
    { path: `/projects/${project}/context-preview?context_id=${context}` },
    { path: `/projects/${project}/contexts/${context}/access` },
    { path: `/projects/${project}/saved-context?context_id=${context}` },
    { path: `/projects/${project}/saved-context/${accepted}/remove?context_id=${context}` },
    { path: `/projects/${project}/saved-context/${accepted}/repair?context_id=${context}` },
    { path: `/review?project_id=${project}` },
    { path: `/review/captures/${evidence}` },
    { path: `/projects/${project}/contexts/preview`, method: "POST", body: validContext },
    { path: `/projects/${project}/contexts`, method: "POST", body: validContext },
    {
      path: `/projects/${project}/invitations`,
      method: "POST",
      body: { email: "denied-invitation@alice.example", role: "viewer" },
    },
    { path: `/projects/${project}/invitations/${invitation}/revoke`, method: "POST" },
    { path: `/projects/${project}/invitations/${invitation}/resend`, method: "POST" },
    {
      path: `/projects/${project}/collaborators/${membership}/role`,
      method: "POST",
      body: { role: "viewer" },
    },
    {
      path: `/projects/${project}/collaborators/${membership}/transfer-ownership`,
      method: "POST",
    },
    { path: `/projects/${project}/collaborators/${membership}/remove`, method: "POST" },
    { path: `/projects/${project}/leave`, method: "POST" },
    {
      path: `/projects/${project}/contexts/${context}/access`,
      method: "POST",
      body: { membership_id: ids.membershipId, role: "viewer" },
    },
    {
      path: `/projects/${project}/contexts/${context}/access/${grant}/role`,
      method: "POST",
      body: { role: "viewer" },
    },
    { path: `/projects/${project}/contexts/${context}/access/${grant}/end`, method: "POST" },
    {
      path: `/projects/${project}/archive`,
      method: "POST",
      body: { expected_preview_version: "opaque-preview" },
    },
    {
      path: `/projects/${project}/restore`,
      method: "POST",
      body: { expected_preview_version: "opaque-preview" },
    },
    {
      path: `/projects/${project}/deletion-request`,
      method: "POST",
      body: { expected_preview_version: "opaque-preview", confirmation: "Denied" },
    },
    {
      path: `/projects/${project}/deletion-request/cancel`,
      method: "POST",
      body: { expected_preview_version: "opaque-preview" },
    },
    {
      path: `/projects/${project}/saved-context/${accepted}/remove`,
      method: "POST",
      body: { context_id: ids.contextId, preview_version: "opaque-preview", reason: "Denied" },
    },
    {
      path: `/projects/${project}/saved-context/${accepted}/repair`,
      method: "POST",
      body: {
        context_id: ids.contextId,
        preview_version: "opaque-preview",
        repair_type: "stale",
        note: "Denied",
      },
    },
    {
      path: `/review/captures/${evidence}/confirm`,
      method: "POST",
      body: { preview_version: "opaque-preview" },
    },
    {
      path: `/review/captures/${evidence}/cancel`,
      method: "POST",
      body: { preview_version: "opaque-preview" },
    },
    {
      path: `/review/candidates/${candidate}/accept`,
      method: "POST",
      expectedStatus: 409,
    },
    {
      path: `/review/candidates/${candidate}/reject`,
      method: "POST",
      expectedStatus: 409,
    },
    {
      path: `/review/candidates/${candidate}/supersede`,
      method: "POST",
      body: { superseded_accepted_state_id: ids.acceptedStateId },
      expectedStatus: 409,
    },
  ];
}

before(async () => {
  const mcp = await createMcpApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  database = mcp.database;
  for (const [key, identity] of Object.entries(tenants)) {
    const created = await createTestIdentity(database, {
      email: identity.email,
      password: identity.password,
      projectId: identity.projectId,
    });
    Object.assign(identity, created);
    database
      .prepare("UPDATE projects SET name = ?, brief = ? WHERE id = ?")
      .run(identity.projectName, `${key} private brief`, identity.projectId);
    identity.ownerMembershipId = database
      .prepare(
        `SELECT id FROM project_memberships
         WHERE project_id = ? AND user_id = ? AND role = 'owner' AND ended_at IS NULL`,
      )
      .get(identity.projectId, identity.id).id;
    identity.restrictedContextId = (
      await createWorkContext(database, {
        userId: identity.id,
        projectId: identity.projectId,
        input: {
          name: `${key} restricted authorization fixture`,
          description: `${key} restricted metadata must remain private.`,
          visibility: "selected_members",
        },
      })
    ).id;
    identity.pendingInvitationId = (
      await createProjectInvitation(database, {
        userId: identity.id,
        projectId: identity.projectId,
        email: `pending-${key}@alice.example`,
        role: "viewer",
      })
    ).id;
  }

  mcpServer = mcp.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => mcpServer.once("listening", resolve));
  mcpBaseUrl = `http://127.0.0.1:${mcpServer.address().port}`;
  for (const [key, identity] of Object.entries(tenants)) {
    const { tokens } = await authorize(mcpBaseUrl, {
      email: identity.email,
      password: identity.password,
      clientName: `ChatGPT ${key} tenant MCP client`,
    });
    identity.accessToken = tokens.access_token;
    await captureFixture(key);
  }

  const web = await createWebApp({ database, publicUrl: "http://127.0.0.1" });
  webServer = web.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => webServer.once("listening", resolve));
  webBaseUrl = `http://127.0.0.1:${webServer.address().port}`;
  for (const identity of Object.values(tenants)) {
    identity.cookie = await login(identity);
    const accepted = await fetch(
      `${webBaseUrl}/review/candidates/${identity.acceptedCandidateId}/accept`,
      { method: "POST", headers: { cookie: identity.cookie }, redirect: "manual" },
    );
    assert.equal(accepted.status, 303);
    identity.acceptedStateId = database
      .prepare("SELECT id FROM accepted_project_state WHERE candidate_id = ?")
      .get(identity.acceptedCandidateId).id;
  }
});

test("every web authorization surface returns one non-disclosing denial without mutation", async () => {
  for (const [actorKey, targetKey] of [
    ["alpha", "beta"],
    ["beta", "alpha"],
  ]) {
    const actor = tenants[actorKey];
    const target = tenants[targetKey];
    const targetIds = {
      projectId: target.projectId,
      contextId: target.restrictedContextId,
      acceptedStateId: target.acceptedStateId,
      evidenceId: target.evidenceId,
      candidateId: target.pendingCandidateId,
      membershipId: target.ownerMembershipId,
      invitationId: target.pendingInvitationId,
      grantId: `context_grant_${targetKey}_private`,
    };
    const guessedIds = {
      projectId: `project_${crypto.randomUUID()}`,
      contextId: `context_${crypto.randomUUID()}`,
      acceptedStateId: `accepted_${crypto.randomUUID()}`,
      evidenceId: `evidence_${crypto.randomUUID()}`,
      candidateId: `candidate_${crypto.randomUUID()}`,
      membershipId: `membership_${crypto.randomUUID()}`,
      invitationId: `project_invitation_${crypto.randomUUID()}`,
      grantId: `context_grant_${crypto.randomUUID()}`,
    };
    const before = authorizationSnapshot();
    const foreignRequests = authorizationRequests(targetIds);
    const guessedRequests = authorizationRequests(guessedIds);
    assert.equal(foreignRequests.length, guessedRequests.length);
    for (let index = 0; index < foreignRequests.length; index += 1) {
      const foreign = await deniedRequest(actor.cookie, foreignRequests[index]);
      const guessed = await deniedRequest(actor.cookie, guessedRequests[index]);
      const expectedStatus = foreignRequests[index].expectedStatus || 404;
      assert.equal(foreign.status, expectedStatus, foreignRequests[index].path);
      assert.equal(guessed.status, expectedStatus, guessedRequests[index].path);
      assert.equal(
        normalizedDenial(foreign.body, targetIds),
        normalizedDenial(guessed.body, guessedIds),
        foreignRequests[index].path,
      );
      assert.doesNotMatch(
        foreign.body,
        new RegExp(
          `${target.projectName}|${target.acceptedValue}|${target.pendingValue}|restricted metadata`,
          "i",
        ),
      );
    }
    assert.deepEqual(authorizationSnapshot(), before);
  }
});

after(async () => {
  await new Promise((resolve, reject) =>
    webServer.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise((resolve, reject) =>
    mcpServer.close((error) => (error ? reject(error) : resolve())),
  );
  database.close();
});

test("web project list, detail, creation, and review queue stay tenant-scoped", async () => {
  for (const [actorKey, targetKey] of [
    ["alpha", "beta"],
    ["beta", "alpha"],
  ]) {
    const actor = tenants[actorKey];
    const target = tenants[targetKey];
    const home = await fetch(webBaseUrl, { headers: { cookie: actor.cookie } });
    const homeHtml = await home.text();
    assert.equal(home.status, 200);
    assert.match(homeHtml, new RegExp(actor.projectName));
    assert.doesNotMatch(homeHtml, new RegExp(target.projectName));
    assert.doesNotMatch(homeHtml, new RegExp(target.projectId));

    const reviewIndex = await fetch(`${webBaseUrl}/review`, {
      headers: { cookie: actor.cookie },
    });
    const reviewIndexHtml = await reviewIndex.text();
    assert.equal(reviewIndex.status, 200);
    assert.match(reviewIndexHtml, new RegExp(actor.projectName));
    assert.doesNotMatch(
      reviewIndexHtml,
      new RegExp(
        `${target.projectName}|${target.acceptedValue}|${target.pendingValue}|${target.evidenceId}`,
      ),
    );

    const foreignDetail = await fetch(`${webBaseUrl}/projects/${target.projectId}`, {
      headers: { cookie: actor.cookie },
    });
    const guessedDetail = await fetch(`${webBaseUrl}/projects/project_${crypto.randomUUID()}`, {
      headers: { cookie: actor.cookie },
    });
    assert.equal(foreignDetail.status, 404);
    assert.equal(await foreignDetail.text(), await guessedDetail.text());

    const foreignReview = await fetch(
      `${webBaseUrl}/review?project_id=${encodeURIComponent(target.projectId)}`,
      { headers: { cookie: actor.cookie } },
    );
    const guessedReview = await fetch(
      `${webBaseUrl}/review?project_id=project_${crypto.randomUUID()}`,
      { headers: { cookie: actor.cookie } },
    );
    const foreignReviewHtml = await foreignReview.text();
    assert.equal(foreignReview.status, 404);
    assert.equal(foreignReviewHtml, await guessedReview.text());
    assert.doesNotMatch(
      foreignReviewHtml,
      new RegExp(
        `${target.projectName}|${target.acceptedValue}|${target.pendingValue}|${target.evidenceId}`,
      ),
    );

    const targetContext = database
      .prepare("SELECT context_id FROM candidate_context_targets WHERE candidate_id = ?")
      .get(target.pendingCandidateId);
    const foreignSavedContext = await fetch(
      `${webBaseUrl}/projects/${target.projectId}/saved-context?context_id=${targetContext.context_id}`,
      { headers: { cookie: actor.cookie } },
    );
    const guessedSavedContext = await fetch(
      `${webBaseUrl}/projects/project_${crypto.randomUUID()}/saved-context?context_id=context_${crypto.randomUUID()}`,
      { headers: { cookie: actor.cookie } },
    );
    const foreignSavedHtml = await foreignSavedContext.text();
    assert.equal(foreignSavedContext.status, 404);
    assert.equal(foreignSavedHtml, await guessedSavedContext.text());
    assert.doesNotMatch(
      foreignSavedHtml,
      new RegExp(
        `${target.projectName}|${target.acceptedValue}|${target.pendingValue}|${target.evidenceId}`,
      ),
    );
  }

  const maliciousCreate = await fetch(`${webBaseUrl}/projects`, {
    method: "POST",
    headers: {
      cookie: tenants.beta.cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Body workspace injection",
      brief: "Must remain in beta.",
      workspace_id: tenants.alpha.workspace_id,
    }),
    redirect: "manual",
  });
  assert.equal(maliciousCreate.status, 303);
  const createdProjectId = decodeURIComponent(
    maliciousCreate.headers.get("location").split("/").at(-1),
  );
  assert.equal(
    database.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(createdProjectId)
      .workspace_id,
    tenants.beta.workspace_id,
  );
});

test("foreign and guessed candidate review actions cannot mutate trusted state", async () => {
  for (const [actorKey, targetKey] of [
    ["alpha", "beta"],
    ["beta", "alpha"],
  ]) {
    const actor = tenants[actorKey];
    const target = tenants[targetKey];
    const acceptedBefore = database
      .prepare("SELECT COUNT(*) AS count FROM accepted_project_state")
      .get().count;
    const auditBefore = database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;

    for (const decision of ["accept", "reject"]) {
      const foreign = await fetch(
        `${webBaseUrl}/review/candidates/${target.pendingCandidateId}/${decision}`,
        { method: "POST", headers: { cookie: actor.cookie }, redirect: "manual" },
      );
      const guessed = await fetch(
        `${webBaseUrl}/review/candidates/candidate_${crypto.randomUUID()}/${decision}`,
        { method: "POST", headers: { cookie: actor.cookie }, redirect: "manual" },
      );
      assert.equal(foreign.status, 409);
      assert.equal(await foreign.text(), await guessed.text());
    }
    const foreignSupersession = await fetch(
      `${webBaseUrl}/review/candidates/${target.pendingCandidateId}/supersede`,
      {
        method: "POST",
        headers: {
          cookie: actor.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          superseded_accepted_state_id: target.acceptedStateId,
        }),
        redirect: "manual",
      },
    );
    const guessedSupersession = await fetch(
      `${webBaseUrl}/review/candidates/candidate_${crypto.randomUUID()}/supersede`,
      {
        method: "POST",
        headers: {
          cookie: actor.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          superseded_accepted_state_id: `accepted_${crypto.randomUUID()}`,
        }),
        redirect: "manual",
      },
    );
    assert.equal(foreignSupersession.status, 409);
    assert.equal(await foreignSupersession.text(), await guessedSupersession.text());
    assert.equal(
      database
        .prepare("SELECT status FROM candidate_claims WHERE id = ?")
        .get(target.pendingCandidateId).status,
      "pending",
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
      acceptedBefore,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
      auditBefore,
    );
  }
});

test("foreign and guessed exact save previews disclose nothing and cannot decide candidates", async () => {
  for (const [actorKey, targetKey] of [
    ["alpha", "beta"],
    ["beta", "alpha"],
  ]) {
    const actor = tenants[actorKey];
    const target = tenants[targetKey];
    const guessedEvidenceId = `evidence_${crypto.randomUUID()}`;
    const foreignPreview = await fetch(`${webBaseUrl}/review/captures/${target.evidenceId}`, {
      headers: { cookie: actor.cookie },
    });
    const guessedPreview = await fetch(`${webBaseUrl}/review/captures/${guessedEvidenceId}`, {
      headers: { cookie: actor.cookie },
    });
    assert.equal(foreignPreview.status, 404);
    const foreignHtml = await foreignPreview.text();
    assert.equal(foreignHtml, await guessedPreview.text());
    assert.doesNotMatch(
      foreignHtml,
      new RegExp(
        `${target.projectName}|${target.acceptedValue}|${target.pendingValue}|${target.evidenceId}`,
      ),
    );

    const countsBefore = database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
          (SELECT COUNT(*) FROM audit_events) AS audit`,
      )
      .get();
    for (const decision of ["confirm", "cancel"]) {
      const options = {
        method: "POST",
        headers: {
          cookie: actor.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ preview_version: "capture_preview_guessed" }),
        redirect: "manual" as const,
      };
      const foreign = await fetch(
        `${webBaseUrl}/review/captures/${target.evidenceId}/${decision}`,
        options,
      );
      const guessed = await fetch(
        `${webBaseUrl}/review/captures/${guessedEvidenceId}/${decision}`,
        options,
      );
      assert.equal(foreign.status, 404);
      assert.equal(await foreign.text(), await guessed.text());
    }
    assert.equal(
      database
        .prepare("SELECT status FROM candidate_claims WHERE id = ?")
        .get(target.pendingCandidateId).status,
      "pending",
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
            (SELECT COUNT(*) FROM audit_events) AS audit`,
        )
        .get(),
      countsBefore,
    );
  }
});

test("foreign and guessed saved-context removals disclose nothing and cannot exclude state", async () => {
  for (const [actorKey, targetKey] of [
    ["alpha", "beta"],
    ["beta", "alpha"],
  ]) {
    const actor = tenants[actorKey];
    const target = tenants[targetKey];
    const targetContext = database
      .prepare("SELECT context_id FROM accepted_context_entries WHERE accepted_state_id = ?")
      .get(target.acceptedStateId).context_id;
    const guessedProjectId = `project_${crypto.randomUUID()}`;
    const guessedContextId = `context_${crypto.randomUUID()}`;
    const guessedAcceptedStateId = `accepted_${crypto.randomUUID()}`;

    const foreignPreview = await fetch(
      `${webBaseUrl}/projects/${target.projectId}/saved-context/${target.acceptedStateId}/remove?context_id=${targetContext}`,
      { headers: { cookie: actor.cookie } },
    );
    const guessedPreview = await fetch(
      `${webBaseUrl}/projects/${guessedProjectId}/saved-context/${guessedAcceptedStateId}/remove?context_id=${guessedContextId}`,
      { headers: { cookie: actor.cookie } },
    );
    assert.equal(foreignPreview.status, 404);
    const foreignHtml = await foreignPreview.text();
    assert.equal(foreignHtml, await guessedPreview.text());
    assert.doesNotMatch(
      foreignHtml,
      new RegExp(`${target.projectName}|${target.acceptedValue}|${target.acceptedStateId}`),
    );

    const countsBefore = database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM context_entry_exclusions) AS exclusions,
          (SELECT COUNT(*) FROM context_history_events) AS history,
          (SELECT COUNT(*) FROM audit_events) AS audit`,
      )
      .get();
    const options = {
      method: "POST",
      headers: {
        cookie: actor.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        context_id: targetContext,
        preview_version: "removal_preview_guessed",
        reason: "Attempt cross-tenant removal",
      }),
      redirect: "manual" as const,
    };
    const foreignRemoval = await fetch(
      `${webBaseUrl}/projects/${target.projectId}/saved-context/${target.acceptedStateId}/remove`,
      options,
    );
    const guessedRemoval = await fetch(
      `${webBaseUrl}/projects/${guessedProjectId}/saved-context/${guessedAcceptedStateId}/remove`,
      {
        ...options,
        body: new URLSearchParams({
          context_id: guessedContextId,
          preview_version: "removal_preview_guessed",
          reason: "Attempt guessed removal",
        }),
      },
    );
    assert.equal(foreignRemoval.status, 404);
    assert.equal(await foreignRemoval.text(), await guessedRemoval.text());
    assert.deepEqual(
      database
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM context_entry_exclusions) AS exclusions,
            (SELECT COUNT(*) FROM context_history_events) AS history,
            (SELECT COUNT(*) FROM audit_events) AS audit`,
        )
        .get(),
      countsBefore,
    );
  }
});

test("MCP project listing, accepted context, and candidate capture deny the other tenant", async () => {
  for (const [actorKey, targetKey] of [
    ["alpha", "beta"],
    ["beta", "alpha"],
  ]) {
    const actor = tenants[actorKey];
    const target = tenants[targetKey];
    const listed = await callMcp(mcpBaseUrl, actor.accessToken, "tools/call", {
      name: "list_projects",
      arguments: {},
    });
    const listedJson = JSON.stringify(listed.payload.result.structuredContent);
    assert.match(listedJson, new RegExp(actor.projectId));
    assert.doesNotMatch(listedJson, new RegExp(target.projectId));
    assert.doesNotMatch(listedJson, new RegExp(target.projectName));

    const foreignContext = await callMcp(mcpBaseUrl, actor.accessToken, "tools/call", {
      name: "get_project_context",
      arguments: { project_id: target.projectId, task: "Guess foreign context" },
    });
    const guessedContext = await callMcp(mcpBaseUrl, actor.accessToken, "tools/call", {
      name: "get_project_context",
      arguments: { project_id: `project_${crypto.randomUUID()}`, task: "Guess random context" },
    });
    assert.equal(foreignContext.payload.result.isError, true);
    assert.deepEqual(foreignContext.payload.result, guessedContext.payload.result);
    assert.doesNotMatch(
      JSON.stringify(foreignContext.payload.result),
      new RegExp(`${target.acceptedValue}|${target.pendingValue}|${target.evidenceId}`),
    );

    const countsBefore = database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM evidence_events) AS evidence,
          (SELECT COUNT(*) FROM candidate_claims) AS candidates,
          (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
          (SELECT COUNT(*) FROM audit_events) AS audit`,
      )
      .get();
    const foreignCapture = await callMcp(mcpBaseUrl, actor.accessToken, "tools/call", {
      name: "save_project_update",
      arguments: {
        project_id: target.projectId,
        summary: "Attempt foreign capture",
        candidate_claims: [
          { state_key: "tenant.intrusion", value: actorKey, summary: "Must be denied" },
        ],
        idempotency_key: `foreign-${actorKey}-capture`,
      },
    });
    const guessedCapture = await callMcp(mcpBaseUrl, actor.accessToken, "tools/call", {
      name: "save_project_update",
      arguments: {
        project_id: `project_${crypto.randomUUID()}`,
        summary: "Attempt guessed capture",
        candidate_claims: [
          { state_key: "tenant.intrusion", value: actorKey, summary: "Must be denied" },
        ],
        idempotency_key: `guessed-${actorKey}-capture`,
      },
    });
    assert.equal(foreignCapture.payload.result.isError, true);
    assert.equal(
      foreignCapture.payload.result.content[0].text,
      guessedCapture.payload.result.content[0].text,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM evidence_events) AS evidence,
            (SELECT COUNT(*) FROM candidate_claims) AS candidates,
            (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
            (SELECT COUNT(*) FROM audit_events) AS audit`,
        )
        .get(),
      countsBefore,
    );

    const ownContext = await callMcp(mcpBaseUrl, actor.accessToken, "tools/call", {
      name: "get_project_context",
      arguments: { project_id: actor.projectId, task: "Read own accepted context" },
    });
    const ownJson = JSON.stringify(ownContext.payload.result.structuredContent);
    assert.match(ownJson, new RegExp(actor.acceptedValue));
    assert.doesNotMatch(ownJson, new RegExp(actor.pendingValue));
    assert.doesNotMatch(ownJson, new RegExp(target.acceptedValue));
  }
});

test("database composite keys reject cross-tenant project intelligence references", () => {
  const alpha = tenants.alpha;
  const beta = tenants.beta;
  const betaConnection = database
    .prepare("SELECT id, client_id FROM integration_connections WHERE user_id = ? LIMIT 1")
    .get(beta.id);
  const now = new Date().toISOString();

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO evidence_events
            (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
             connection_workspace_id, client_id, client_classification, tool_name,
             idempotency_key, payload_hash, created_at)
           VALUES ('evidence_crossed', ?, ?, '{}', 'mcp_host', ?, ?, ?, 'test',
                   'save_project_update', 'crossed-evidence', 'hash', ?)`,
        )
        .run(
          beta.workspace_id,
          alpha.projectId,
          betaConnection.id,
          beta.workspace_id,
          betaConnection.client_id,
          now,
        ),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO candidate_claims
            (id, workspace_id, project_id, evidence_id, state_key, value_json, summary,
             status, created_at)
           VALUES ('candidate_crossed', ?, ?, ?, 'crossed.value', '1', 'Crossed', 'pending', ?)`,
        )
        .run(beta.workspace_id, beta.projectId, alpha.evidenceId, now),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO accepted_project_state
            (id, workspace_id, project_id, candidate_id, evidence_id, state_key,
             value_json, version, accepted_at)
           VALUES ('accepted_crossed', ?, ?, ?, ?, 'crossed.value', '1', 1, ?)`,
        )
        .run(beta.workspace_id, beta.projectId, alpha.pendingCandidateId, alpha.evidenceId, now),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO audit_events
            (id, workspace_id, project_id, action, actor_type, actor_id,
             correlation_id, safe_metadata_json, created_at)
           VALUES ('audit_crossed', ?, ?, 'crossed', 'test', 'test', 'crossed', '{}', ?)`,
        )
        .run(beta.workspace_id, alpha.projectId, now),
    /FOREIGN KEY constraint failed/,
  );
});
