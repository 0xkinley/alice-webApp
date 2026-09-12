import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import {
  AliceDatabase,
  configureApplicationRole,
  ensureApplicationRole,
  openDatabase,
} from "@alice/database";
import {
  acceptCandidate,
  acceptProjectInvitation,
  archiveProject,
  beginHostFileSaveTransfer,
  cancelProjectDeletion,
  confirmCapturedUpdate,
  commitCaptureSavePreview,
  commitArtifactSavePreview,
  createArtifactSavePreview,
  createHostFileSaveOffer,
  createHostFileSaveOffers,
  createCaptureSavePreview,
  createProject,
  createWorkContext,
  createProjectInvitation,
  exportProjectData,
  finalizeHostFileSaveTransfer,
  getCapturePreview,
  getAliceArtifact,
  getHostFileSaveOfferPreview,
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
  searchAliceArtifacts,
  saveCandidateUpdate,
  setActiveConnectionTarget,
  setContextProviderAvailability,
  restoreProject,
  decideHostFileSaveOffer,
  decideHostFileSaveOffers,
  supersedeAcceptedState,
  uploadProjectFile,
  updateProjectMemberRole,
  approveOAuthConsentTransaction,
} from "@alice/domain";
import { createApp as createMcpApp } from "../../apps/mcp/src/app.ts";
import { eraseProject, previewProjectErasure } from "../../scripts/erase-project.mjs";
import { createTestIdentity, getProjectDefaultContext } from "../helpers.ts";

const connectionString = process.env.ALICE_TEST_DATABASE_URL;
assert.ok(connectionString, "ALICE_TEST_DATABASE_URL is required for PostgreSQL tests.");
const { Pool } = pg;

const schema = `test_${randomUUID().replaceAll("-", "_")}`;
const applicationRole = `app_${randomUUID().replaceAll("-", "_")}`;
const applicationPassword = `test_${randomUUID()}`;
let database;
let migrationDatabase;
let owner;
let other;
let postgresFileReferenceId;
let postgresReplacementReferenceId;

class PostgresHostTransferStore {
  objects = new Map<string, { bytes: Buffer; versionId: string }>();
  signedKeys: string[] = [];
  putCount = 0;

  async createSignedUpload({ key, expiresInSeconds }) {
    this.signedKeys.push(key);
    return {
      url: `https://private-files.alice.example/${encodeURIComponent(key)}`,
      headers: { "x-alice-postgres-transfer": "signed" },
      expiresInSeconds,
    };
  }

  stage(key: string, bytes: Buffer, versionId: string) {
    this.objects.set(key, { bytes: Buffer.from(bytes), versionId });
  }

  async putObject({ key, bytes }) {
    this.putCount += 1;
    const versionId = `postgres-host-final-${this.putCount}`;
    this.objects.set(key, { bytes: Buffer.from(bytes), versionId });
    return { versionId, etag: `postgres-host-etag-${this.putCount}` };
  }

  async getScanResult({ key, versionId }) {
    const object = this.objects.get(key);
    if (!object || object.versionId !== versionId) throw new Error("exact object version missing");
    return "clean" as const;
  }

  async getObject({ key, versionId }) {
    const object = this.objects.get(key);
    if (!object || object.versionId !== versionId) throw new Error("exact object version missing");
    return Buffer.from(object.bytes);
  }

