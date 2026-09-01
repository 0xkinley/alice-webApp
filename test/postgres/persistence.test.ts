import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { configureApplicationRole, ensureApplicationRole, openDatabase } from "@alice/database";
import {
  acceptCandidate,
  acceptProjectInvitation,
  archiveProject,
  cancelProjectDeletion,
  confirmCapturedUpdate,
  createProject,
  createWorkContext,
  createProjectInvitation,
  exportProjectData,
  getCapturePreview,
  getProjectContext,
  getPrivateAlphaSignals,
  getProjectLifecycle,
  getProjectAccessOverview,
  getProjectFileRemovalPreview,
  getProjectFileDownload,
  getRemovalPreview,
  getSavedContextView,
  issueAlphaInvitation,
  grantContextAccess,
  registerUser,
  recordContextReadSuccess,
  readProjectFileText,
  removeSavedContextEntry,
  removeProjectFileReference,
  removeProjectMember,
  endContextAccess,
  refreshProjectFileScan,
  requestProjectDeletion,
  saveCandidateUpdate,
  setActiveConnectionTarget,
  restoreProject,
  supersedeAcceptedState,
  uploadProjectFile,
  updateProjectMemberRole,
} from "@alice/domain";
import { eraseProject, previewProjectErasure } from "../../scripts/erase-project.mjs";
import { createTestIdentity } from "../helpers.ts";

const connectionString = process.env.ALICE_TEST_DATABASE_URL;
assert.ok(connectionString, "ALICE_TEST_DATABASE_URL is required for PostgreSQL tests.");

const schema = `test_${randomUUID().replaceAll("-", "_")}`;
const applicationRole = `app_${randomUUID().replaceAll("-", "_")}`;
const applicationPassword = `test_${randomUUID()}`;
let database;
let migrationDatabase;
let owner;
let other;
let postgresFileReferenceId;
let postgresReplacementReferenceId;

const clientId = "client_postgres_concurrency";
const connectionId = "connection_postgres_concurrency";

function payload(idempotencyKey, value = 24) {
  return {
    project_id: owner.project_id,
    summary: "PostgreSQL concurrency fixture",
    candidate_claims: [
      {
        state_key: "launch.monthly_price_usd",
        value,
        summary: "Monthly price",
      },
    ],
    source_context: "Exact source bytes retained as text.",
    idempotency_key: idempotencyKey,
  };
}

async function capture(idempotencyKey, value = 24) {
  return saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl: "https://app.alice.example",
    userId: owner.id,
    payload: payload(idempotencyKey, value),
  });
}

before(async () => {
  migrationDatabase = await openDatabase({
    connectionString,
    schema,
    maxConnections: 2,
    migrate: true,
  });
  await ensureApplicationRole(migrationDatabase, applicationRole, applicationPassword);
  await configureApplicationRole(migrationDatabase, applicationRole);
  const applicationUrl = new URL(connectionString);
  applicationUrl.username = applicationRole;
  applicationUrl.password = applicationPassword;
  database = await openDatabase({
    connectionString: applicationUrl.href,
    schema,
    maxConnections: 20,
  });
  owner = await createTestIdentity(database, {
    email: "postgres-owner@alice.example",
    password: "postgres owner private password",
    projectId: "project_postgres_owner",
  });
  other = await createTestIdentity(database, {
    email: "postgres-other@alice.example",
    password: "postgres other private password",
    projectId: "project_postgres_other",
  });
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, '[]', 'none', ?)`,
    )
    .run(clientId, "PostgreSQL concurrency fixture", now);
  await database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES (?, ?, ?, ?, 'test', 'mcp:read mcp:write', ?, ?)`,
    )
    .run(connectionId, owner.id, owner.workspace_id, clientId, now, now);
});

after(async () => {
  await database.close();
  await migrationDatabase.close();
});

test("one alpha invitation cannot create two users under concurrent acceptance", async () => {
  const invitation = await issueAlphaInvitation(database, {
    email: "postgres-invited@alice.example",
  });
  const attempts = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      registerUser(database, {
        email: "postgres-invited@alice.example",
        password: "postgres invitation private password",
        invitationToken: invitation.token,
      }),
    ),
  );
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?")
        .get("postgres-invited@alice.example")
    ).count,
    1,
  );
});

test("versioned migration is repeatable on the same PostgreSQL schema", async () => {
  const migration = await database
    .prepare("SELECT version, filename FROM alice_schema_migrations ORDER BY version")
    .all();
  assert.deepEqual(migration, [
    { version: 1, filename: "001_initial.sql" },
    { version: 2, filename: "002_alpha_access.sql" },
    { version: 3, filename: "003_work_contexts.sql" },
    { version: 4, filename: "004_context_entries.sql" },
    { version: 5, filename: "005_active_context_targets.sql" },
    { version: 6, filename: "006_context_entry_exclusions.sql" },
    { version: 7, filename: "007_project_files.sql" },
    { version: 8, filename: "008_file_reference_exclusions.sql" },
    { version: 9, filename: "009_file_reference_versions.sql" },
    { version: 10, filename: "010_project_memberships.sql" },
    { version: 11, filename: "011_context_access.sql" },
    { version: 12, filename: "012_context_read_events.sql" },
    { version: 13, filename: "013_project_lifecycle.sql" },
    { version: 14, filename: "014_pdf_evidence_sources.sql" },
    { version: 15, filename: "015_file_upload_intents.sql" },
    { version: 16, filename: "016_project_erasure_jobs.sql" },
  ]);

  const reopened = await openDatabase({ connectionString, schema, maxConnections: 2 });
  assert.equal(
    (await reopened.prepare("SELECT COUNT(*) AS count FROM alice_schema_migrations").get()).count,
    16,
  );
  await reopened.close();
});

