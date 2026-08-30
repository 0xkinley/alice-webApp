import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { configureApplicationRole, openDatabase } from "@alice/database";
import {
  acceptCandidate,
  acceptProjectInvitation,
  confirmCapturedUpdate,
  createWorkContext,
  createProjectInvitation,
  getCapturePreview,
  getProjectContext,
  getPrivateAlphaSignals,
  getProjectFileRemovalPreview,
  getProjectFileDownload,
  getRemovalPreview,
  getSavedContextView,
  issueAlphaInvitation,
  grantContextAccess,
  registerUser,
  recordContextReadSuccess,
  removeSavedContextEntry,
  removeProjectFileReference,
  removeProjectMember,
  endContextAccess,
  refreshProjectFileScan,
  saveCandidateUpdate,
  setActiveConnectionTarget,
  supersedeAcceptedState,
  uploadProjectFile,
  updateProjectMemberRole,
} from "@alice/domain";
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
  await migrationDatabase.exec(
    `CREATE ROLE "${applicationRole}" LOGIN PASSWORD '${applicationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
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
  ]);

  const reopened = await openDatabase({ connectionString, schema, maxConnections: 2 });
  assert.equal(
    (await reopened.prepare("SELECT COUNT(*) AS count FROM alice_schema_migrations").get()).count,
    12,
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
});
