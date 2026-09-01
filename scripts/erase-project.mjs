import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { openDatabase } from "@alice/database";
import {
  PROJECT_ERASURE_KEY_LIMIT,
  PROJECT_ERASURE_VERSION_LIMIT,
  createS3ProjectErasureStore,
} from "@alice/private-files";

const PROJECT_ID_PATTERN = /^project_[0-9A-Za-z_-]{1,200}$/;
const REQUEST_ID_PATTERN = /^project_deletion_[0-9A-Za-z_-]{1,200}$/;
const PREVIEW_PATTERN = /^project_erasure_preview_[0-9a-f]{64}$/;
const DELETE_TRIGGER_TABLES = [
  "accepted_context_entries",
  "accepted_project_state",
  "active_connection_targets",
  "audit_events",
  "candidate_claims",
  "candidate_context_targets",
  "context_access_grants",
  "context_entry_exclusions",
  "context_history_events",
  "context_read_events",
  "evidence_events",
  "evidence_file_sources",
  "file_context_references",
  "file_objects",
  "file_reference_exclusions",
  "file_upload_completions",
  "file_upload_intents",
  "project_deletion_requests",
  "project_invitations",
  "project_memberships",
  "projects",
  "work_contexts",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value) {
  return sha256(`alice-project-erasure-v1:${value}`);
}

function validatedInputs({ projectId, requestId }) {
  if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) {
    throw new Error("The project erasure identifier is invalid.");
  }
  if (!REQUEST_ID_PATTERN.test(String(requestId || ""))) {
    throw new Error("The deletion-request identifier is invalid.");
  }
  return { projectId, requestId };
}

async function existingJob(database, input) {
  return await database
    .prepare(
      `SELECT id, preview_version, object_key_count, object_version_count,
              object_manifest_sha256, shared_object_count, database_row_count, status, completed_at,
              active_data_deleted_at, provider_backup_expires_at
       FROM project_erasure_jobs
       WHERE project_fingerprint = ? AND deletion_request_fingerprint = ?
       LIMIT 1`,
    )
    .get(fingerprint(input.projectId), fingerprint(input.requestId));
}

function completedReceipt(job) {
  return {
    status: "completed",
    object_key_count: Number(job.object_key_count),
    object_version_count: Number(job.object_version_count),
    shared_object_count: Number(job.shared_object_count),
    database_row_count: Number(job.database_row_count),
    active_data_deleted_at: job.active_data_deleted_at,
    provider_backup_expires_at: job.provider_backup_expires_at,
  };
}

async function databasePlan(database, input, now, { lockLifecycle = false } = {}) {
  const project = await database
    .prepare(
      `SELECT workspace_id, updated_at, archived_at
       FROM projects
       WHERE id = ? AND archived_at IS NOT NULL
       ${lockLifecycle ? "FOR UPDATE" : ""}`,
    )
    .get(input.projectId);
  if (!project) throw new Error("Project erasure is not eligible.");
  const request = await database
    .prepare(
      `SELECT requested_at, not_before
       FROM project_deletion_requests
       WHERE workspace_id = ? AND project_id = ? AND id = ? AND cancelled_at IS NULL
       ${lockLifecycle ? "FOR UPDATE" : ""}`,
    )
    .get(project.workspace_id, input.projectId, input.requestId);
  if (!request) throw new Error("Project erasure is not eligible.");
  Object.assign(project, request);
  if (Date.parse(project.not_before) > now.getTime()) {
    throw new Error("The project deletion cooling-off period has not ended.");
  }

  const stagingKeys = await database
    .prepare(
      `SELECT staging_storage_key AS storage_key
       FROM file_upload_intents
       WHERE workspace_id = ? AND project_id = ?`,
    )
    .all(project.workspace_id, input.projectId);
  const orphanObjects = await database
    .prepare(
      `SELECT DISTINCT object.id, object.storage_key, object.content_sha256
       FROM file_objects object
       JOIN file_context_references reference
         ON reference.workspace_id = object.workspace_id
        AND reference.file_object_id = object.id
        AND reference.project_id = ?
       WHERE object.workspace_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM file_context_references retained
           WHERE retained.workspace_id = object.workspace_id
             AND retained.file_object_id = object.id
             AND retained.project_id <> ?
         )`,
    )
    .all(input.projectId, project.workspace_id, input.projectId);
  const shared = await database
    .prepare(
      `SELECT COUNT(DISTINCT object.id) AS count
       FROM file_objects object
       JOIN file_context_references reference
         ON reference.workspace_id = object.workspace_id
        AND reference.file_object_id = object.id
        AND reference.project_id = ?
       WHERE object.workspace_id = ?
         AND EXISTS (
           SELECT 1 FROM file_context_references retained
           WHERE retained.workspace_id = object.workspace_id
             AND retained.file_object_id = object.id
             AND retained.project_id <> ?
         )`,
    )
    .get(input.projectId, project.workspace_id, input.projectId);
  const keys = [
    ...new Set([
      ...stagingKeys.map(({ storage_key: key }) => key),
      ...orphanObjects.map(({ storage_key: key }) => key),
    ]),
  ].sort();
  if (keys.length > PROJECT_ERASURE_KEY_LIMIT) {
    throw new Error("The project erasure key inventory exceeds its operator limit.");
  }
  return {
    project,
    keys,
    orphanObjectIds: orphanObjects.map(({ id }) => id).sort(),
    orphanContentHashes: orphanObjects.map(({ content_sha256: hash }) => hash).sort(),
    sharedObjectCount: Number(shared.count),
  };
}