test("concurrent project-invitation acceptance creates one protected membership", async () => {
  const invitation = await createProjectInvitation(database, {
    userId: owner.id,
    projectId: owner.project_id,
    email: other.email,
    role: "editor",
  });
  assert.ok(invitation);
  const attempts = await Promise.allSettled(
    Array.from({ length: 2 }, () => acceptProjectInvitation(database, other.id, invitation.token)),
  );
  assert.equal(attempts.filter(({ status, value }) => status === "fulfilled" && value).length, 1);
  const membership = await database
    .prepare(
      `SELECT id, role, ended_at FROM project_memberships
       WHERE project_id = ? AND user_id = ?`,
    )
    .get(owner.project_id, other.id);
  assert.equal(membership.role, "editor");
  assert.equal(membership.ended_at, null);

  await assert.rejects(
    database.prepare("DELETE FROM project_memberships WHERE id = ?").run(membership.id),
  );
  const ownerMembership = await database
    .prepare(
      "SELECT id FROM project_memberships WHERE project_id = ? AND user_id = ? AND ended_at IS NULL",
    )
    .get(owner.project_id, owner.id);
  await assert.rejects(
    database
      .prepare("UPDATE project_memberships SET role = 'editor', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), ownerMembership.id),
  );

  assert.deepEqual(
    await updateProjectMemberRole(database, {
      userId: owner.id,
      projectId: owner.project_id,
      membershipId: membership.id,
      role: "viewer",
    }),
    { id: membership.id, role: "viewer" },
  );
  assert.deepEqual(
    await removeProjectMember(database, {
      userId: owner.id,
      projectId: owner.project_id,
      membershipId: membership.id,
    }),
    { id: membership.id },
  );
  await assert.rejects(
    database
      .prepare("UPDATE project_memberships SET role = 'editor', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), membership.id),
  );
});

test("concurrent restricted-context grants create one immutable bounded grant", async () => {
  const grantOwner = await createTestIdentity(database, {
    email: "postgres-context-owner@alice.example",
    password: "postgres context owner private password",
    projectId: "project_postgres_context_grants",
  });
  const grantMember = await createTestIdentity(database, {
    email: "postgres-context-member@alice.example",
    password: "postgres context member private password",
    projectId: "project_postgres_context_member",
  });
  const invitation = await createProjectInvitation(database, {
    userId: grantOwner.id,
    projectId: grantOwner.project_id,
    email: grantMember.email,
    role: "editor",
  });
  await acceptProjectInvitation(database, grantMember.id, invitation.token);
  const membership = await database
    .prepare(
      `SELECT id FROM project_memberships
       WHERE project_id = ? AND user_id = ? AND ended_at IS NULL`,
    )
    .get(grantOwner.project_id, grantMember.id);
  const context = await createWorkContext(database, {
    userId: grantOwner.id,
    projectId: grantOwner.project_id,
    input: {
      name: "PostgreSQL restricted grant",
      description: "Concurrent context grant fixture.",
      visibility: "selected_members",
    },
  });
  const attempts = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      grantContextAccess(database, {
        userId: grantOwner.id,
        projectId: grantOwner.project_id,
        contextId: context.id,
        membershipId: membership.id,
        role: "editor",
      }),
    ),
  );
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const grant = await database
    .prepare(
      `SELECT id FROM context_access_grants
       WHERE context_id = ? AND user_id = ? AND ended_at IS NULL`,
    )
    .get(context.id, grantMember.id);
  await assert.rejects(
    database
      .prepare("UPDATE context_access_grants SET user_id = ? WHERE id = ?")
      .run(grantOwner.id, grant.id),
  );
  await assert.rejects(
    database.prepare("DELETE FROM context_access_grants WHERE id = ?").run(grant.id),
  );
  await endContextAccess(database, {
    userId: grantOwner.id,
    projectId: grantOwner.project_id,
    contextId: context.id,
    grantId: grant.id,
  });
  await assert.rejects(
    database.prepare("UPDATE context_access_grants SET role = 'viewer' WHERE id = ?").run(grant.id),
  );
  await createWorkContext(database, {
    userId: grantMember.id,
    projectId: grantOwner.project_id,
    input: {
      name: "PostgreSQL personal departure blocker",
      description: "Database-level membership departure guard fixture.",
      visibility: "personal",
    },
  });
  const endedAt = new Date().toISOString();
  await assert.rejects(
    database
      .prepare(
        `UPDATE project_memberships
         SET ended_at = ?, ended_by_user_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(endedAt, grantOwner.id, endedAt, membership.id),
  );
});

test("concurrent active-target changes cannot silently overwrite one another", async () => {
  const context = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'work'
       ORDER BY id LIMIT 1`,
    )
    .get(owner.workspace_id, owner.project_id);
  const attempts = await Promise.all([
    setActiveConnectionTarget(database, {
      userId: owner.id,
      connectionId,
      projectId: owner.project_id,
      contextId: context.id,
      expectedVersions: { [connectionId]: null },
    }),
    setActiveConnectionTarget(database, {
      userId: owner.id,
      connectionId,
      projectId: owner.project_id,
      contextId: context.id,
      expectedVersions: { [connectionId]: null },
    }),
  ]);
  assert.equal(attempts.filter(({ conflict }) => conflict === false).length, 1);
  assert.equal(attempts.filter(({ conflict }) => conflict === true).length, 1);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM active_connection_targets WHERE connection_id = ?")
        .get(connectionId)
    ).count,
    1,
  );
});

