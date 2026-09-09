import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  acceptProjectInvitation,
  createProjectInvitation,
  createWorkContext,
  getProjectInvitationPreview,
  getProjectLifecycle,
  issueAlphaInvitation,
} from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";

let baseUrl;
let created;
let server;
let ownerCookie;
let editorCookie;
let outsiderCookie;
let ownerUser;
let editorUser;
let projectId;
let pendingInvitation;

const identities = {
  owner: {
    email: "lifecycle-owner@alice.example",
    password: "lifecycle owner private password",
  },
  editor: {
    email: "lifecycle-editor@alice.example",
    password: "lifecycle editor private password",
  },
  outsider: {
    email: "lifecycle-outsider@alice.example",
    password: "lifecycle outsider private password",
  },
};

async function register(identity) {
  const invitation = await issueAlphaInvitation(created.database, { email: identity.email });
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...identity, invitationToken: invitation.token }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function postLifecycle(path, cookie, body = {}) {
  return await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ownerCookie = await register(identities.owner);
  editorCookie = await register(identities.editor);
  outsiderCookie = await register(identities.outsider);
  ownerUser = created.database
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(identities.owner.email);
  editorUser = created.database
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(identities.editor.email);

  const response = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Lifecycle safety project",
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  projectId = decodeURIComponent(response.headers.get("location").split("/").at(-1));

  const editorInvitation = await createProjectInvitation(created.database, {
    userId: ownerUser.id,
    projectId,
    email: identities.editor.email,
    role: "editor",
  });
  await acceptProjectInvitation(created.database, editorUser.id, editorInvitation.token);
  await createWorkContext(created.database, {
    userId: editorUser.id,
    projectId,
    input: {
      name: "Restricted launch secret",
      description: "Never disclose the restricted launch codename KESTREL.",
      visibility: "selected_members",
    },
  });
  await createWorkContext(created.database, {
    userId: editorUser.id,
    projectId,
    input: {
      name: "Editor's private secret",
      description: "Never disclose the personal draft codename ORIOLE.",
      visibility: "personal",
    },
  });
  const now = new Date().toISOString();
  const ownerWorkspace = created.database
    .prepare("SELECT workspace_id FROM projects WHERE id = ?")
    .get(projectId);
  const generalContext = created.database
    .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND name = 'General'")
    .get(projectId);
  await created.database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('lifecycle_client', 'Lifecycle client', '[]', 'none', ?)`,
    )
    .run(now);
  await created.database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification,
         granted_scopes, first_connected_at, last_used_at)
       VALUES ('lifecycle_connection', ?, ?, 'lifecycle_client', 'test',
               'mcp:read mcp:write', ?, ?)`,
    )
    .run(ownerUser.id, ownerWorkspace.workspace_id, now, now);
  await created.database
    .prepare(
      `INSERT INTO active_connection_targets
        (connection_id, user_id, workspace_id, project_workspace_id,
         project_id, context_id, surface, selection_version, selected_at, updated_at)
       VALUES ('lifecycle_connection', ?, ?, ?, ?, ?, 'test', 'target_version_1', ?, ?)`,
    )
    .run(
      ownerUser.id,
      ownerWorkspace.workspace_id,
      ownerWorkspace.workspace_id,
      projectId,
      generalContext.id,
      now,
      now,
    );
  pendingInvitation = await createProjectInvitation(created.database, {
    userId: ownerUser.id,
    projectId,
    email: "pending-lifecycle-invite@alice.example",
    role: "viewer",
  });
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("Owner lifecycle controls archive without erasure and export only permitted contexts", async () => {
  const lifecycleUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}/lifecycle`;
  const exportUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}/export.json`;

  const ownerView = await fetch(lifecycleUrl, { headers: { cookie: ownerCookie } });
  assert.equal(ownerView.status, 200);
  const ownerHtml = await ownerView.text();
  assert.match(ownerHtml, /Status: Active/);
  assert.match(ownerHtml, /does not erase project data/i);

  const editorView = await fetch(lifecycleUrl, { headers: { cookie: editorCookie } });
  const outsiderView = await fetch(lifecycleUrl, { headers: { cookie: outsiderCookie } });
  assert.equal(editorView.status, 404);
  assert.equal(outsiderView.status, 404);
  assert.equal(await editorView.text(), await outsiderView.text());
  assert.equal((await fetch(exportUrl, { headers: { cookie: editorCookie } })).status, 404);

  const exportedResponse = await fetch(exportUrl, { headers: { cookie: ownerCookie } });
  assert.equal(exportedResponse.status, 200);
  assert.equal(exportedResponse.headers.get("cache-control"), "no-store");
  assert.match(exportedResponse.headers.get("content-disposition"), /^attachment;/);
  const exportedText = await exportedResponse.text();
  const exported = JSON.parse(exportedText);
  assert.equal(exported.format, "alice.project-export");
  assert.equal(exported.version, 1);
  assert.equal(exported.project.brief, undefined);
  assert.match(exported.scope, /omitted without names or counts/i);
  assert.ok(exported.contexts.some(({ name }) => name === "General"));
  assert.doesNotMatch(exportedText, /Restricted launch secret|KESTREL/);
  assert.doesNotMatch(exportedText, /Editor's private secret|ORIOLE/);
  assert.doesNotMatch(
    exportedText,
    /storage_key|storage_version|signed_url|exact_payload|idempotency_key/,
  );

  const initial = await getProjectLifecycle(created.database, {
    userId: ownerUser.id,
    projectId,
  });
  const deniedArchive = await postLifecycle("/archive", editorCookie, {
    expected_preview_version: initial.preview_version,
  });
  assert.equal(deniedArchive.status, 404);
  const staleArchive = await postLifecycle("/archive", ownerCookie, {
    expected_preview_version: "stale-preview",
  });
  assert.equal(staleArchive.status, 409);
  assert.match(await staleArchive.text(), /Reload before continuing/);

  const archived = await postLifecycle("/archive", ownerCookie, {
    expected_preview_version: initial.preview_version,
  });
  assert.equal(archived.status, 303);
  assert.equal(archived.headers.get("location"), `/projects/${projectId}/lifecycle`);
  assert.equal(
    (await fetch(`${baseUrl}/projects/${projectId}`, { headers: { cookie: ownerCookie } })).status,
    404,
  );
  const homeHtml = await (await fetch(baseUrl, { headers: { cookie: ownerCookie } })).text();
  assert.match(homeHtml, /Archived projects you own/);
  assert.match(homeHtml, /Lifecycle safety project/);
  assert.equal(
    await getProjectInvitationPreview(created.database, ownerUser.id, pendingInvitation.token),
    undefined,
  );
  assert.ok(
    created.database
      .prepare("SELECT revoked_at FROM project_invitations WHERE id = ?")
      .get(pendingInvitation.id).revoked_at,
  );
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM active_connection_targets WHERE project_id = ?")
      .get(projectId).count,
    0,
  );
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM work_contexts WHERE project_id = ?")
      .get(projectId).count,
    4,
  );
  assert.equal((await fetch(exportUrl, { headers: { cookie: ownerCookie } })).status, 200);

  const archivedView = await getProjectLifecycle(created.database, {
    userId: ownerUser.id,
    projectId,
  });
  const badConfirmation = await postLifecycle("/deletion-request", ownerCookie, {
    expected_preview_version: archivedView.preview_version,
    confirmation: "wrong project",
  });
  assert.equal(badConfirmation.status, 409);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM project_deletion_requests").get().count,
    0,
  );
  const requested = await postLifecycle("/deletion-request", ownerCookie, {
    expected_preview_version: archivedView.preview_version,
    confirmation: "Lifecycle safety project",
  });
  assert.equal(requested.status, 303);
  const requestRow = created.database
    .prepare("SELECT * FROM project_deletion_requests WHERE project_id = ?")
    .get(projectId);
  assert.ok(
    Date.parse(requestRow.not_before) - Date.parse(requestRow.requested_at) >= 7 * 86400000,
  );

  const pendingPage = await fetch(lifecycleUrl, { headers: { cookie: ownerCookie } });
  const pendingHtml = await pendingPage.text();
  assert.match(pendingHtml, /has not been permanently deleted/i);
  assert.match(pendingHtml, /provider backups remain present/i);
  const pendingView = await getProjectLifecycle(created.database, {
    userId: ownerUser.id,
    projectId,
  });
  const blockedRestore = await postLifecycle("/restore", ownerCookie, {
    expected_preview_version: pendingView.preview_version,
  });
  assert.equal(blockedRestore.status, 409);
  assert.match(await blockedRestore.text(), /Cancel the permanent-deletion request/);

  const cancelled = await postLifecycle("/deletion-request/cancel", ownerCookie, {
    expected_preview_version: pendingView.preview_version,
  });
  assert.equal(cancelled.status, 303);
  const cancelledRow = created.database
    .prepare("SELECT * FROM project_deletion_requests WHERE id = ?")
    .get(requestRow.id);
  assert.ok(cancelledRow.cancelled_at);
  assert.throws(() =>
    created.database
      .prepare("UPDATE project_deletion_requests SET requested_at = ? WHERE id = ?")
      .run(new Date().toISOString(), requestRow.id),
  );
  assert.throws(() =>
    created.database
      .prepare("DELETE FROM project_deletion_requests WHERE id = ?")
      .run(requestRow.id),
  );

  const cancellledView = await getProjectLifecycle(created.database, {
    userId: ownerUser.id,
    projectId,
  });
  const restored = await postLifecycle("/restore", ownerCookie, {
    expected_preview_version: cancellledView.preview_version,
  });
  assert.equal(restored.status, 303);
  assert.equal(
    (await fetch(`${baseUrl}/projects/${projectId}`, { headers: { cookie: ownerCookie } })).status,
    200,
  );
  assert.throws(() => created.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId));

  const actions = created.database
    .prepare("SELECT action FROM audit_events WHERE project_id = ? ORDER BY created_at, id")
    .all(projectId)
    .map(({ action }) => action);
  for (const action of [
    "project_archived",
    "project_deletion_requested",
    "project_deletion_cancelled",
    "project_restored",
  ]) {
    assert.ok(actions.includes(action));
  }
});