function erasurePreview(input, plan, versions) {
  if (versions.length > PROJECT_ERASURE_VERSION_LIMIT) {
    throw new Error("The project erasure version inventory exceeds its operator limit.");
  }
  const manifestSha256 = sha256(JSON.stringify({ keys: plan.keys, versions }));
  const previewVersion = `project_erasure_preview_${sha256(
    JSON.stringify({
      project_fingerprint: fingerprint(input.projectId),
      deletion_request_fingerprint: fingerprint(input.requestId),
      project_updated_at: plan.project.updated_at,
      project_archived_at: plan.project.archived_at,
      deletion_requested_at: plan.project.requested_at,
      deletion_not_before: plan.project.not_before,
      manifest_sha256: manifestSha256,
      shared_object_count: plan.sharedObjectCount,
    }),
  )}`;
  return { manifestSha256, previewVersion };
}

export async function previewProjectErasure({
  database,
  store,
  projectId,
  requestId,
  now = new Date(),
}) {
  const input = validatedInputs({ projectId, requestId });
  const existing = await existingJob(database, input);
  if (existing?.status === "completed") {
    return completedReceipt(existing);
  }
  if (existing?.status === "prepared") {
    await databasePlan(database, input, now);
    return {
      status: "prepared",
      preview_version: existing.preview_version,
      object_key_count: Number(existing.object_key_count),
      object_version_count: Number(existing.object_version_count),
      shared_object_count: Number(existing.shared_object_count),
    };
  }
  const plan = await databasePlan(database, input, now);
  const versions = await store.inventory(plan.keys);
  const preview = erasurePreview(input, plan, versions);
  return {
    status: "eligible",
    preview_version: preview.previewVersion,
    object_key_count: plan.keys.length,
    object_version_count: versions.length,
    shared_object_count: plan.sharedObjectCount,
  };
}

async function prepareJob(database, input, plan, versions, preview, now) {
  return await database.transaction(async () => {
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`project-erasure:${fingerprint(input.projectId)}`);
    const current = await databasePlan(database, input, now, { lockLifecycle: true });
    if (
      JSON.stringify(current.keys) !== JSON.stringify(plan.keys) ||
      current.sharedObjectCount !== plan.sharedObjectCount
    ) {
      throw new Error("The project erasure inventory changed before preparation.");
    }
    const existing = await database
      .prepare(
        `SELECT id, preview_version, object_manifest_sha256, object_key_count,
                object_version_count, shared_object_count, status
         FROM project_erasure_jobs
         WHERE project_fingerprint = ? AND deletion_request_fingerprint = ?`,
      )
      .get(fingerprint(input.projectId), fingerprint(input.requestId));
    if (existing) {
      if (
        existing.preview_version !== preview.previewVersion ||
        existing.object_manifest_sha256 !== preview.manifestSha256 ||
        Number(existing.object_key_count) !== plan.keys.length ||
        Number(existing.object_version_count) !== versions.length ||
        Number(existing.shared_object_count) !== plan.sharedObjectCount
      ) {
        throw new Error("The prepared erasure receipt does not match the exact inventory.");
      }
      return existing;
    }
    const id = `project_erasure_${randomUUID()}`;
    await database
      .prepare(
        `INSERT INTO project_erasure_jobs
         (id, project_id, project_fingerprint, deletion_request_fingerprint,
          preview_version, object_manifest_sha256, object_key_count, object_version_count,
          shared_object_count, database_row_count, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'prepared', ?)`,
      )
      .run(
        id,
        input.projectId,
        fingerprint(input.projectId),
        fingerprint(input.requestId),
        preview.previewVersion,
        preview.manifestSha256,
        plan.keys.length,
        versions.length,
        plan.sharedObjectCount,
        now.toISOString(),
      );
    return { id, status: "prepared" };
  });
}