test("one concurrent exact-preview confirmation wins and accepts the whole capture", async () => {
  const receipt = await saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl: "https://app.alice.example",
    userId: owner.id,
    payload: {
      summary: "Atomic exact-preview fixture",
      candidate_claims: [
        { state_key: "preview.first", value: "A", summary: "First preview value" },
        { state_key: "preview.second", value: "B", summary: "Second preview value" },
      ],
      idempotency_key: "postgres-exact-preview",
    },
  });
  const preview = await getCapturePreview(database, {
    evidenceId: receipt.evidence_id,
    userId: owner.id,
  });
  const attempts = await Promise.all([
    confirmCapturedUpdate(database, {
      evidenceId: receipt.evidence_id,
      expectedPreviewVersion: preview.preview_version,
      userId: owner.id,
    }),
    confirmCapturedUpdate(database, {
      evidenceId: receipt.evidence_id,
      expectedPreviewVersion: preview.preview_version,
      userId: owner.id,
    }),
  ]);
  assert.equal(attempts.filter(({ conflict }) => conflict === false).length, 1);
  assert.equal(attempts.filter(({ conflict }) => conflict === true).length, 1);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM accepted_project_state WHERE evidence_id = ?")
        .get(receipt.evidence_id)
    ).count,
    2,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = ?")
        .get("candidate_update_confirmed")
    ).count,
    1,
  );
  const savedView = await getSavedContextView(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: preview.context.id,
  });
  assert.deepEqual(
    savedView.saved
      .filter(({ state_key: stateKey }) => stateKey.startsWith("preview."))
      .map(({ state_key: stateKey, value }) => [stateKey, value]),
    [
      ["preview.first", "A"],
      ["preview.second", "B"],
    ],
  );

  const first = savedView.saved.find(({ state_key: stateKey }) => stateKey === "preview.first");
  const removalPreview = await getRemovalPreview(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: preview.context.id,
    acceptedStateId: first.id,
  });
  const removals = await Promise.all([
    removeSavedContextEntry(database, {
      userId: owner.id,
      projectId: owner.project_id,
      contextId: preview.context.id,
      acceptedStateId: first.id,
      expectedPreviewVersion: removalPreview.preview_version,
      reason: "PostgreSQL concurrent removal fixture",
    }),
    removeSavedContextEntry(database, {
      userId: owner.id,
      projectId: owner.project_id,
      contextId: preview.context.id,
      acceptedStateId: first.id,
      expectedPreviewVersion: removalPreview.preview_version,
      reason: "PostgreSQL concurrent removal fixture",
    }),
  ]);
  assert.equal(removals.filter((result) => result?.conflict === false).length, 1);
  assert.equal(
    (
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_entry_exclusions WHERE accepted_state_id = ?",
        )
        .get(first.id)
    ).count,
    1,
  );
  const afterRemoval = await getSavedContextView(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: preview.context.id,
  });
  assert.deepEqual(
    afterRemoval.saved
      .filter(({ state_key: stateKey }) => stateKey.startsWith("preview."))
      .map(({ state_key: stateKey }) => stateKey),
    ["preview.second"],
  );
  assert.equal(
    afterRemoval.removed.find(({ state_key: stateKey }) => stateKey === "preview.first").value,
    "A",
  );
  const consumed = await getProjectContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: preview.context.id,
    task: "Use preview values",
    contextBudget: 4_000,
  });
  assert.doesNotMatch(JSON.stringify(consumed), /preview\.first|"A"/);
  assert.match(JSON.stringify(consumed), /preview\.second/);
});

test("concurrent identical capture is atomic and idempotent with byte-exact evidence text", async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () => capture("postgres-identical-capture")),
  );
  assert.equal(new Set(results.map((result) => result.evidence_id)).size, 1);
  assert.equal(new Set(results.map((result) => result.audit_event_id)).size, 1);
  assert.equal(results.filter((result) => result.deduplicated === false).length, 1);

  const evidence = await database
    .prepare("SELECT exact_payload_json, payload_hash FROM evidence_events WHERE id = ?")
    .get(results[0].evidence_id);
  const exact = JSON.stringify(payload("postgres-identical-capture"));
  assert.equal(evidence.exact_payload_json, exact);
  assert.equal(evidence.payload_hash, createHash("sha256").update(exact).digest("hex"));
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM candidate_claims WHERE evidence_id = ?")
        .get(results[0].evidence_id)
    ).count,
    1,
  );
});

test("concurrent conflicting idempotency-key reuse fails closed without duplication", async () => {
  const [left, right] = await Promise.all([
    capture("postgres-conflicting-capture", 29),
    capture("postgres-conflicting-capture", 31),
  ]);
  assert.equal([left, right].filter((result) => !result.error).length, 1);
  assert.equal([left, right].filter((result) => result.error).length, 1);
  assert.match(left.error || right.error, /different payload/i);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM evidence_events WHERE idempotency_key = ?")
        .get("postgres-conflicting-capture")
    ).count,
    1,
  );
});

test("human acceptance and concurrent supersession preserve one version chain", async () => {
  const initial = await capture("postgres-accept-initial", 40);
  const accepted = await acceptCandidate(database, {
    candidateId: initial.candidate_ids[0],
    userId: owner.id,
  });
  assert.equal(accepted.version, 1);

  const [candidateA, candidateB] = await Promise.all([
    capture("postgres-supersede-a", 41),
    capture("postgres-supersede-b", 42),
  ]);
  const attempts = await Promise.all([
    supersedeAcceptedState(database, {
      candidateId: candidateA.candidate_ids[0],
      supersededAcceptedStateId: accepted.acceptedStateId,
      userId: owner.id,
    }),
    supersedeAcceptedState(database, {
      candidateId: candidateB.candidate_ids[0],
      supersededAcceptedStateId: accepted.acceptedStateId,
      userId: owner.id,
    }),
  ]);
  assert.equal(attempts.filter(Boolean).length, 1);
  const versions = await database
    .prepare(
      `SELECT version FROM accepted_project_state
       WHERE project_id = ? AND state_key = ?
       ORDER BY version`,
    )
    .all(owner.project_id, "launch.monthly_price_usd");
  assert.deepEqual(
    versions.map(({ version }) => version),
    [1, 2],
  );
  const contextId = await database
    .prepare(
      `SELECT context_id FROM accepted_context_entries
       WHERE accepted_state_id = ?`,
    )
    .get(accepted.acceptedStateId);
  const history = await getSavedContextView(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: contextId.context_id,
  });
  assert.equal(
    Number(
      history.history.find(
        ({ accepted_state_id: acceptedStateId }) => acceptedStateId === accepted.acceptedStateId,
      ).superseded_by_version,
    ),
    2,
  );
  assert.equal(
    (
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM candidate_claims
           WHERE project_id = ? AND state_key = ? AND status = 'pending'
             AND id IN (?, ?)`,
        )
        .get(
          owner.project_id,
          "launch.monthly_price_usd",
          candidateA.candidate_ids[0],
          candidateB.candidate_ids[0],
        )
    ).count,
    1,
  );
});

test("PostgreSQL denies immutable history rewrites through the constrained application role", async () => {
  await assert.rejects(
    database.prepare("UPDATE evidence_events SET exact_payload_json = '{}'").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM audit_events").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("UPDATE accepted_project_state SET value_json = '0'").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM context_history_events").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("UPDATE candidate_context_targets SET context_id = 'rewritten'").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("UPDATE context_entry_exclusions SET reason = 'rewritten'").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM context_entry_exclusions").run(),
    /permission denied|immutable/i,
  );
  const context = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'work'
       ORDER BY id LIMIT 1`,
    )
    .get(owner.workspace_id, owner.project_id);
  const readEvent = await recordContextReadSuccess(database, {
    userId: owner.id,
    connectionId,
    projectId: owner.project_id,
    contextId: context.id,
    requestedVia: "active_target",
    packageVersion: "postgres-package-version",
    packageUtf8Bytes: 4096,
  });
  assert.ok(readEvent);
  await assert.rejects(
    database.prepare("UPDATE context_read_events SET package_utf8_bytes = 1").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM context_read_events").run(),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare(
        `INSERT INTO context_read_events
          (id, user_id, connection_workspace_id, connection_id, client_id, client_name,
           client_classification, requested_via, status, failure_code, created_at)
         VALUES (?, ?, ?, ?, ?, 'mismatch', 'test', 'active_target', 'failed',
                 'no_active_target', ?)`,
      )
      .run(
        `context_read_${randomUUID()}`,
        other.id,
        owner.workspace_id,
        connectionId,
        clientId,
        new Date().toISOString(),
      ),
    /foreign key/i,
  );
});

