import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  cancelCapturedUpdate,
  confirmCapturedUpdate,
  createUserSession,
  getCapturePreview,
  saveCandidateUpdate,
} from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";
import { createTestIdentity } from "./helpers.ts";

let baseUrl;
let cookie;
let created;
let general;
let owner;
let pendingEvidenceId;
let server;

async function capture(idempotencyKey, contextId, stateKey, value) {
  return saveCandidateUpdate(created.database, {
    clientId: "saved-context-client",
    connectionId: "saved-context-connection",
    publicUrl: baseUrl,
    userId: owner.id,
    payload: {
      project_id: owner.project_id,
      context_id: contextId,
      summary: `Save ${stateKey}`,
      candidate_claims: [{ state_key: stateKey, value, summary: `Summary for ${stateKey}` }],
      idempotency_key: idempotencyKey,
    },
  });
}

before(async () => {
  const database = openSqliteTestDatabase();
  owner = await createTestIdentity(database, {
    email: "saved-context-owner@alice.example",
    projectId: "project_saved_context",
  });
  general = database
    .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND name = 'General'")
    .get(owner.project_id);
  const projectWide = database
    .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND context_kind = 'project_wide'")
    .get(owner.project_id);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('saved-context-client', 'Saved context fixture', '[]', 'none', ?)`,
    )
    .run(now);
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('saved-context-connection', ?, ?, 'saved-context-client', 'chatgpt',
               'mcp:read mcp:write', ?, ?)`,
    )
    .run(owner.id, owner.workspace_id, now, now);

  created = await createApp({ database, publicUrl: "http://127.0.0.1" });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const session = await createUserSession(database, owner.id);
  cookie = `alice_session=${encodeURIComponent(session.token)}`;

  const saved = await capture(
    "saved-context-accepted",
    general.id,
    "launch.saved_item",
    "Visible saved value",
  );
  const savedPreview = await getCapturePreview(database, {
    evidenceId: saved.evidence_id,
    userId: owner.id,
  });
  await confirmCapturedUpdate(database, {
    evidenceId: saved.evidence_id,
    expectedPreviewVersion: savedPreview.preview_version,
    userId: owner.id,
  });

  const pending = await capture(
    "saved-context-pending",
    general.id,
    "launch.pending_item",
    "Visible pending value",
  );
  pendingEvidenceId = pending.evidence_id;

  const rejected = await capture(
    "saved-context-rejected",
    general.id,
    "launch.not_saved_item",
    "Visible not-saved value",
  );
  const rejectedPreview = await getCapturePreview(database, {
    evidenceId: rejected.evidence_id,
    userId: owner.id,
  });
  await cancelCapturedUpdate(database, {
    evidenceId: rejected.evidence_id,
    expectedPreviewVersion: rejectedPreview.preview_version,
    userId: owner.id,
  });

  const projectSaved = await capture(
    "saved-context-project-wide",
    projectWide.id,
    "project.saved_item",
    "Project-wide saved value",
  );
  const projectPreview = await getCapturePreview(database, {
    evidenceId: projectSaved.evidence_id,
    userId: owner.id,
  });
  await confirmCapturedUpdate(database, {
    evidenceId: projectSaved.evidence_id,
    expectedPreviewVersion: projectPreview.preview_version,
    userId: owner.id,
  });
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("saved context is private and uses user-facing lifecycle language", async () => {
  const unauthenticated = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}`,
    { redirect: "manual" },
  );
  assert.equal(unauthenticated.status, 303);
  assert.match(unauthenticated.headers.get("location"), /^\/auth\/login/);

  const response = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Saved context \(1\)/);
  assert.match(html, /Needs attention \(1\)/);
  assert.match(html, /Removed \(0\)/);
  assert.match(html, /History \(3\)/);
  assert.match(html, /Visible saved value/);
  assert.doesNotMatch(
    html,
    /Visible pending value|Visible not-saved value|Project-wide saved value/,
  );
  assert.match(html, /Source and history/);
});

test("Needs attention links to the exact preview and History explains prior outcomes", async () => {
  const attention = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=attention`,
    { headers: { cookie } },
  );
  const attentionHtml = await attention.text();
  assert.match(attentionHtml, /Visible pending value/);
  assert.match(attentionHtml, new RegExp(`/review/captures/${pendingEvidenceId}`));
  assert.doesNotMatch(attentionHtml, /Visible saved value|Visible not-saved value/);

  const removed = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=removed`,
    { headers: { cookie } },
  );
  assert.match(await removed.text(), /Nothing has been removed from this context/);

  const history = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=history`,
    { headers: { cookie } },
  );
  const historyHtml = await history.text();
  assert.match(historyHtml, /Visible saved value/);
  assert.match(historyHtml, /Visible pending value/);
  assert.match(historyHtml, /Visible not-saved value/);
  assert.match(historyHtml, /Saved/);
  assert.match(historyHtml, /Needs attention/);
  assert.match(historyHtml, /Not saved/);
});

test("context switching is explicit and guessed context identifiers reveal nothing", async () => {
  const projectWide = await fetch(`${baseUrl}/projects/${owner.project_id}/saved-context`, {
    headers: { cookie },
  });
  const projectWideHtml = await projectWide.text();
  assert.match(projectWideHtml, /Project-wide saved value/);
  assert.doesNotMatch(projectWideHtml, /Visible saved value/);

  const foreign = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=context_foreign`,
    { headers: { cookie } },
  );
  const guessed = await fetch(
    `${baseUrl}/projects/project_${crypto.randomUUID()}/saved-context?context_id=context_${crypto.randomUUID()}`,
    { headers: { cookie } },
  );
  assert.equal(foreign.status, 404);
  assert.equal(await foreign.text(), await guessed.text());
});

test("the project page links every context to its saved-context view", async () => {
  const project = await fetch(`${baseUrl}/projects/${owner.project_id}`, {
    headers: { cookie },
  });
  const html = await project.text();
  assert.match(
    html,
    new RegExp(`/projects/${owner.project_id}/saved-context\\?context_id=${general.id}`),
  );
});