  async createSignedDownload() {
    return "https://private-files.alice.example/postgres-host-download";
  }
}

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

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
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
         VALUES (?, ?, ?, ?, 'chatgpt', 'mcp:read mcp:write', ?, ?)`,
    )
    .run(connectionId, owner.id, owner.workspace_id, clientId, now, now);
});

after(async () => {
  if (database) await database.close();
  if (migrationDatabase) {
    await migrationDatabase.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await migrationDatabase.exec(`DROP ROLE IF EXISTS "${applicationRole}"`);
    await migrationDatabase.close();
  }
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

test("PostgreSQL completes a session-approved OAuth handoff", async () => {
  const port = await availablePort();
  const mcpUrl = `http://127.0.0.1:${port}`;
  const redirectUri = "http://127.0.0.1/provider-oauth-callback";
  const mcp = await createMcpApp({ database, publicUrl: mcpUrl, reviewUrl: mcpUrl });
  const server = mcp.app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const registration = await fetch(`${mcpUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT PostgreSQL OAuth regression",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const verifier = "p".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = new URL(`${mcpUrl}/authorize`);
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "postgres-provider-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write offline_access",
      resource: `${mcpUrl}/mcp`,
    }).toString();
    const handoff = await fetch(authorization, { redirect: "manual" });
    assert.equal(handoff.status, 303);
    const consentUrl = new URL(handoff.headers.get("location")!);
    const token = consentUrl.searchParams.get("request")!;
    const approval = await approveOAuthConsentTransaction(database, {
      token,
      userId: owner.id,
    });
    assert.ok(approval);

    const completion = await fetch(approval.complete_url, { redirect: "manual" });
    assert.equal(completion.status, 303);
    const providerCallback = new URL(completion.headers.get("location")!);
    assert.equal(providerCallback.origin + providerCallback.pathname, redirectUri);
    assert.equal(providerCallback.searchParams.get("state"), "postgres-provider-state");
    assert.match(providerCallback.searchParams.get("code"), /^alice_code_/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
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
    { version: 17, filename: "017_host_file_save_offers.sql" },
    { version: 18, filename: "018_host_file_transfers.sql" },
    { version: 19, filename: "019_popular_file_formats.sql" },
    { version: 20, filename: "020_context_provider_authorizations.sql" },
    { version: 21, filename: "021_single_action_save_previews.sql" },
    { version: 22, filename: "022_project_default_contexts.sql" },
    { version: 23, filename: "023_oauth_consent_transactions.sql" },
    { version: 24, filename: "024_artifact_handoffs.sql" },
    { version: 25, filename: "025_save_confirmation_receipts.sql" },
    { version: 26, filename: "026_artifact_read_receipts.sql" },
  ]);

  const reopened = await openDatabase({ connectionString, schema, maxConnections: 2 });
  assert.equal(
    (await reopened.prepare("SELECT COUNT(*) AS count FROM alice_schema_migrations").get()).count,
    26,
  );
  await reopened.close();
});

test("PostgreSQL preserves an exact artifact handoff and immutable version lineage", async () => {
  const first = await createArtifactSavePreview(database, {
    userId: owner.id,
    connectionId,
    clientId,
    publicUrl: "https://app.alice.example",
    payload: {
      project_id: owner.project_id,
      title: "PostgreSQL handoff artifact",
      artifact_type: "report",
      category: "research",
      tags: ["research", "decision"],
      content: "Full current artifact v1.",
      handoff: {
        goal: "Prove exact PostgreSQL artifact persistence.",
        decisions: ["Keep current state concise"],
        constraints: ["Do not infer missing history"],
        rejected_directions: [],
        open_questions: [],
        next_steps: ["Verify retrieval"],
        relevant_context: [],
      },
      idempotency_key: "postgres-artifact-v1",
    },
  });
  assert.ok(!("error" in first));
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM artifact_versions WHERE project_id = ?")
        .get(owner.project_id)
    ).count,
    0,
  );
  const saved = await commitArtifactSavePreview(database, {
    previewId: first.preview.preview_id,
    previewVersion: first.preview.preview_version,
    authorityToken: first.authorityToken,
    authority: "mcp_app",
    userId: owner.id,
  });
  assert.equal(saved.version, 1);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM save_confirmation_receipts WHERE id = ?")
        .get(first.preview.preview_id)
    ).count,
    1,
  );
  await assert.rejects(
    database
      .prepare("UPDATE save_confirmation_receipts SET receipt_json = ? WHERE id = ?")
      .run("{}", first.preview.preview_id),
    /immutable|permission denied/i,
  );
  await assert.rejects(
    database
      .prepare("DELETE FROM save_confirmation_receipts WHERE id = ?")
      .run(first.preview.preview_id),
    /immutable|permission denied/i,
  );

  const found = await searchAliceArtifacts(database, {
    userId: owner.id,
    connectionId,
    project_id: owner.project_id,
    query: "handoff",
    categories: [],
    tags: [],
    sources: [],
    artifact_types: [],
    timeline: "all_time",
    limit: 20,
  });
  assert.equal(found.status, "ok");
  assert.equal(found.results[0].artifact_id, saved.artifact_id);
  assert.equal(found.results[0].content, undefined);

  const retrieved = await getAliceArtifact(database, {
    userId: owner.id,
    connectionId,
    projectId: owner.project_id,
    artifactId: saved.artifact_id,
  });
  assert.equal(retrieved.artifact.content, "Full current artifact v1.");
  assert.deepEqual(retrieved.artifact.handoff.decisions, ["Keep current state concise"]);

  await assert.rejects(
    database
      .prepare("UPDATE artifact_versions SET title = ? WHERE id = ?")
      .run("Rewritten", saved.version_id),
    /immutable|permission denied/i,
  );
});

test("migration 022 backfills a new empty default without rewriting legacy contexts", async () => {
  const upgradeSchema = `upgrade_${randomUUID().replaceAll("-", "_")}`;
  const bootstrap = new Pool({ connectionString, max: 1 });
  let upgradePool;
  try {
    await bootstrap.query(`CREATE SCHEMA "${upgradeSchema}"`);
    upgradePool = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path=${upgradeSchema}`,
    });
    const upgrade = new AliceDatabase(upgradePool, upgradeSchema);
    await upgrade.exec(`
      CREATE TABLE projects (
        id text NOT NULL,
        workspace_id text NOT NULL,
        name text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (workspace_id, id)
      );
      CREATE TABLE project_memberships (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        project_id text NOT NULL,
        user_id text NOT NULL,
        role text NOT NULL,
        ended_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE work_contexts (
        id text NOT NULL,
        workspace_id text NOT NULL,
        project_id text NOT NULL,
        name text NOT NULL,
        description text NOT NULL,
        context_kind text NOT NULL,
        visibility text NOT NULL,
        created_by_user_id text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        archived_at timestamptz,
        UNIQUE (workspace_id, project_id, id)
      );
      CREATE FUNCTION alice_reject_immutable_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'row is immutable' USING ERRCODE = '55000';
      END;
      $$;
      INSERT INTO projects
        (id, workspace_id, name, created_at, updated_at)
      VALUES
        ('legacy_project', 'legacy_workspace', 'Legacy project',
         '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
      INSERT INTO project_memberships
        (id, workspace_id, project_id, user_id, role, ended_at, created_at)
      VALUES
        ('legacy_owner', 'legacy_workspace', 'legacy_project', 'legacy_user',
         'owner', NULL, '2026-01-01T00:00:00Z');
      INSERT INTO work_contexts
        (id, workspace_id, project_id, name, description, context_kind, visibility,
         created_by_user_id, created_at, updated_at)
      VALUES
        ('legacy_general', 'legacy_workspace', 'legacy_project', 'General', 'Retained',
         'work', 'all_members', 'legacy_user', '2026-01-01T00:00:00Z',
         '2026-02-01T00:00:00Z'),
        ('legacy_project_wide', 'legacy_workspace', 'legacy_project', 'Project-wide',
         'Retained', 'project_wide', 'all_members', 'legacy_user',
         '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
    `);
    const migrationSql = await readFile(
      new URL(
        "../../packages/database/migrations/022_project_default_contexts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await upgrade.exec(migrationSql);
    assert.deepEqual(
      await upgrade
        .prepare(
          `SELECT name, context_kind FROM work_contexts
           WHERE project_id = 'legacy_project' ORDER BY name`,
        )
        .all(),
      [
        { name: "General", context_kind: "work" },
        { name: "Project-wide", context_kind: "project_wide" },
        {
          name: "__alice_project_default_698a2f47b9a00cfff2391f04af0305ce",
          context_kind: "work",
        },
      ],
    );
    const mapping = await upgrade
      .prepare(
        "SELECT context_id FROM project_default_contexts WHERE project_id = 'legacy_project'",
      )
      .get();
    assert.equal(mapping.context_id, "context_default_698a2f47b9a00cfff2391f04af0305ce");
    await assert.rejects(
      upgrade
        .prepare("DELETE FROM project_default_contexts WHERE project_id = 'legacy_project'")
        .run(),
      /immutable/i,
    );
  } finally {
    if (upgradePool) await upgradePool.end();
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    await bootstrap.end();
  }
});