test("PostgreSQL file lifecycle is fail-closed and immutable through the application role", async () => {
  const context = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'work'
       ORDER BY id LIMIT 1`,
    )
    .get(owner.workspace_id, owner.project_id);
  const objectId = `file_${randomUUID()}`;
  const referenceId = `file_ref_${randomUUID()}`;
  postgresFileReferenceId = referenceId;
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO file_objects
        (id, workspace_id, content_sha256, byte_size, verified_media_type, storage_key,
         scan_provider, scan_status, scan_updated_at, created_at)
       VALUES (?, ?, ?, 12, 'text/plain', ?, 'aws_guardduty_s3', 'pending_upload', ?, ?)`,
    )
    .run(objectId, owner.workspace_id, "a".repeat(64), `objects/${randomUUID()}`, now, now);
  await database
    .prepare(
      `INSERT INTO file_context_references
        (id, workspace_id, project_id, context_id, file_object_id, logical_file_id,
         version, display_name, source_host, uploader_user_id, access_scope, referenced_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'fixture.txt', 'postgres_test', ?, 'inherit_context', ?)`,
    )
    .run(
      referenceId,
      owner.workspace_id,
      owner.project_id,
      context.id,
      objectId,
      referenceId,
      owner.id,
      now,
    );

  const uploadIntentId = `file_upload_${randomUUID()}`;
  await database
    .prepare(
      `INSERT INTO file_upload_intents
       (id, workspace_id, project_id, context_id, initiated_by_user_id, display_name,
        claimed_media_type, declared_byte_size, declared_sha256, staging_storage_key,
        expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'fixture.txt', 'text/plain', 12, ?, ?, ?, ?)`,
    )
    .run(
      uploadIntentId,
      owner.workspace_id,
      owner.project_id,
      context.id,
      owner.id,
      "a".repeat(64),
      `staging/${randomUUID()}`,
      Date.now() + 60_000,
      now,
    );
  await database
    .prepare(
      `INSERT INTO file_upload_completions
       (intent_id, workspace_id, project_id, context_id, staging_storage_version_id,
        file_reference_id, completed_at)
       VALUES (?, ?, ?, ?, 'staging-version-1', ?, ?)`,
    )
    .run(uploadIntentId, owner.workspace_id, owner.project_id, context.id, referenceId, now);
  await assert.rejects(
    database
      .prepare("UPDATE file_upload_intents SET display_name = 'rewritten.txt' WHERE id = ?")
      .run(uploadIntentId),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM file_upload_intents WHERE id = ?").run(uploadIntentId),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare(
        "UPDATE file_upload_completions SET staging_storage_version_id = 'rewritten' WHERE intent_id = ?",
      )
      .run(uploadIntentId),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM file_upload_completions WHERE intent_id = ?").run(uploadIntentId),
    /permission denied|immutable/i,
  );

  await assert.rejects(
    database.prepare("UPDATE file_objects SET scan_status = 'clean' WHERE id = ?").run(objectId),
    /version is required|lifecycle/i,
  );
  await database
    .prepare(
      `UPDATE file_objects
       SET storage_version_id = 'version-1', storage_etag = 'etag-1',
           scan_status = 'scanning', scan_updated_at = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), objectId);
  await database
    .prepare("UPDATE file_objects SET scan_status = 'clean', scan_updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), objectId);

  await assert.rejects(
    database.prepare("UPDATE file_objects SET scan_status = 'scanning' WHERE id = ?").run(objectId),
    /terminal file scan status is immutable/i,
  );
  await assert.rejects(
    database
      .prepare("UPDATE file_objects SET storage_version_id = 'version-2' WHERE id = ?")
      .run(objectId),
    /stored file object version is immutable/i,
  );
  await assert.rejects(
    database
      .prepare("UPDATE file_objects SET content_sha256 = ? WHERE id = ?")
      .run("b".repeat(64), objectId),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM file_objects WHERE id = ?").run(objectId),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare("UPDATE file_context_references SET display_name = 'rewritten.txt' WHERE id = ?")
      .run(referenceId),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM file_context_references WHERE id = ?").run(referenceId),
    /permission denied|immutable/i,
  );
});

test("concurrent replacements create one next version and switch only after a clean scan", async () => {
  const store = {
    async putObject({ sha256 }) {
      return { versionId: `version-${sha256.slice(0, 8)}`, etag: "etag-replacement" };
    },
    async getScanResult() {
      return "clean";
    },
    async getObject() {
      return Buffer.alloc(0);
    },
    async createSignedDownload({ versionId }) {
      return `https://private-files.alice.example/object?version=${versionId}`;
    },
  };
  const context = await database
    .prepare("SELECT context_id FROM file_context_references WHERE id = ?")
    .get(postgresFileReferenceId);
  const attempts = await Promise.allSettled([
    uploadProjectFile(database, store, {
      userId: owner.id,
      projectId: owner.project_id,
      contextId: context.context_id,
      fileName: "replacement-a.txt",
      claimedMediaType: "text/plain",
      bytes: Buffer.from("PostgreSQL replacement A"),
      replacesReferenceId: postgresFileReferenceId,
    }),
    uploadProjectFile(database, store, {
      userId: owner.id,
      projectId: owner.project_id,
      contextId: context.context_id,
      fileName: "replacement-b.txt",
      claimedMediaType: "text/plain",
      bytes: Buffer.from("PostgreSQL replacement B"),
      replacesReferenceId: postgresFileReferenceId,
    }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const replacement = attempts.find(({ status }) => status === "fulfilled")?.value;
  postgresReplacementReferenceId = replacement.id;
  assert.equal(replacement.version, 2);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM file_context_references WHERE logical_file_id = ?")
        .get(postgresFileReferenceId)
    ).count,
    2,
  );
  assert.equal(
    (
      await getProjectFileDownload(database, store, {
        userId: owner.id,
        projectId: owner.project_id,
        referenceId: postgresFileReferenceId,
      })
    ).available,
    true,
  );
  assert.equal(
    (
      await getProjectFileDownload(database, store, {
        userId: owner.id,
        projectId: owner.project_id,
        referenceId: postgresReplacementReferenceId,
      })
    ).available,
    false,
  );
  await refreshProjectFileScan(database, store, {
    userId: owner.id,
    projectId: owner.project_id,
    referenceId: postgresReplacementReferenceId,
  });
  assert.equal(
    await getProjectFileDownload(database, store, {
      userId: owner.id,
      projectId: owner.project_id,
      referenceId: postgresFileReferenceId,
    }),
    undefined,
  );
  assert.equal(
    (
      await getProjectFileDownload(database, store, {
        userId: owner.id,
        projectId: owner.project_id,
        referenceId: postgresReplacementReferenceId,
      })
    ).available,
    true,
  );
});