async function deleteProjectRows(database, input, plan) {
  await database.exec(
    `CREATE TEMP TABLE alice_project_erasure_orphan_objects
     (id text PRIMARY KEY) ON COMMIT DROP`,
  );
  for (const objectId of plan.orphanObjectIds) {
    await database
      .prepare("INSERT INTO alice_project_erasure_orphan_objects (id) VALUES (?)")
      .run(objectId);
  }
  for (const table of DELETE_TRIGGER_TABLES) {
    await database.exec(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  }
  let deletedRows = 0;
  const remove = async (sql, ...parameters) => {
    const result = await database.prepare(sql).run(...parameters);
    deletedRows += result.changes;
  };
  const scoped = [plan.project.workspace_id, input.projectId];
  await remove(
    "DELETE FROM evidence_file_sources WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM file_upload_completions WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM file_upload_intents WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM file_reference_exclusions WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM file_context_references WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    `DELETE FROM file_objects object
     USING alice_project_erasure_orphan_objects orphan
     WHERE object.workspace_id = ? AND object.id = orphan.id`,
    plan.project.workspace_id,
  );
  await remove(
    "DELETE FROM context_entry_exclusions WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM accepted_context_entries WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM candidate_context_targets WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM accepted_project_state WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove("DELETE FROM candidate_claims WHERE workspace_id = ? AND project_id = ?", ...scoped);
  await remove("DELETE FROM evidence_events WHERE workspace_id = ? AND project_id = ?", ...scoped);
  await remove(
    "DELETE FROM context_read_events WHERE project_workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM active_connection_targets WHERE project_workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM context_access_grants WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM context_history_events WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove("DELETE FROM work_contexts WHERE workspace_id = ? AND project_id = ?", ...scoped);
  await remove(
    "DELETE FROM project_invitations WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove(
    "DELETE FROM project_memberships WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  await remove("DELETE FROM audit_events WHERE workspace_id = ? AND project_id = ?", ...scoped);
  await remove(
    "DELETE FROM project_deletion_requests WHERE workspace_id = ? AND project_id = ?",
    ...scoped,
  );
  const projectDeletion = await database
    .prepare("DELETE FROM projects WHERE workspace_id = ? AND id = ?")
    .run(...scoped);
  deletedRows += projectDeletion.changes;
  if (projectDeletion.changes !== 1) {
    throw new Error("The exact project row was not erased.");
  }
  for (const table of [...DELETE_TRIGGER_TABLES].reverse()) {
    await database.exec(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  return deletedRows;
}

export async function eraseProject({
  database,
  store,
  projectId,
  requestId,
  expectedPreviewVersion,
  providerBackupRetentionDays,
  now = new Date(),
}) {
  const input = validatedInputs({ projectId, requestId });
  if (!PREVIEW_PATTERN.test(String(expectedPreviewVersion || ""))) {
    throw new Error("The exact project erasure preview is required.");
  }
  if (
    !Number.isInteger(providerBackupRetentionDays) ||
    providerBackupRetentionDays < 1 ||
    providerBackupRetentionDays > 35
  ) {
    throw new Error("Provider backup retention must be 1 to 35 days.");
  }
  let job = await existingJob(database, input);
  if (job?.status === "completed") {
    if (job.preview_version !== expectedPreviewVersion) {
      throw new Error("The completed erasure receipt does not match the exact preview.");
    }
    return completedReceipt(job);
  }

  const plan = await databasePlan(database, input, now);
  const versions = await store.inventory(plan.keys);
  if (job?.status === "prepared") {
    if (
      job.preview_version !== expectedPreviewVersion ||
      Number(job.object_key_count) !== plan.keys.length ||
      Number(job.shared_object_count) !== plan.sharedObjectCount
    ) {
      throw new Error("The prepared project erasure receipt no longer matches.");
    }
  } else {
    const preview = erasurePreview(input, plan, versions);
    if (preview.previewVersion !== expectedPreviewVersion) {
      throw new Error("The project erasure preview changed. Run the preview again.");
    }
    job = await prepareJob(database, input, plan, versions, preview, now);
  }
  const completedAt = new Date(Math.max(Date.now(), now.getTime()));
  const backupExpiresAt = new Date(
    completedAt.getTime() + providerBackupRetentionDays * 24 * 60 * 60 * 1_000,
  );
  const result = await database.transaction(async () => {
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`project-erasure:${fingerprint(input.projectId)}`);
    const beforeObjectLocks = await databasePlan(database, input, completedAt, {
      lockLifecycle: true,
    });
    for (const contentHash of beforeObjectLocks.orphanContentHashes) {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`${beforeObjectLocks.project.workspace_id}:file:${contentHash}`);
    }
    const current = await databasePlan(database, input, completedAt);
    if (
      JSON.stringify(current.keys) !== JSON.stringify(plan.keys) ||
      current.sharedObjectCount !== plan.sharedObjectCount ||
      JSON.stringify(current.orphanContentHashes) !==
        JSON.stringify(beforeObjectLocks.orphanContentHashes)
    ) {
      throw new Error("The project changed before private object erasure; deletion stopped.");
    }
    const remainingVersions = await store.inventory(current.keys);
    await store.erase(current.keys, remainingVersions);
    const deletedRows = await deleteProjectRows(database, input, current);
    const updated = await database
      .prepare(
        `UPDATE project_erasure_jobs
         SET project_id = NULL, status = 'completed', database_row_count = ?,
             completed_at = ?, active_data_deleted_at = ?, provider_backup_expires_at = ?
         WHERE id = ? AND status = 'prepared' AND preview_version = ?`,
      )
      .run(
        deletedRows,
        completedAt.toISOString(),
        completedAt.toISOString(),
        backupExpiresAt.toISOString(),
        job.id,
        expectedPreviewVersion,
      );
    if (updated.changes !== 1) {
      throw new Error("The project erasure receipt did not complete exactly once.");
    }
    return { deletedRows };
  });
  return {
    status: "completed",
    object_key_count: plan.keys.length,
    object_version_count: Number(job.object_version_count ?? versions.length),
    shared_object_count: plan.sharedObjectCount,
    database_row_count: result.deletedRows,
    active_data_deleted_at: completedAt.toISOString(),
    provider_backup_expires_at: backupExpiresAt.toISOString(),
  };
}

export async function runProjectErasureOperator() {
  const mode = process.env.ALICE_PROJECT_ERASURE_MODE || "preview";
  if (!["preview", "execute"].includes(mode)) {
    throw new Error("ALICE_PROJECT_ERASURE_MODE must be preview or execute.");
  }
  const databaseUrl = process.env.ALICE_MIGRATION_DATABASE_URL;
  const bucket = process.env.ALICE_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!databaseUrl || !bucket || region !== "eu-central-1") {
    throw new Error(
      "The project erasure operator requires its private database, bucket, and region.",
    );
  }
  const database = await openDatabase({
    connectionString: databaseUrl,
    maxConnections: 1,
    migrate: true,
  });
  try {
    const store = createS3ProjectErasureStore({ bucket, region });
    const common = {
      database,
      store,
      projectId: process.env.ALICE_PROJECT_ERASURE_PROJECT_ID,
      requestId: process.env.ALICE_PROJECT_ERASURE_REQUEST_ID,
    };
    const result =
      mode === "preview"
        ? await previewProjectErasure(common)
        : await eraseProject({
            ...common,
            expectedPreviewVersion: process.env.ALICE_PROJECT_ERASURE_EXPECTED_PREVIEW,
            providerBackupRetentionDays: Number(process.env.ALICE_PROVIDER_BACKUP_RETENTION_DAYS),
          });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database.close();
  }
}

export function safeProjectErasureFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const reason = message.includes("cooling-off")
    ? "cooling_off"
    : message.includes("not eligible")
      ? "not_eligible"
      : message.includes("preview")
        ? "preview_changed"
        : "operator_failure";
  process.stderr.write(`${JSON.stringify({ status: "failed", reason })}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runProjectErasureOperator();
  } catch (error) {
    safeProjectErasureFailure(error);
  }
}
