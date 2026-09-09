import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  cancelCapturedUpdate,
  confirmCapturedUpdate,
  createUserSession,
  getCapturePreview,
  getProjectContext,
  getRemovalPreview,
  removeSavedContextEntry,
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

async function capture(idempotencyKey, contextId, stateKey, value, provider = "chatgpt") {
  const claude = provider === "claude";
  return saveCandidateUpdate(created.database, {
    clientId: claude ? "claude-saved-context-client" : "saved-context-client",
    connectionId: claude ? "claude-saved-context-connection" : "saved-context-connection",
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
       VALUES ('saved-context-client', 'ChatGPT saved context fixture', '[]', 'none', ?)`,
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
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('claude-saved-context-client', 'Claude saved context fixture', '[]', 'none', ?)`,
    )
    .run(now);
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('claude-saved-context-connection', ?, ?, 'claude-saved-context-client', 'claude',
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
    {
      outcome: "**Approved launch direction** <b>from Claude</b>",
      approved: true,
      next_steps: ["Invite the team", "[Review launch](https://example.invalid)"],
    },
    "claude",
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

test("legacy saved-information links open the project change log", async () => {
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
  assert.match(html, /data-app-shell/);
  assert.match(html, /Latest changes/);
  assert.match(html, /Visible saved value/);
  assert.match(html, /Visible pending value|Visible not-saved value/);
  assert.doesNotMatch(html, />General|context_id=/);
});

test("Needs attention links to the exact preview and History explains prior outcomes", async () => {
  const attention = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=attention`,
    { headers: { cookie } },
  );
  const attentionHtml = await attention.text();
  assert.match(attentionHtml, /Visible pending value/);
  assert.match(attentionHtml, new RegExp(`/review/captures/${pendingEvidenceId}`));
  assert.match(attentionHtml, /Visible saved value|Visible not-saved value/);

  const removed = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=removed`,
    { headers: { cookie } },
  );
  assert.match(await removed.text(), /Latest changes/);

  const history = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=history`,
    { headers: { cookie } },
  );
  const historyHtml = await history.text();
  assert.match(historyHtml, /Visible saved value/);
  assert.match(historyHtml, /Visible pending value/);
  assert.match(historyHtml, /Visible not-saved value/);
  assert.match(historyHtml, /Saved/);
  assert.match(historyHtml, /Proposed/);
  assert.match(historyHtml, /Not saved/);
});

test("context switching is explicit and guessed context identifiers reveal nothing", async () => {
  const projectWide = await fetch(`${baseUrl}/projects/${owner.project_id}/saved-context`, {
    headers: { cookie },
  });
  const projectWideHtml = await projectWide.text();
  assert.match(projectWideHtml, /Approved launch direction/);
  assert.match(projectWideHtml, /Visible saved value/);
  assert.match(projectWideHtml, /Change log/);
  assert.doesNotMatch(projectWideHtml, /aria-label="Project contexts"/);
  assert.doesNotMatch(projectWideHtml, /aria-label="Context views"/);

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

test("the project page exposes one project-level change log", async () => {
  const project = await fetch(`${baseUrl}/projects/${owner.project_id}`, {
    headers: { cookie },
  });
  const html = await project.text();
  assert.match(html, new RegExp(`/projects/${owner.project_id}/changes`));
  assert.match(html, /Change log/);
  assert.doesNotMatch(html, /What alice\. knows/);
  assert.doesNotMatch(html, /context_id=/);
  assert.doesNotMatch(html, /Create a work context|Work context|Project-wide/);
});

test("change log renders readable updates with AI sources and browser-local times", async () => {
  const response = await fetch(`${baseUrl}/projects/${owner.project_id}/changes`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>Private project<\/h1>/);
  assert.match(html, /Latest changes/);
  assert.match(html, /From ChatGPT/);
  assert.match(html, /From Claude/);
  assert.match(html, /Visible saved value/);
  assert.match(html, /Approved launch direction from Claude/);
  assert.match(html, /Approved<\/dt><dd><p>Yes<\/p>/);
  assert.match(html, /Next steps/);
  assert.match(html, /Review launch/);
  assert.match(html, /<time datetime="\d{4}-\d{2}-\d{2}T[^"]+" data-local-time>/);
  assert.match(html, /Intl\.DateTimeFormat\(undefined/);
  assert.doesNotMatch(html, /<pre>|\*\*|&lt;b&gt;|\]\(https:\/\/example\.invalid\)/);
  assert.doesNotMatch(html, /Evidence receipt|Payload hash|context_id=|Project-wide|>General</);
});

test("an exact human removal stops consumption without erasing provenance", async () => {
  const accepted = created.database
    .prepare(
      `SELECT id FROM accepted_project_state
       WHERE project_id = ? AND state_key = 'launch.saved_item'`,
    )
    .get(owner.project_id);
  const acceptedCountBefore = created.database
    .prepare("SELECT COUNT(*) AS count FROM accepted_project_state")
    .get().count;
  const previewResponse = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context/${accepted.id}/remove?context_id=${general.id}`,
    { headers: { cookie } },
  );
  assert.equal(previewResponse.status, 200);
  const previewHtml = await previewResponse.text();
  assert.match(previewHtml, /Remove this from the project\?/);
  assert.doesNotMatch(previewHtml, />General/);
  assert.match(previewHtml, /Visible saved value/);
  assert.match(previewHtml, /does not erase the saved version/);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM context_entry_exclusions").get().count,
    0,
  );
  const previewVersion = previewHtml.match(/name="preview_version" value="([^"]+)"/)[1];

  const stale = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context/${accepted.id}/remove`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        context_id: general.id,
        preview_version: "removal_preview_stale",
      }),
      redirect: "manual",
    },
  );
  assert.equal(stale.status, 409);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM context_entry_exclusions").get().count,
    0,
  );

  const contextUpdatedBefore = created.database
    .prepare("SELECT updated_at FROM work_contexts WHERE id = ?")
    .get(general.id).updated_at;
  created.database.exec(`
    CREATE TRIGGER force_removal_audit_failure
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'saved_context_removed'
    BEGIN
      SELECT RAISE(ABORT, 'forced saved-context removal audit failure');
    END;
  `);
  const failedAudit = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context/${accepted.id}/remove`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        context_id: general.id,
        preview_version: previewVersion,
        reason: "This transaction must roll back.",
      }),
      redirect: "manual",
    },
  );
  assert.equal(failedAudit.status, 400);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM context_entry_exclusions").get().count,
    0,
  );
  assert.equal(
    created.database
      .prepare(
        "SELECT COUNT(*) AS count FROM context_history_events WHERE action = 'context_entry_removed'",
      )
      .get().count,
    0,
  );
  assert.equal(
    created.database.prepare("SELECT updated_at FROM work_contexts WHERE id = ?").get(general.id)
      .updated_at,
    contextUpdatedBefore,
  );
  created.database.exec("DROP TRIGGER force_removal_audit_failure");

  const remove = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context/${accepted.id}/remove`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        context_id: general.id,
        preview_version: previewVersion,
        reason: "No longer part of the launch plan.",
      }),
      redirect: "manual",
    },
  );
  assert.equal(remove.status, 303);
  assert.equal(remove.headers.get("location"), `/projects/${owner.project_id}/changes`);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    acceptedCountBefore,
  );
  const exclusion = created.database.prepare("SELECT * FROM context_entry_exclusions").get();
  assert.equal(exclusion.accepted_state_id, accepted.id);
  assert.equal(exclusion.reason, "No longer part of the launch plan.");
  assert.throws(
    () =>
      created.database
        .prepare("UPDATE context_entry_exclusions SET reason = 'rewritten' WHERE id = ?")
        .run(exclusion.id),
    /immutable/,
  );

  const saved = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}`,
    { headers: { cookie } },
  );
  const savedHtml = await saved.text();
  assert.match(savedHtml, /Removed/);
  assert.match(savedHtml, /Visible saved value/);
  const removed = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=removed`,
    { headers: { cookie } },
  );
  const removedHtml = await removed.text();
  assert.match(removedHtml, /Visible saved value/);
  assert.match(removedHtml, /No longer part of the launch plan/);

  const context = await getProjectContext(created.database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: general.id,
    task: "Continue the launch plan",
    contextBudget: 4_000,
  });
  assert.doesNotMatch(JSON.stringify(context), /Visible saved value/);
  assert.match(JSON.stringify(context), /Approved launch direction/);

  const domainPreview = await getRemovalPreview(created.database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: general.id,
    acceptedStateId: accepted.id,
  });
  assert.equal(domainPreview, undefined);
  const repeated = await removeSavedContextEntry(created.database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: general.id,
    acceptedStateId: accepted.id,
    expectedPreviewVersion: previewVersion,
  });
  assert.equal(repeated, undefined);

  const restoration = await capture(
    "saved-context-restoration",
    general.id,
    "launch.saved_item",
    "Restored saved value",
  );
  const restorationPreview = await getCapturePreview(created.database, {
    evidenceId: restoration.evidence_id,
    userId: owner.id,
  });
  assert.equal(restorationPreview.candidates[0].current.id, accepted.id);
  assert.equal(restorationPreview.candidates[0].current.removed_at, exclusion.removed_at);
  const restorationPage = await fetch(`${baseUrl}/review/captures/${restoration.evidence_id}`, {
    headers: { cookie },
  });
  assert.match(await restorationPage.text(), /Will restore removed key as a new saved version/);
  await confirmCapturedUpdate(created.database, {
    evidenceId: restoration.evidence_id,
    expectedPreviewVersion: restorationPreview.preview_version,
    userId: owner.id,
  });
  const restoredView = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}`,
    { headers: { cookie } },
  );
  const restoredHtml = await restoredView.text();
  assert.match(restoredHtml, /Restored saved value/);
  assert.match(restoredHtml, /Visible saved value/);
  assert.match(restoredHtml, /Removed|Replaced/);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM context_entry_exclusions").get().count,
    1,
  );
});