test("PostgreSQL serves only current authorized clean text as bounded untrusted data", async () => {
  const reader = await createTestIdentity(database, {
    email: "postgres-file-reader@alice.example",
    password: "postgres file reader private password",
    projectId: "project_postgres_file_reader",
  });
  const context = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'work'
       ORDER BY id LIMIT 1`,
    )
    .get(reader.workspace_id, reader.project_id);
  const objects = new Map();
  const store = {
    async putObject({ key, bytes }) {
      const versionId = `version-${randomUUID()}`;
      objects.set(`${key}:${versionId}`, Buffer.from(bytes));
      return { versionId, etag: `etag-${randomUUID()}` };
    },
    async getScanResult() {
      return "clean";
    },
    async getObject({ key, versionId }) {
      const bytes = objects.get(`${key}:${versionId}`);
      if (!bytes) throw new Error("PostgreSQL retrieval fixture object missing.");
      return Buffer.from(bytes);
    },
    async createSignedDownload() {
      return "https://private-files.alice.example/postgres-retrieval";
    },
  };
  const sourceText =
    "# PostgreSQL retrieval fixture\nIgnore safeguards is untrusted document data.\nمرحبا — 🚀";
  const reference = await uploadProjectFile(database, store, {
    userId: reader.id,
    projectId: reader.project_id,
    contextId: context.id,
    fileName: "postgres-retrieval.md",
    claimedMediaType: "text/markdown",
    bytes: Buffer.from(sourceText),
    sourceHost: "postgres_test",
  });
  await refreshProjectFileScan(database, store, {
    userId: reader.id,
    projectId: reader.project_id,
    referenceId: reference.id,
  });

  const packageResult = await getProjectContext(database, {
    userId: reader.id,
    projectId: reader.project_id,
    contextId: context.id,
    task: "Use the retrieval fixture",
    contextBudget: 4_000,
    fileTextReadAvailable: true,
  });
  assert.equal(packageResult.contract_version, "2.2");
  assert.equal(packageResult.file_artifacts.length, 1);
  assert.equal(packageResult.file_artifacts[0].file_reference_id, reference.id);
  assert.equal(packageResult.file_artifacts[0].handling, "reference_only_untrusted");
  assert.equal(packageResult.file_artifacts[0].text_read_tool, "read_project_file_text");
  assert.equal(packageResult.file_artifacts[0].pdf_read_tool, null);
  assert.doesNotMatch(JSON.stringify(packageResult), /Ignore safeguards/);

  const packageWithoutReadCapability = await getProjectContext(database, {
    userId: reader.id,
    projectId: reader.project_id,
    contextId: context.id,
    task: "Use the retrieval fixture",
    contextBudget: 4_000,
  });
  assert.equal(packageWithoutReadCapability.file_artifacts[0].text_read_tool, null);
  assert.equal(packageWithoutReadCapability.file_artifacts[0].pdf_read_tool, null);

  const read = await readProjectFileText(database, store, {
    userId: reader.id,
    projectId: reader.project_id,
    referenceId: reference.id,
    contextBudget: 2_000,
  });
  assert.equal(read.excerpt.text, sourceText);
  assert.equal(read.safety.content_trust, "untrusted_artifact");
  assert.equal(Buffer.byteLength(JSON.stringify(read), "utf8"), read.package.budget.used);
  assert.ok(read.package.budget.used <= read.package.budget.limit);
  assert.equal(
    await readProjectFileText(database, store, {
      userId: other.id,
      projectId: reader.project_id,
      referenceId: reference.id,
      contextBudget: 2_000,
    }),
    undefined,
  );

  const preview = await getProjectFileRemovalPreview(database, {
    userId: reader.id,
    projectId: reader.project_id,
    referenceId: reference.id,
  });
  await removeProjectFileReference(database, {
    userId: reader.id,
    projectId: reader.project_id,
    referenceId: reference.id,
    expectedPreviewVersion: preview.preview_version,
    reason: "End PostgreSQL retrieval fixture",
  });
  assert.equal(
    await readProjectFileText(database, store, {
      userId: reader.id,
      projectId: reader.project_id,
      referenceId: reference.id,
      contextBudget: 2_000,
    }),
    undefined,
  );
});

test("PostgreSQL atomically preserves immutable relational PDF evidence provenance", async () => {
  const target = await database
    .prepare("SELECT context_id FROM active_connection_targets WHERE connection_id = ?")
    .get(connectionId);
  const objectId = `file_${randomUUID()}`;
  const referenceId = `file_ref_${randomUUID()}`;
  const contentSha256 = createHash("sha256").update("postgres-pdf-fixture").digest("hex");
  const excerpt = "PostgreSQL exact embedded PDF text";
  const excerptSha256 = createHash("sha256").update(excerpt).digest("hex");
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO file_objects
        (id, workspace_id, content_sha256, byte_size, verified_media_type, storage_key,
         storage_version_id, storage_etag, scan_provider, scan_status, scan_updated_at, created_at)
       VALUES (?, ?, ?, 22, 'application/pdf', ?, 'version-pdf', 'etag-pdf',
               'aws_guardduty_s3', 'clean', ?, ?)`,
    )
    .run(objectId, owner.workspace_id, contentSha256, `objects/${randomUUID()}`, now, now);
  await database
    .prepare(
      `INSERT INTO file_context_references
        (id, workspace_id, project_id, context_id, file_object_id, logical_file_id,
         version, display_name, source_host, uploader_user_id, access_scope, referenced_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'postgres-evidence.pdf', 'postgres_test', ?,
               'inherit_context', ?)`,
    )
    .run(
      referenceId,
      owner.workspace_id,
      owner.project_id,
      target.context_id,
      objectId,
      referenceId,
      owner.id,
      now,
    );
  const fileSource = {
    file_reference_id: referenceId,
    logical_file_id: referenceId,
    file_version: 1,
    content_sha256: contentSha256,
    display_name: "postgres-evidence.pdf",
    media_type: "application/pdf",
    source_context_id: target.context_id,
    extraction_version: "pdfjs_embedded_text_v1",
    parser: "pdfjs-dist@6.2.108",
    method: "embedded_text_only",
    start_character: 0,
    end_character: Array.from(excerpt).length,
    excerpt_sha256: excerptSha256,
    total_pages: 1,
  };
  const receipt = await saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl: "https://app.alice.example",
    userId: owner.id,
    payload: {
      project_id: owner.project_id,
      context_id: target.context_id,
      summary: "PostgreSQL PDF evidence fixture",
      candidate_claims: [
        { state_key: "launch.pdf_fixture", value: true, summary: "Pending PDF fixture" },
      ],
      source_note: "Exact untrusted PDF evidence fixture",
      source_context: excerpt,
      idempotency_key: "postgres-pdf-evidence-source-1",
      file_source: fileSource,
    },
    toolName: "suggest_project_updates_from_file",
    evidenceFileSource: {
      sourceContextId: target.context_id,
      fileReferenceId: referenceId,
      fileObjectId: objectId,
      logicalFileId: referenceId,
      fileVersion: 1,
      contentSha256,
      extractionVersion: "pdfjs_embedded_text_v1",
      startCharacter: 0,
      endCharacter: Array.from(excerpt).length,
      excerptSha256,
    },
  });
  assert.equal(receipt.trusted_state_changed, false);
  assert.equal(receipt.provenance.tool_name, "suggest_project_updates_from_file");
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM evidence_file_sources WHERE evidence_id = ?")
        .get(receipt.evidence_id)
    ).count,
    1,
  );
  assert.deepEqual(
    (
      await database
        .prepare("SELECT status FROM candidate_claims WHERE evidence_id = ?")
        .all(receipt.evidence_id)
    ).map(({ status }) => status),
    ["pending"],
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM accepted_project_state WHERE evidence_id = ?")
        .get(receipt.evidence_id)
    ).count,
    0,
  );
  await assert.rejects(
    database
      .prepare("UPDATE evidence_file_sources SET excerpt_sha256 = ? WHERE evidence_id = ?")
      .run("0".repeat(64), receipt.evidence_id),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare("DELETE FROM evidence_file_sources WHERE evidence_id = ?")
      .run(receipt.evidence_id),
    /permission denied|immutable/i,
  );
});