test("PostgreSQL protects one hidden default mapping for every new project", async () => {
  const mapped = await getProjectDefaultContext(database, owner.project_id);
  assert.ok(mapped);
  assert.match(mapped.name, /^__alice_project_default_/);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM work_contexts WHERE project_id = ?")
        .get(owner.project_id)
    ).count,
    1,
  );
  await assert.rejects(
    database
      .prepare("UPDATE project_default_contexts SET context_id = ? WHERE project_id = ?")
      .run("context_rewritten", owner.project_id),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare("DELETE FROM project_default_contexts WHERE project_id = ?")
      .run(owner.project_id),
    /permission denied|immutable/i,
  );
});

test("single-action Save is preview-only until exact PostgreSQL confirmation", async () => {
  const before = await database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence,
        (SELECT COUNT(*) FROM candidate_claims) AS candidates,
        (SELECT COUNT(*) FROM accepted_project_state) AS accepted`,
    )
    .get();
  const prepared: any = await createCaptureSavePreview(database, {
    userId: owner.id,
    connectionId,
    clientId,
    publicUrl: "https://app.alice.example",
    payload: {
      project_id: owner.project_id,
      summary: "PostgreSQL single-action Save",
      candidate_claims: [
        {
          state_key: "postgres.single_action_save",
          value: "accepted only after Save",
          summary: "Single action boundary",
        },
      ],
      idempotency_key: "postgres-single-action-save-001",
    },
  });
  assert.deepEqual(
    await database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM evidence_events) AS evidence,
          (SELECT COUNT(*) FROM candidate_claims) AS candidates,
          (SELECT COUNT(*) FROM accepted_project_state) AS accepted`,
      )
      .get(),
    before,
  );
  await assert.rejects(
    () =>
      commitCaptureSavePreview(database, {
        previewId: prepared.preview.preview_id,
        previewVersion: prepared.preview.preview_version,
        authorityToken: `alice_save_${"A".repeat(43)}`,
        authority: "mcp_app",
        publicUrl: "https://app.alice.example",
        userId: owner.id,
      }),
    /authority is unavailable/i,
  );
  const saved: any = await commitCaptureSavePreview(database, {
    previewId: prepared.preview.preview_id,
    previewVersion: prepared.preview.preview_version,
    authorityToken: prepared.authorityToken,
    authority: "mcp_app",
    publicUrl: "https://app.alice.example",
    userId: owner.id,
  });
  assert.equal(saved.status, "saved");
  assert.equal(saved.accepted.length, 1);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM capture_save_previews WHERE id = ?")
        .get(prepared.preview.preview_id)
    ).count,
    0,
  );
});