test("an exact repair classifies stale context and removes it without rewriting provenance", async () => {
  const repair = await capture(
    "saved-context-repair-stale",
    general.id,
    "launch.repair_item",
    "Outdated launch date",
  );
  const savePreview = await getCapturePreview(created.database, {
    evidenceId: repair.evidence_id,
    userId: owner.id,
  });
  const confirmed = await confirmCapturedUpdate(created.database, {
    evidenceId: repair.evidence_id,
    expectedPreviewVersion: savePreview.preview_version,
    userId: owner.id,
  });
  const accepted = confirmed.accepted[0];
  const acceptedCount = created.database
    .prepare("SELECT COUNT(*) AS count FROM accepted_project_state")
    .get().count;

  const previewResponse = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context/${accepted.acceptedStateId}/repair?context_id=${general.id}`,
    { headers: { cookie } },
  );
  assert.equal(previewResponse.status, 200);
  const previewHtml = await previewResponse.text();
  assert.match(previewHtml, /What needs to change\?/);
  assert.doesNotMatch(previewHtml, />General/);
  assert.match(previewHtml, /Outdated launch date/);
  assert.match(previewHtml, /Stale: it is no longer current/);
  assert.match(previewHtml, /corrected value must arrive as a new proposal/i);
  const previewVersion = previewHtml.match(/name="preview_version" value="([^"]+)"/)[1];

  const invalid = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context/${accepted.acceptedStateId}/repair`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        context_id: general.id,
        preview_version: previewVersion,
        repair_type: "silently_rewrite",
      }),
      redirect: "manual",
    },
  );
  assert.equal(invalid.status, 400);

  const response = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context/${accepted.acceptedStateId}/repair`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        context_id: general.id,
        preview_version: previewVersion,
        repair_type: "stale",
        note: "Launch moved to October.",
      }),
      redirect: "manual",
    },
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `/projects/${owner.project_id}/changes`);
  const exclusion = created.database
    .prepare("SELECT reason FROM context_entry_exclusions WHERE accepted_state_id = ?")
    .get(accepted.acceptedStateId);
  assert.equal(exclusion.reason, "Stale: Launch moved to October.");
  const repairAudit = created.database
    .prepare(
      `SELECT safe_metadata_json FROM audit_events
       WHERE action = 'saved_context_removed'`,
    )
    .all()
    .find(
      ({ safe_metadata_json: metadata }) =>
        JSON.parse(metadata).accepted_state_id === accepted.acceptedStateId,
    );
  const repairMetadata = JSON.parse(repairAudit.safe_metadata_json);
  assert.equal(repairMetadata.repair_type, "stale");
  assert.doesNotMatch(repairAudit.safe_metadata_json, /Launch moved to October/);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    acceptedCount,
  );
  const active = await getProjectContext(created.database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: general.id,
    task: "Plan launch",
    contextBudget: 8_000,
  });
  assert.doesNotMatch(JSON.stringify(active), /Outdated launch date/);
  const removed = await fetch(`${baseUrl}${response.headers.get("location")}`, {
    headers: { cookie },
  });
  assert.match(await removed.text(), /Stale: Launch moved to October/);
});

test("history labels an older accepted value as superseded by its replacement version", async () => {
  const first = await capture(
    "saved-context-superseded-first",
    general.id,
    "launch.superseded_item",
    "First positioning",
  );
  const firstPreview = await getCapturePreview(created.database, {
    evidenceId: first.evidence_id,
    userId: owner.id,
  });
  await confirmCapturedUpdate(created.database, {
    evidenceId: first.evidence_id,
    expectedPreviewVersion: firstPreview.preview_version,
    userId: owner.id,
  });
  const replacement = await capture(
    "saved-context-superseded-replacement",
    general.id,
    "launch.superseded_item",
    "Replacement positioning",
  );
  const replacementPreview = await getCapturePreview(created.database, {
    evidenceId: replacement.evidence_id,
    userId: owner.id,
  });
  await confirmCapturedUpdate(created.database, {
    evidenceId: replacement.evidence_id,
    expectedPreviewVersion: replacementPreview.preview_version,
    userId: owner.id,
  });
  const history = await fetch(
    `${baseUrl}/projects/${owner.project_id}/saved-context?context_id=${general.id}&view=history`,
    { headers: { cookie } },
  );
  const html = await history.text();
  assert.match(html, /Replaced/);
  assert.match(html, /First positioning/);
  assert.match(html, /Replacement positioning/);
});