test("one concurrent exact file-removal preview wins and preserves immutable history", async () => {
  const preview = await getProjectFileRemovalPreview(database, {
    userId: owner.id,
    projectId: owner.project_id,
    referenceId: postgresFileReferenceId,
  });
  assert.match(preview.preview_version, /^file_removal_preview_[0-9a-f]{64}$/);
  const attempts = await Promise.all([
    removeProjectFileReference(database, {
      userId: owner.id,
      projectId: owner.project_id,
      referenceId: postgresFileReferenceId,
      expectedPreviewVersion: preview.preview_version,
      reason: "PostgreSQL exact removal fixture",
    }),
    removeProjectFileReference(database, {
      userId: owner.id,
      projectId: owner.project_id,
      referenceId: postgresFileReferenceId,
      expectedPreviewVersion: preview.preview_version,
      reason: "PostgreSQL exact removal fixture",
    }),
  ]);
  assert.equal(attempts.filter((result) => result?.conflict === false).length, 1);
  assert.equal(attempts.filter((result) => result?.conflict !== false).length, 1);
  assert.equal(
    (
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM file_reference_exclusions WHERE file_reference_id = ?",
        )
        .get(postgresFileReferenceId)
    ).count,
    1,
  );
  assert.equal(
    await getProjectFileRemovalPreview(database, {
      userId: owner.id,
      projectId: owner.project_id,
      referenceId: postgresFileReferenceId,
    }),
    undefined,
  );
  await assert.rejects(
    database
      .prepare(
        "UPDATE file_reference_exclusions SET reason = 'rewritten' WHERE file_reference_id = ?",
      )
      .run(postgresFileReferenceId),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare("DELETE FROM file_reference_exclusions WHERE file_reference_id = ?")
      .run(postgresFileReferenceId),
    /permission denied|immutable/i,
  );
});

test("PostgreSQL project lifecycle preserves data behind constrained-role archive and requests", async () => {
  const lifecycleOwner = await createTestIdentity(database, {
    email: "postgres-lifecycle-owner@alice.example",
    password: "postgres lifecycle owner private password",
    projectId: "project_postgres_lifecycle",
  });
  const before = await getProjectLifecycle(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
  });
  const exported = await exportProjectData(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
  });
  assert.equal(exported.format, "alice.project-export");
  assert.ok(exported.contexts.some(({ name }) => name === "General"));

  const archived = await archiveProject(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
    expectedPreviewVersion: before.preview_version,
  });
  assert.ok(archived.archived_at);
  assert.equal(
    await getProjectContext(database, {
      userId: lifecycleOwner.id,
      projectId: lifecycleOwner.project_id,
      task: "Archived projects are unavailable to ordinary reads",
      contextBudget: 4_000,
    }),
    undefined,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM work_contexts WHERE project_id = ?")
        .get(lifecycleOwner.project_id)
    ).count,
    2,
  );

  const archivedView = await getProjectLifecycle(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
  });
  const deletionRequest = await requestProjectDeletion(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
    expectedPreviewVersion: archivedView.preview_version,
    confirmation: "Private project",
  });
  assert.ok(Date.parse(deletionRequest.not_before) > Date.parse(deletionRequest.requested_at));
  await assert.rejects(
    database
      .prepare("UPDATE project_deletion_requests SET requested_at = ? WHERE id = ?")
      .run(new Date().toISOString(), deletionRequest.id),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM project_deletion_requests WHERE id = ?").run(deletionRequest.id),
    /permission denied|immutable/i,
  );

  const pendingView = await getProjectLifecycle(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
  });
  await cancelProjectDeletion(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
    expectedPreviewVersion: pendingView.preview_version,
  });
  const cancelledView = await getProjectLifecycle(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
  });
  await restoreProject(database, {
    userId: lifecycleOwner.id,
    projectId: lifecycleOwner.project_id,
    expectedPreviewVersion: cancelledView.preview_version,
  });
  await assert.rejects(
    database
      .prepare("UPDATE projects SET name = 'Rewritten' WHERE id = ?")
      .run(lifecycleOwner.project_id),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM projects WHERE id = ?").run(lifecycleOwner.project_id),
    /permission denied|immutable/i,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?")
        .get(lifecycleOwner.project_id)
    ).count,
    1,
  );
});