test("provider availability is separately constrained under the application role", async () => {
  const context = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'work'
       ORDER BY name, id LIMIT 1`,
    )
    .get(owner.workspace_id, owner.project_id);
  const rows = await database
    .prepare(
      `SELECT provider, version FROM context_provider_authorizations
       WHERE user_id = ? AND context_id = ? ORDER BY provider`,
    )
    .all(owner.id, context.id);
  const versions = Object.fromEntries(rows.map((row) => [row.provider, row.version]));
  const changed = await setContextProviderAvailability(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: context.id,
    chatgpt: true,
    claude: false,
    expectedVersions: versions,
  });
  assert.equal(changed.conflict, false);
  await assert.rejects(
    database
      .prepare(
        `UPDATE context_provider_authorizations SET context_id = ?
         WHERE user_id = ? AND context_id = ?`,
      )
      .run("context_guessed", owner.id, context.id),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare(
        `DELETE FROM context_provider_authorizations
         WHERE user_id = ? AND context_id = ?`,
      )
      .run(owner.id, context.id),
    /permission denied|immutable/i,
  );
});

test("application-role password rotation works through a non-superuser role administrator", async () => {
  const operatorRole = `operator_${randomUUID().replaceAll("-", "_")}`;
  const operatorPassword = `operator_${randomUUID()}`;
  const rotatedApplicationPassword = `rotated_${randomUUID()}`;
  const createOperator = await migrationDatabase
    .prepare(
      `SELECT format(
         'CREATE ROLE %I WITH LOGIN PASSWORD %L CREATEROLE NOSUPERUSER NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS',
         CAST(? AS text),
         CAST(? AS text)
       ) AS statement`,
    )
    .get(operatorRole, operatorPassword);
  const grantAdministration = await migrationDatabase
    .prepare(
      `SELECT format(
         'GRANT %I TO %I WITH ADMIN OPTION',
         CAST(? AS text),
         CAST(? AS text)
       ) AS statement`,
    )
    .get(applicationRole, operatorRole);
  const dropOperator = await migrationDatabase
    .prepare("SELECT format('DROP ROLE IF EXISTS %I', CAST(? AS text)) AS statement")
    .get(operatorRole);
  await migrationDatabase.exec(createOperator.statement);
  await migrationDatabase.exec(grantAdministration.statement);

  const operatorUrl = new URL(connectionString);
  operatorUrl.username = operatorRole;
  operatorUrl.password = operatorPassword;
  const operatorDatabase = new AliceDatabase(
    new Pool({ connectionString: operatorUrl.href, max: 1 }),
    schema,
  );
  try {
    await ensureApplicationRole(operatorDatabase, applicationRole, rotatedApplicationPassword);
    assert.deepEqual(
      await migrationDatabase
        .prepare(
          `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
                  rolreplication, rolbypassrls
             FROM pg_roles
            WHERE rolname = ?`,
        )
        .get(applicationRole),
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    );
  } finally {
    await operatorDatabase.close();
    await ensureApplicationRole(migrationDatabase, applicationRole, applicationPassword);
    await migrationDatabase.exec(dropOperator.statement);
  }
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

test("PostgreSQL persists one exact host-file offer and one human decision immutably", async () => {
  const receipt = await createHostFileSaveOffer(database, {
    userId: owner.id,
    connectionId,
    publicUrl: "https://app.alice.example",
    payload: {
      project_id: owner.project_id,
      file_name: "postgres-host-file.md",
      declared_media_type: "text/markdown",
      declared_byte_size: 128,
      declared_sha256: "b".repeat(64),
      conversation_reference: "postgres.conversation-001",
      idempotency_key: "postgres-host-file-offer-001",
    },
  });
  assert.match(receipt.offer_id, /^file_save_offer_/);
  assert.equal(receipt.bytes_received, false);
  const preview = await getHostFileSaveOfferPreview(database, {
    userId: owner.id,
    offerId: receipt.offer_id,
    publicUrl: "https://app.alice.example",
  });
  const attempts = await Promise.allSettled([
    decideHostFileSaveOffer(database, {
      userId: owner.id,
      offerId: receipt.offer_id,
      previewVersion: preview.decision_version,
      decision: "save_file_only",
      authority: "web_session",
      publicUrl: "https://app.alice.example",
    }),
    decideHostFileSaveOffer(database, {
      userId: owner.id,
      offerId: receipt.offer_id,
      previewVersion: preview.decision_version,
      decision: "save_file_only",
      authority: "web_session",
      publicUrl: "https://app.alice.example",
    }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id = ?")
        .get(receipt.offer_id)
    ).count,
    1,
  );
  await assert.rejects(
    database
      .prepare("UPDATE host_file_save_offers SET display_name = 'rewritten.md' WHERE id = ?")
      .run(receipt.offer_id),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare("DELETE FROM host_file_save_decisions WHERE offer_id = ?")
      .run(receipt.offer_id),
    /permission denied|immutable/i,
  );
});

test("PostgreSQL atomically authorizes one exact multi-file manifest", async () => {
  const batch = await createHostFileSaveOffers(database, {
    userId: owner.id,
    connectionId,
    publicUrl: "https://app.alice.example",
    payload: {
      project_id: owner.project_id,
      files: [
        {
          file_name: "postgres-batch-one.md",
          declared_media_type: "text/markdown",
          declared_byte_size: 101,
          declared_sha256: "c".repeat(64),
        },
        {
          file_name: "postgres-batch-two.pdf",
          declared_media_type: "application/pdf",
          declared_byte_size: 202,
          declared_sha256: "d".repeat(64),
        },
      ],
      conversation_reference: "postgres.batch-001",
      idempotency_key: "postgres-host-file-batch-001",
    },
  });
  assert.match(batch.authorityToken, /^alice_file_save_/);
  const offers = batch.files.map((file) => ({
    offer_id: file.offer_id,
    preview_version: file.preview_version,
  }));
  await assert.rejects(
    decideHostFileSaveOffers(database, {
      userId: owner.id,
      offers: [offers[0], { ...offers[1], preview_version: "0".repeat(64) }],
      previewVersion: batch.preview_version,
      authorityToken: batch.authorityToken,
      publicUrl: "https://app.alice.example",
    }),
    /preview changed/i,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id IN (?, ?)")
        .get(offers[0].offer_id, offers[1].offer_id)
    ).count,
    0,
  );

  const attempts = await Promise.allSettled([
    decideHostFileSaveOffers(database, {
      userId: owner.id,
      offers,
      previewVersion: batch.preview_version,
      authorityToken: batch.authorityToken,
      publicUrl: "https://app.alice.example",
    }),
    decideHostFileSaveOffers(database, {
      userId: owner.id,
      offers,
      previewVersion: batch.preview_version,
      authorityToken: batch.authorityToken,
      publicUrl: "https://app.alice.example",
    }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id IN (?, ?)")
        .get(offers[0].offer_id, offers[1].offer_id)
    ).count,
    2,
  );
});

test("PostgreSQL consumes one confirmed host-file offer exactly once under concurrent finalization", async () => {
  const store = new PostgresHostTransferStore();
  const candidatesBefore = (
    await database
      .prepare("SELECT COUNT(*) AS count FROM candidate_claims WHERE project_id = ?")
      .get(owner.project_id)
  ).count;
  const bytes = Buffer.from(
    "# PostgreSQL host transfer\nConcurrent finalization must create one saved reference.\n",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = await createHostFileSaveOffer(database, {
    userId: owner.id,
    connectionId,
    publicUrl: "https://app.alice.example",
    payload: {
      project_id: owner.project_id,
      file_name: "postgres-host-transfer.md",
      declared_media_type: "text/markdown",
      declared_byte_size: bytes.length,
      declared_sha256: sha256,
      conversation_reference: "postgres.host-transfer-001",
      idempotency_key: "postgres-host-transfer-offer-001",
    },
  });
  const preview = await getHostFileSaveOfferPreview(database, {
    userId: owner.id,
    offerId: receipt.offer_id,
    publicUrl: "https://app.alice.example",
  });
  await decideHostFileSaveOffer(database, {
    userId: owner.id,
    offerId: receipt.offer_id,
    previewVersion: preview.decision_version,
    decision: "save_file_only",
    authority: "web_session",
    publicUrl: "https://app.alice.example",
  });
  const start = async (idempotencyKey: string) =>
    await beginHostFileSaveTransfer(database, store, {
      userId: owner.id,
      connectionId,
      offerId: receipt.offer_id,
      transferPath: "host_capability",
      fileName: "postgres-host-transfer.md",
      claimedMediaType: "text/markdown",
      byteSize: bytes.length,
      sha256,
      idempotencyKey,
    });
  const first = await start("postgres-host-transfer-attempt-001");
  const second = await start("postgres-host-transfer-attempt-002");
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  store.stage(store.signedKeys[0], bytes, "postgres-host-staging-001");
  store.stage(store.signedKeys[1], bytes, "postgres-host-staging-002");

  const attempts = await Promise.all([
    finalizeHostFileSaveTransfer(database, store, {
      userId: owner.id,
      connectionId,
      offerId: receipt.offer_id,
      intentId: first.intent_id,
      transferPath: "host_capability",
      storageVersionId: "postgres-host-staging-001",
    }),
    finalizeHostFileSaveTransfer(database, store, {
      userId: owner.id,
      connectionId,
      offerId: receipt.offer_id,
      intentId: second.intent_id,
      transferPath: "host_capability",
      storageVersionId: "postgres-host-staging-002",
    }),
  ]);
  assert.equal(attempts[0].status, "completed");
  assert.equal(attempts[1].status, "completed");
  assert.equal(attempts[0].file_reference_id, attempts[1].file_reference_id);
  assert.equal(store.putCount, 1);
  assert.equal(
    (
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM host_file_save_transfer_completions WHERE offer_id = ?",
        )
        .get(receipt.offer_id)
    ).count,
    1,
  );
  assert.equal(
    (
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM host_file_save_transfer_availability WHERE offer_id = ?",
        )
        .get(receipt.offer_id)
    ).count,
    1,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM candidate_claims WHERE project_id = ?")
        .get(owner.project_id)
    ).count,
    candidatesBefore,
  );
  await assert.rejects(
    database
      .prepare(
        "UPDATE host_file_save_transfer_intents SET transfer_path = 'browser_fallback' WHERE intent_id = ?",
      )
      .run(first.intent_id),
    /permission denied|immutable/i,
  );
  await assert.rejects(
    database
      .prepare("DELETE FROM host_file_save_transfer_availability WHERE offer_id = ?")
      .run(receipt.offer_id),
    /permission denied|immutable/i,
  );
});

test("one concurrent exact-preview confirmation wins and accepts the whole capture", async () => {
  const receipt = await saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl: "https://app.alice.example",
    userId: owner.id,
    payload: {
      project_id: owner.project_id,
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
  const successfulAttempt = attempts.find(({ conflict }) => conflict === false);
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
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = ? AND correlation_id = ?",
        )
        .get("candidate_update_confirmed", successfulAttempt.correlationId)
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
  assert.equal(packageResult.contract_version, "2.4");
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
  assert.ok(exported.contexts.some(({ scope }) => scope === "project"));
  assert.doesNotMatch(JSON.stringify(exported), /__alice_project_default|context_default_/);

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
    1,
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
  });
  const retainedProject = await createProject(database, owner.id, {
    name: "Retained erasure control",
  });
  const erasedContext = await getProjectDefaultContext(database, erasedProject.id);
  const retainedContext = await getProjectDefaultContext(database, retainedProject.id);
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
  assert.ok(ownerAccess.contexts.length >= 1);
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