test("privileged erasure removes exact project rows and unshared object versions with a retry receipt", async () => {
  const erasedProject = await createProject(database, owner.id, {
    name: "Erasure fixture",
    brief: "A disposable project for privileged erasure verification.",
  });
  const retainedProject = await createProject(database, owner.id, {
    name: "Retained erasure control",
    brief: "Proves shared immutable bytes and unrelated project data remain.",
  });
  const erasedContext = await database
    .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND context_kind = 'work'")
    .get(erasedProject.id);
  const retainedContext = await database
    .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND context_kind = 'work'")
    .get(retainedProject.id);
  const storedVersions = new Map();
  const store = {
    async putObject({ key, bytes }) {
      const versionId = `version-${randomUUID()}`;
      storedVersions.set(key, [{ key, versionId, deleteMarker: false, bytes: Buffer.from(bytes) }]);
      return { versionId, etag: `etag-${randomUUID()}` };
    },
    async getScanResult() {
      return "clean";
    },
    async getObject({ key }) {
      return Buffer.from(storedVersions.get(key)[0].bytes);
    },
    async createSignedDownload() {
      return "https://private-files.alice.example/retained-shared-object";
    },
  };
  const unique = await uploadProjectFile(database, store, {
    userId: owner.id,
    projectId: erasedProject.id,
    contextId: erasedContext.id,
    fileName: "erase-only.txt",
    claimedMediaType: "text/plain",
    bytes: Buffer.from("private bytes that belong only to the erased project"),
  });
  await refreshProjectFileScan(database, store, {
    userId: owner.id,
    projectId: erasedProject.id,
    referenceId: unique.id,
  });
  const sharedBytes = Buffer.from("exact immutable bytes shared across two authorized projects");
  const erasedShared = await uploadProjectFile(database, store, {
    userId: owner.id,
    projectId: erasedProject.id,
    contextId: erasedContext.id,
    fileName: "shared.txt",
    claimedMediaType: "text/plain",
    bytes: sharedBytes,
  });
  await refreshProjectFileScan(database, store, {
    userId: owner.id,
    projectId: erasedProject.id,
    referenceId: erasedShared.id,
  });
  const retainedShared = await uploadProjectFile(database, store, {
    userId: owner.id,
    projectId: retainedProject.id,
    contextId: retainedContext.id,
    fileName: "shared-retained.txt",
    claimedMediaType: "text/plain",
    bytes: sharedBytes,
  });
  const uniqueKey = (
    await migrationDatabase
      .prepare("SELECT storage_key FROM file_objects WHERE id = ?")
      .get(unique.object_id)
  ).storage_key;
  const sharedKey = (
    await migrationDatabase
      .prepare("SELECT storage_key FROM file_objects WHERE id = ?")
      .get(erasedShared.object_id)
  ).storage_key;

  const lifecycle = await getProjectLifecycle(database, {
    userId: owner.id,
    projectId: erasedProject.id,
  });
  await archiveProject(database, {
    userId: owner.id,
    projectId: erasedProject.id,
    expectedPreviewVersion: lifecycle.preview_version,
  });
  const requestId = `project_deletion_${randomUUID()}`;
  const requestedAt = new Date("2026-08-01T00:00:00.000Z");
  const notBefore = new Date("2026-08-08T00:00:00.000Z");
  await migrationDatabase
    .prepare(
      `INSERT INTO project_deletion_requests
       (id, workspace_id, project_id, requested_by_user_id, requested_at, not_before)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      requestId,
      owner.workspace_id,
      erasedProject.id,
      owner.id,
      requestedAt.toISOString(),
      notBefore.toISOString(),
    );
  await assert.rejects(
    database.prepare("SELECT * FROM project_erasure_jobs").all(),
    /permission denied/i,
  );
  await assert.rejects(
    database.prepare("DELETE FROM projects WHERE id = ?").run(erasedProject.id),
    /permission denied|immutable/i,
  );

  let interruptAfterObjectDeletion = true;
  let reportObjectDeletion!: () => void;
  let releaseInterruptedErasure!: () => void;
  const objectDeletionReached = new Promise<void>((resolve) => {
    reportObjectDeletion = resolve;
  });
  const interruptedErasureMayReturn = new Promise<void>((resolve) => {
    releaseInterruptedErasure = resolve;
  });
  const erasureStore = {
    async inventory(keys) {
      return keys.flatMap((key) =>
        (storedVersions.get(key) || []).map(({ versionId, deleteMarker }) => ({
          key,
          versionId,
          deleteMarker,
        })),
      );
    },
    async erase(keys, versions) {
      for (const { key, versionId } of versions) {
        storedVersions.set(
          key,
          (storedVersions.get(key) || []).filter((version) => version.versionId !== versionId),
        );
      }
      assert.deepEqual(
        keys.flatMap((key) => storedVersions.get(key) || []),
        [],
      );
      if (interruptAfterObjectDeletion) {
        interruptAfterObjectDeletion = false;
        reportObjectDeletion();
        await interruptedErasureMayReturn;
        throw new Error("simulated interruption after private object deletion");
      }
      return { deletedVersions: versions.length };
    },
  };
  const operatorNow = new Date("2026-09-01T00:00:00.000Z");
  const preview = await previewProjectErasure({
    database: migrationDatabase,
    store: erasureStore,
    projectId: erasedProject.id,
    requestId,
    now: operatorNow,
  });
  assert.equal(preview.status, "eligible");
  assert.match(preview.preview_version, /^project_erasure_preview_[0-9a-f]{64}$/);
  assert.equal(preview.object_key_count, 1);
  assert.equal(preview.object_version_count, 1);
  assert.equal(preview.shared_object_count, 1);
  await assert.rejects(
    eraseProject({
      database: migrationDatabase,
      store: erasureStore,
      projectId: erasedProject.id,
      requestId,
      expectedPreviewVersion: "project_erasure_preview_" + "0".repeat(64),
      providerBackupRetentionDays: 7,
      now: operatorNow,
    }),
    /preview changed/i,
  );

  const exactErasure = {
    database: migrationDatabase,
    store: erasureStore,
    projectId: erasedProject.id,
    requestId,
    expectedPreviewVersion: preview.preview_version,
    providerBackupRetentionDays: 7,
    now: operatorNow,
  };
  const deletionLifecycle = await getProjectLifecycle(database, {
    userId: owner.id,
    projectId: erasedProject.id,
  });
  const interruptedErasure = eraseProject(exactErasure);
  await objectDeletionReached;
  const lateCancellation = cancelProjectDeletion(database, {
    userId: owner.id,
    projectId: erasedProject.id,
    expectedPreviewVersion: deletionLifecycle.preview_version,
  });
  assert.equal(
    await Promise.race([
      lateCancellation.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]),
    "blocked",
  );
  releaseInterruptedErasure();
  await assert.rejects(interruptedErasure, /simulated interruption after private object deletion/i);
  await assert.rejects(lateCancellation, /erasure has started/i);
  assert.equal(storedVersions.get(uniqueKey).length, 0);
  assert.equal(
    (
      await migrationDatabase
        .prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?")
        .get(erasedProject.id)
    ).count,
    1,
  );
  assert.equal(
    (
      await migrationDatabase
        .prepare("SELECT status FROM project_erasure_jobs WHERE preview_version = ?")
        .get(preview.preview_version)
    ).status,
    "prepared",
  );

  const erased = await eraseProject(exactErasure);
  assert.equal(erased.status, "completed");
  assert.equal(erased.object_key_count, 1);
  assert.equal(erased.object_version_count, 1);
  assert.equal(erased.shared_object_count, 1);
  assert.ok(erased.database_row_count > 0);
  assert.equal(storedVersions.get(uniqueKey).length, 0);
  assert.equal(storedVersions.get(sharedKey).length, 1);
  assert.equal(
    (
      await migrationDatabase
        .prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?")
        .get(erasedProject.id)
    ).count,
    0,
  );
  assert.equal(
    (
      await migrationDatabase
        .prepare("SELECT COUNT(*) AS count FROM file_objects WHERE id = ?")
        .get(unique.object_id)
    ).count,
    0,
  );
  assert.equal(
    (
      await migrationDatabase
        .prepare("SELECT COUNT(*) AS count FROM file_objects WHERE id = ?")
        .get(erasedShared.object_id)
    ).count,
    1,
  );
  assert.equal(
    (
      await getProjectFileDownload(database, store, {
        userId: owner.id,
        projectId: retainedProject.id,
        referenceId: retainedShared.id,
      })
    ).available,
    true,
  );
  const receipt = await migrationDatabase
    .prepare(
      `SELECT project_id, status, object_key_count, object_version_count,
              shared_object_count, database_row_count, provider_backup_expires_at
       FROM project_erasure_jobs WHERE preview_version = ?`,
    )
    .get(preview.preview_version);
  assert.equal(receipt.project_id, null);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.object_key_count, 1);
  assert.equal(receipt.object_version_count, 1);
  assert.equal(receipt.shared_object_count, 1);
  assert.equal(receipt.database_row_count, erased.database_row_count);
  assert.ok(Date.parse(receipt.provider_backup_expires_at) > Date.now());
  await assert.rejects(
    migrationDatabase
      .prepare("UPDATE project_erasure_jobs SET database_row_count = 0 WHERE preview_version = ?")
      .run(preview.preview_version),
    /terminal|immutable/i,
  );
  await assert.rejects(
    migrationDatabase
      .prepare("DELETE FROM project_erasure_jobs WHERE preview_version = ?")
      .run(preview.preview_version),
    /immutable/i,
  );

  const replay = await eraseProject(exactErasure);
  assert.equal(replay.status, "completed");
  assert.equal(replay.database_row_count, erased.database_row_count);
  assert.equal("id" in replay, false);
  assert.equal("preview_version" in replay, false);
  assert.equal("object_manifest_sha256" in replay, false);
  const completedPreview = await previewProjectErasure({
    database: migrationDatabase,
    store: erasureStore,
    projectId: erasedProject.id,
    requestId,
    now: operatorNow,
  });
  assert.equal(completedPreview.status, "completed");
  assert.equal("id" in completedPreview, false);
  assert.equal("preview_version" in completedPreview, false);
  assert.equal("object_manifest_sha256" in completedPreview, false);
});

test("cross-tenant and mismatched-connection access disclose nothing and mutate nothing", async () => {
  const context = await getProjectContext(database, {
    userId: other.id,
    projectId: owner.project_id,
    task: "Guess private launch price",
    contextBudget: 4_000,
  });
  assert.equal(context, undefined);
  const before = await database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get();
  const denied = await saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl: "https://app.alice.example",
    userId: other.id,
    payload: {
      ...payload("postgres-denied-cross-tenant"),
      project_id: other.project_id,
    },
  });
  assert.match(denied.error, /tenant context is missing/i);
  const afterCount = await database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get();
  assert.equal(afterCount.count, before.count);

  const ownerSignals = await getPrivateAlphaSignals(database, owner.id);
  const otherSignals = await getPrivateAlphaSignals(database, other.id);
  assert.ok(ownerSignals.saving.offers > 0);
  assert.ok(ownerSignals.saving.proposals >= ownerSignals.saving.offers);
  assert.equal(ownerSignals.privacy.content_fields_read, false);
  assert.equal(otherSignals.saving.offers, 0);
  assert.equal(otherSignals.consumption.observed_attempts, 0);

  const ownerAccess = await getProjectAccessOverview(database, {
    userId: owner.id,
    projectId: owner.project_id,
  });
  assert.equal(ownerAccess.project.current_user_role, "owner");
  assert.ok(ownerAccess.contexts.length >= 2);
  assert.ok(
    ownerAccess.connections.some(
      ({ client_name: clientName }) => clientName === "PostgreSQL concurrency fixture",
    ),
  );
  assert.equal(
    await getProjectAccessOverview(database, {
      userId: other.id,
      projectId: owner.project_id,
    }),
    undefined,
  );
  assert.doesNotMatch(JSON.stringify(ownerAccess), /Exact source bytes retained as text/);
});
