import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { projectScopeForConnection, projectScopeForUser } from "./authorization.ts";
import { listProjects } from "./project-context.ts";
import {
  getLatestSaveCheckpoint,
  recordSaveConfirmationReceipt,
} from "./save-confirmation-receipts.ts";

export const ARTIFACT_SAVE_PREVIEW_LIFETIME_MS = 30 * 60 * 1_000;
export const ARTIFACT_READ_RECEIPT_LIFETIME_MS = 10 * 60 * 1_000;

export class ArtifactSaveUserError extends Error {}
export class ArtifactLifecycleUserError extends Error {}
export class ArtifactDecisionConflictUserError extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalSecretHash(expected: string, token: string): boolean {
  const actual = sha256(token);
  return (
    /^[0-9a-f]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
  );
}

function parsedArray(value: unknown): any[] {
  const parsed = JSON.parse(String(value));
  return Array.isArray(parsed) ? parsed : [];
}

function artifactLifecycleColumns() {
  return `COALESCE((
            SELECT lifecycle.lifecycle_state
            FROM artifact_lifecycle_events lifecycle
            WHERE lifecycle.workspace_id = artifact.workspace_id
              AND lifecycle.project_id = artifact.project_id
              AND lifecycle.artifact_id = artifact.id
            ORDER BY lifecycle.version DESC LIMIT 1
          ), 'active') AS lifecycle_state,
          COALESCE((
            SELECT lifecycle.version
            FROM artifact_lifecycle_events lifecycle
            WHERE lifecycle.workspace_id = artifact.workspace_id
              AND lifecycle.project_id = artifact.project_id
              AND lifecycle.artifact_id = artifact.id
            ORDER BY lifecycle.version DESC LIMIT 1
          ), 0) AS lifecycle_version,
          (
            SELECT lifecycle.replacement_artifact_id
            FROM artifact_lifecycle_events lifecycle
            WHERE lifecycle.workspace_id = artifact.workspace_id
              AND lifecycle.project_id = artifact.project_id
              AND lifecycle.artifact_id = artifact.id
            ORDER BY lifecycle.version DESC LIMIT 1
          ) AS replacement_artifact_id`;
}

export function artifactTitlePresentation(value: unknown, authoritativeVersion: number) {
  const storedTitle = String(value ?? "").trim();
  const match = storedTitle.match(/^(.*?)(?:\s*[-–—:|]\s*|\s+)(?:v(?:ersion)?\.?\s*)(\d+)\s*$/iu);
  if (!match || !match[1]?.trim()) {
    return { title: storedTitle, title_version_integrity: { status: "version_neutral" } };
  }
  const labelVersion = Number(match[2]!);
  const status = labelVersion === authoritativeVersion ? "matching_label" : "conflicting_label";
  return {
    title: match[1]!.trim(),
    title_version_integrity: {
      status,
      label_version: labelVersion,
      authoritative_version: authoritativeVersion,
      notice:
        status === "matching_label"
          ? `The stored title included a matching V${labelVersion} label. Alice's version badge is authoritative.`
          : `The stored title included V${labelVersion}, but Alice version ${authoritativeVersion} is authoritative.`,
    },
  };
}

function artifactRevisionQuery(extraWhere = "") {
  return `SELECT artifact.id AS artifact_id, artifact.created_at,
                 revision.id AS version_id, revision.version, revision.parent_version_id,
                 revision.title, revision.artifact_type, revision.category, revision.tags_json,
                 revision.content_storage_kind, revision.content_text, revision.storage_key,
                 revision.storage_version_id, revision.media_type, revision.content_sha256,
                 revision.content_utf8_bytes, revision.goal, revision.summary,
                 revision.decisions_json, revision.decision_records_json,
                 revision.constraints_json,
                 revision.rejected_directions_json, revision.open_questions_json,
                 revision.next_steps_json, revision.relevant_context_json,
                 revision.source_provider, revision.source_authority,
                 revision.migration_source_object_id, revision.saved_at,
                 ${artifactLifecycleColumns()}
          FROM artifacts artifact
          JOIN artifact_versions revision
            ON revision.workspace_id = artifact.workspace_id
           AND revision.project_id = artifact.project_id
           AND revision.artifact_id = artifact.id
          WHERE artifact.workspace_id = ? AND artifact.project_id = ? ${extraWhere}`;
}

function currentArtifactRevisionQuery(extraWhere = "") {
  return `${artifactRevisionQuery(extraWhere)}
            AND NOT EXISTS (
              SELECT 1 FROM artifact_versions newer
              WHERE newer.workspace_id = revision.workspace_id
                AND newer.project_id = revision.project_id
                AND newer.artifact_id = revision.artifact_id
                AND newer.version > revision.version
            )`;
}

function currentArtifactSearchQuery() {
  return `SELECT artifact.id AS artifact_id, revision.version, revision.title,
                 revision.artifact_type, revision.category, revision.tags_json,
                 revision.goal, revision.summary, revision.source_provider,
                 revision.source_authority, revision.migration_source_object_id,
                 revision.saved_at,
                 ${artifactLifecycleColumns()}
          FROM artifacts artifact
          JOIN artifact_versions revision
            ON revision.workspace_id = artifact.workspace_id
           AND revision.project_id = artifact.project_id
           AND revision.artifact_id = artifact.id
          WHERE artifact.workspace_id = ? AND artifact.project_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM artifact_versions newer
              WHERE newer.workspace_id = revision.workspace_id
                AND newer.project_id = revision.project_id
                AND newer.artifact_id = revision.artifact_id
                AND newer.version > revision.version
            )`;
}

function handoffFromRow(row) {
  return {
    goal: row.goal,
    ...(row.summary ? { summary: row.summary } : {}),
    decisions: parsedArray(row.decisions_json),
    decision_records: parsedArray(row.decision_records_json),
    constraints: parsedArray(row.constraints_json),
    rejected_directions: parsedArray(row.rejected_directions_json),
    open_questions: parsedArray(row.open_questions_json),
    next_steps: parsedArray(row.next_steps_json),
    relevant_context: parsedArray(row.relevant_context_json),
  };
}

function artifactResult(row, project, history: any[] = []) {
  const selectedVersion = Number(row.version);
  return {
    contract_version: "alice_artifact_v1",
    project: { id: project.id, name: project.name },
    artifact: {
      id: row.artifact_id,
      ...artifactTitlePresentation(row.title, selectedVersion),
      artifact_type: row.artifact_type,
      category: row.category,
      tags: parsedArray(row.tags_json),
      current_version: Number(row.current_version ?? row.version),
      selected_version: selectedVersion,
      content: row.content_text,
      content_utf8_bytes: Number(row.content_utf8_bytes),
      handoff: handoffFromRow(row),
      source: row.source_provider,
      authority: row.source_authority || "HUMAN_CONFIRMED",
      migration_source_object_id: row.migration_source_object_id || null,
      saved_at: row.saved_at,
      lifecycle: {
        state: row.lifecycle_state || "active",
        version: Number(row.lifecycle_version || 0),
        ...(row.replacement_artifact_id
          ? {
              replacement: {
                artifact_id: row.replacement_artifact_id,
                ...(row.replacement_title ? { title: row.replacement_title } : {}),
                ...(row.replacement_current_version
                  ? { current_version: Number(row.replacement_current_version) }
                  : {}),
                ...(row.replacement_lifecycle_state
                  ? { lifecycle_state: row.replacement_lifecycle_state }
                  : {}),
              },
            }
          : {}),
      },
      ...(history.length > 0 ? { history } : {}),
    },
  };
}

export async function listProjectArtifactActivity(
  database,
  input: { userId: string; projectId: string },
) {
  const access = await projectScopeForUser(database, {
    userId: input.userId,
    projectId: input.projectId,
    capability: "read",
  });
  if (!access) return undefined;
  const rows = await database
    .prepare(
      `SELECT revision.id AS version_id, revision.artifact_id, revision.version,
              revision.title, revision.artifact_type, revision.category,
              revision.tags_json, revision.goal, revision.summary,
              revision.source_provider, revision.saved_at
       FROM artifact_versions revision
       WHERE revision.workspace_id = ? AND revision.project_id = ?
         AND revision.source_authority = 'HUMAN_CONFIRMED'
       ORDER BY revision.saved_at DESC, revision.id DESC`,
    )
    .all(access.projectWorkspaceId, access.projectId);
  return rows.map((row) => ({
    ...row,
    ...artifactTitlePresentation(row.title, Number(row.version)),
    entry_kind: "artifact_version",
    version: Number(row.version),
    tags: parsedArray(row.tags_json),
  }));
}

async function currentRevision(
  database,
  workspaceId: string,
  projectId: string,
  artifactId: string,
) {
  return await database
    .prepare(currentArtifactRevisionQuery("AND artifact.id = ?"))
    .get(workspaceId, projectId, artifactId);
}

type ArtifactSavePreviewInput = {
  userId: string;
  connectionId: string;
  clientId: string;
  publicUrl: string;
  payload: any;
  artifactId?: string;
  retrievalReceipt?: string;
  now?: Date;
};

export async function createArtifactSavePreview(database, input: ArtifactSavePreviewInput) {
  if (input.artifactId) {
    return await database.transaction(async () =>
      createArtifactSavePreviewInternal(database, input),
    );
  }
  return await createArtifactSavePreviewInternal(database, input);
}

async function createArtifactSavePreviewInternal(database, input: ArtifactSavePreviewInput) {
  const access = await projectScopeForConnection(database, {
    userId: input.userId,
    connectionId: input.connectionId,
    projectId: input.payload.project_id,
    capability: "write",
  });
  if (!access || access.clientId !== input.clientId) {
    return { error: "The artifact save destination is unavailable." };
  }
  const connection = await database
    .prepare(
      `SELECT client_classification FROM integration_connections
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    )
    .get(input.connectionId, input.userId, access.userWorkspaceId);
  if (!connection || !["chatgpt", "claude"].includes(connection.client_classification)) {
    return { error: "The ChatGPT or Claude connection is unavailable." };
  }
  const project = await database
    .prepare("SELECT id, name FROM projects WHERE workspace_id = ? AND id = ?")
    .get(access.projectWorkspaceId, access.projectId);
  if (!project) return { error: "The artifact save destination is unavailable." };

  const current = input.artifactId
    ? await currentRevision(database, access.projectWorkspaceId, access.projectId, input.artifactId)
    : undefined;
  if (input.artifactId && !current) return { error: "The artifact is unavailable." };
  if (current && current.lifecycle_state !== "active") {
    return {
      error:
        "This artifact cannot receive versions unless a human restores its active lifecycle in Alice.",
    };
  }
  const saveKind = input.artifactId ? "new_version" : "create_artifact";
  const proposedVersion = current ? Number(current.version) + 1 : 1;
  const proposedTitle = artifactTitlePresentation(input.payload.title, proposedVersion);
  const currentTitle = current
    ? artifactTitlePresentation(current.title, Number(current.version))
    : undefined;
  const titleIdentityConflict = Boolean(
    currentTitle &&
    normalizeArtifactSearchText(currentTitle.title) !==
      normalizeArtifactSearchText(proposedTitle.title),
  );
  const versionLabelConflict = proposedTitle.title_version_integrity.status === "conflicting_label";
  const canSave = !titleIdentityConflict && !versionLabelConflict;
  let readReceipt;
  if (input.artifactId) {
    if (!input.retrievalReceipt) {
      return { error: "A fresh exact current artifact retrieval is required before versioning." };
    }
    const receiptHash = sha256(input.retrievalReceipt);
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`artifact-read-receipt:${receiptHash}`);
    readReceipt = await database
      .prepare(
        `SELECT receipt.*, use.receipt_id AS used_receipt_id
         FROM artifact_read_receipts receipt
         LEFT JOIN artifact_read_receipt_uses use ON use.receipt_id = receipt.id
         WHERE receipt.token_hash = ?`,
      )
      .get(receiptHash);
    const nowMs = (input.now || new Date()).getTime();
    if (
      !readReceipt ||
      readReceipt.used_receipt_id ||
      Number(readReceipt.expires_at) <= nowMs ||
      readReceipt.user_id !== input.userId ||
      readReceipt.connection_workspace_id !== access.userWorkspaceId ||
      readReceipt.connection_id !== input.connectionId ||
      readReceipt.client_id !== input.clientId ||
      readReceipt.workspace_id !== access.projectWorkspaceId ||
      readReceipt.project_id !== access.projectId ||
      readReceipt.artifact_id !== input.artifactId ||
      readReceipt.version_id !== current.version_id ||
      Number(readReceipt.version) !== Number(current.version) ||
      Number(readReceipt.lifecycle_version) !== Number(current.lifecycle_version || 0) ||
      readReceipt.title !== current.title
    ) {
      return { error: "A fresh exact current artifact retrieval is required before versioning." };
    }
  }
  const exactPayload = {
    ...input.payload,
    title: proposedTitle.title,
    ...(input.artifactId ? { artifact_id: input.artifactId } : {}),
  };
  const exactPayloadJson = JSON.stringify(exactPayload);
  const payloadSha256 = sha256(exactPayloadJson);
  const previewId = `artifact_save_preview_${randomUUID()}`;
  const authorityToken = `alice_save_${randomBytes(32).toString("base64url")}`;
  const now = input.now || new Date();
  const createdAt = now.toISOString();
  const expiresAt = now.getTime() + ARTIFACT_SAVE_PREVIEW_LIFETIME_MS;
  const lastSaved = await getLatestSaveCheckpoint(database, {
    workspaceId: access.projectWorkspaceId,
    projectId: access.projectId,
    connectionId: input.connectionId,
  });
  const previewBase = {
    contract_version: "alice_save_card_v1",
    card_type: "artifact",
    save_kind: saveKind,
    preview_id: previewId,
    destination: { project_id: project.id, project_name: project.name },
    artifact: {
      ...(input.artifactId ? { artifact_id: input.artifactId } : {}),
      title: exactPayload.title,
      artifact_type: exactPayload.artifact_type,
      category: exactPayload.category,
      tags: exactPayload.tags,
      content: exactPayload.content,
      handoff: exactPayload.handoff,
      version: proposedVersion,
      title_version_integrity: proposedTitle.title_version_integrity,
      identity: current
        ? {
            existing_artifact: currentTitle!.title,
            authoritative_current_alice_version: Number(current.version),
            proposed_next_alice_version: proposedVersion,
            proposed_title: exactPayload.title,
            conflict: titleIdentityConflict || versionLabelConflict,
            ...(titleIdentityConflict
              ? {
                  conflict_reason:
                    "The proposed title does not match the retrieved artifact identity.",
                }
              : versionLabelConflict
                ? {
                    conflict_reason: `The proposed title label disagrees with Alice version ${proposedVersion}.`,
                  }
                : {}),
          }
        : {
            proposed_next_alice_version: 1,
            proposed_title: exactPayload.title,
            conflict: versionLabelConflict,
            ...(versionLabelConflict
              ? { conflict_reason: "The proposed title label disagrees with Alice version 1." }
              : {}),
          },
      ...(current
        ? {
            replaces: {
              version: Number(current.version),
              title: currentTitle!.title,
              title_version_integrity: currentTitle!.title_version_integrity,
            },
          }
        : {}),
    },
    source_host: connection.client_classification,
    created_at: createdAt,
    expires_at: new Date(expiresAt).toISOString(),
    status: "awaiting_save",
    pre_save_state: "preview_only",
    trusted_state_changed: false,
    can_save: canSave,
    last_saved: lastSaved || null,
    fallback_url: new URL(
      `/artifact-save-previews/${encodeURIComponent(previewId)}`,
      input.publicUrl,
    ).href,
  };
  const previewVersion = sha256(JSON.stringify(previewBase));
  const preview = { ...previewBase, preview_version: previewVersion };
  await database
    .prepare("DELETE FROM artifact_save_previews WHERE expires_at <= ?")
    .run(now.getTime());
  await database
    .prepare(
      `INSERT INTO artifact_save_previews
        (id, workspace_id, project_id, user_id, connection_workspace_id,
         connection_id, client_id, source_provider, save_kind, artifact_id,
         current_version, exact_payload_json, payload_sha256, exact_preview_json,
         preview_version, authority_token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      previewId,
      access.projectWorkspaceId,
      access.projectId,
      input.userId,
      access.userWorkspaceId,
      input.connectionId,
      input.clientId,
      connection.client_classification,
      saveKind,
      input.artifactId || null,
      current ? Number(current.version) : 0,
      exactPayloadJson,
      payloadSha256,
      JSON.stringify(preview),
      previewVersion,
      sha256(authorityToken),
      createdAt,
      expiresAt,
    );
  if (readReceipt) {
    await database
      .prepare(
        `INSERT INTO artifact_read_receipt_uses (receipt_id, preview_id, used_at)
         VALUES (?, ?, ?)`,
      )
      .run(readReceipt.id, previewId, createdAt);
  }
  return { preview, authorityToken };
}

async function artifactPreviewRow(database, previewId: string, userId: string) {
  return await database
    .prepare("SELECT * FROM artifact_save_previews WHERE id = ? AND user_id = ?")
    .get(previewId, userId);
}

export async function getArtifactSavePreview(
  database,
  input: { previewId: string; userId: string; now?: Date },
) {
  const row = await artifactPreviewRow(database, input.previewId, input.userId);
  if (!row) return undefined;
  const access = await projectScopeForConnection(database, {
    userId: input.userId,
    connectionId: row.connection_id,
    projectId: row.project_id,
    capability: "write",
  });
  if (!access || access.clientId !== row.client_id) return undefined;
  return {
    ...JSON.parse(row.exact_preview_json),
    expired: Number(row.expires_at) <= (input.now || new Date()).getTime(),
  };
}

function artifactReceipt(
  row,
  artifactId: string,
  versionId: string,
  version: number,
  savedAt: string,
) {
  return {
    contract_version: "alice_artifact_save_receipt_v1",
    status: "saved",
    project_id: row.project_id,
    artifact_id: artifactId,
    version_id: versionId,
    version,
    source: row.source_provider,
    saved_at: savedAt,
    trusted_state_changed: true,
  };
}

async function persistArtifactReceipt(database, row, receipt, title: string) {
  return await recordSaveConfirmationReceipt(database, {
    previewId: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    userId: row.user_id,
    connectionWorkspaceId: row.connection_workspace_id,
    connectionId: row.connection_id,
    clientId: row.client_id,
    saveKind: "artifact",
    savedAt: receipt.saved_at,
    receipt: {
      artifact_id: receipt.artifact_id,
      version_id: receipt.version_id,
      version: receipt.version,
      title,
      source: receipt.source,
      selected_count: 1,
      trusted_state_changed: true,
    },
  });
}

export async function commitArtifactSavePreview(
  database,
  input: {
    previewId: string;
    previewVersion: string;
    userId: string;
    authority: "mcp_app" | "web_session";
    authorityToken?: string;
    now?: Date;
  },
) {
  return await database.transaction(async () => {
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`artifact-save-preview:${input.previewId}`);
    const row = await artifactPreviewRow(database, input.previewId, input.userId);
    if (!row) return undefined;
    if (row.artifact_id) {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`artifact-version:${row.workspace_id}:${row.project_id}:${row.artifact_id}`);
    }
    const now = input.now || new Date();
    if (Number(row.expires_at) <= now.getTime()) {
      await database.prepare("DELETE FROM artifact_save_previews WHERE id = ?").run(row.id);
      throw new ArtifactSaveUserError("This artifact Save preview expired. Nothing was saved.");
    }
    if (
      input.previewVersion !== row.preview_version ||
      (input.authority === "mcp_app" &&
        (!input.authorityToken || !equalSecretHash(row.authority_token_hash, input.authorityToken)))
    ) {
      throw new ArtifactSaveUserError(
        "The exact artifact Save authority is unavailable or the preview changed.",
      );
    }
    const access = await projectScopeForConnection(database, {
      userId: input.userId,
      connectionId: row.connection_id,
      projectId: row.project_id,
      capability: "write",
    });
    if (!access || access.clientId !== row.client_id) {
      throw new ArtifactSaveUserError("Project access changed. Review a new artifact Save card.");
    }
    const payload = JSON.parse(row.exact_payload_json);
    const exactPreview = JSON.parse(row.exact_preview_json);
    if (!exactPreview.can_save) {
      throw new ArtifactSaveUserError(
        "This artifact identity or title-version conflict must be corrected in a new Alice preview.",
      );
    }
    const duplicate = await database
      .prepare(
        `SELECT artifact_id, id AS version_id, version, payload_sha256, saved_at
         FROM artifact_versions
         WHERE source_connection_id = ? AND project_id = ? AND idempotency_key = ?`,
      )
      .get(row.connection_id, row.project_id, payload.idempotency_key);
    if (duplicate) {
      if (duplicate.payload_sha256 !== row.payload_sha256) {
        throw new ArtifactSaveUserError(
          "That artifact retry key was already used for different content.",
        );
      }
      const duplicateReceipt = artifactReceipt(
        row,
        duplicate.artifact_id,
        duplicate.version_id,
        Number(duplicate.version),
        duplicate.saved_at,
      );
      const receipt = await persistArtifactReceipt(database, row, duplicateReceipt, payload.title);
      await database.prepare("DELETE FROM artifact_save_previews WHERE id = ?").run(row.id);
      return { ...duplicateReceipt, ...receipt };
    }

    const current = row.artifact_id
      ? await currentRevision(database, row.workspace_id, row.project_id, row.artifact_id)
      : undefined;
    if (current && current.lifecycle_state !== "active") {
      throw new ArtifactSaveUserError(
        "This artifact cannot receive versions unless a human restores its active lifecycle in Alice.",
      );
    }
    if (
      (row.save_kind === "create_artifact" && current) ||
      (row.save_kind === "new_version" &&
        (!current || Number(current.version) !== Number(row.current_version)))
    ) {
      throw new ArtifactSaveUserError(
        "The artifact changed after this preview. Review a new exact Save card.",
      );
    }

    const artifactId = row.artifact_id || `artifact_${randomUUID()}`;
    const version = current ? Number(current.version) + 1 : 1;
    const versionId = `artifact_version_${randomUUID()}`;
    const savedAt = now.toISOString();
    if (!current) {
      await database
        .prepare(
          `INSERT INTO artifacts
            (id, workspace_id, project_id, created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(artifactId, row.workspace_id, row.project_id, input.userId, savedAt);
    }
    const contentBytes = Buffer.byteLength(payload.content, "utf8");
    await database
      .prepare(
        `INSERT INTO artifact_versions
          (id, workspace_id, project_id, artifact_id, version, parent_version_id,
           title, artifact_type, category, tags_json, content_storage_kind, content_text,
           storage_key, storage_version_id, media_type, content_sha256, content_utf8_bytes,
           goal, summary, decisions_json, decision_records_json, constraints_json,
           rejected_directions_json, open_questions_json, next_steps_json, relevant_context_json,
           source_connection_workspace_id, source_connection_id, source_client_id,
           source_provider, saved_by_user_id, idempotency_key, payload_sha256, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inline_text', ?, NULL, NULL,
                 'text/plain; charset=utf-8', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        row.workspace_id,
        row.project_id,
        artifactId,
        version,
        current?.version_id || null,
        payload.title,
        payload.artifact_type,
        payload.category,
        JSON.stringify(payload.tags),
        payload.content,
        sha256(payload.content),
        contentBytes,
        payload.handoff.goal,
        payload.handoff.summary || null,
        JSON.stringify(payload.handoff.decisions),
        JSON.stringify(payload.handoff.decision_records || []),
        JSON.stringify(payload.handoff.constraints),
        JSON.stringify(payload.handoff.rejected_directions),
        JSON.stringify(payload.handoff.open_questions),
        JSON.stringify(payload.handoff.next_steps),
        JSON.stringify(payload.handoff.relevant_context),
        row.connection_workspace_id,
        row.connection_id,
        row.client_id,
        row.source_provider,
        input.userId,
        payload.idempotency_key,
        row.payload_sha256,
        savedAt,
      );
    await appendAuditEvent(database, {
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      action: current ? "artifact_version_saved" : "artifact_created",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: `artifact_save_${versionId}`,
      metadata: {
        artifact_id: artifactId,
        version_id: versionId,
        version,
        source_provider: row.source_provider,
      },
    });
    const artifactSaveReceipt = artifactReceipt(row, artifactId, versionId, version, savedAt);
    const receipt = await persistArtifactReceipt(database, row, artifactSaveReceipt, payload.title);
    await database.prepare("DELETE FROM artifact_save_previews WHERE id = ?").run(row.id);
    return { ...artifactSaveReceipt, ...receipt };
  });
}

function timelineStart(timeline: string, now: Date): number | undefined {
  const days = {
    past_7_days: 7,
    past_28_days: 28,
    past_3_months: 92,
    past_year: 365,
  }[timeline];
  return days ? now.getTime() - days * 24 * 60 * 60 * 1_000 : undefined;
}

function filteredArtifactRows(
  rows,
  input: {
    query?: string;
    categories: string[];
    tags: string[];
    sources: string[];
    artifact_types: string[];
    timeline: string;
    limit: number;
    offset?: number;
    lifecycle?: "active" | "superseded" | "archived" | "all";
    include_unverified_imports?: boolean;
    now?: Date;
  },
) {
  const normalizedQuery = input.query ? normalizeArtifactSearchText(input.query) : "";
  const queryTokens = searchTokens(normalizedQuery);
  const start = timelineStart(input.timeline, input.now || new Date());
  const ranked = rows
    .filter((row) => {
      const tags = parsedArray(row.tags_json);
      if (!input.include_unverified_imports && row.source_authority === "IMPORTED_UNVERIFIED") {
        return false;
      }
      if (input.categories.length > 0 && !input.categories.includes(row.category)) return false;
      if (input.tags.length > 0 && !input.tags.every((tag) => tags.includes(tag))) return false;
      if (input.sources.length > 0 && !input.sources.includes(row.source_provider)) return false;
      if (input.artifact_types.length > 0 && !input.artifact_types.includes(row.artifact_type)) {
        return false;
      }
      if (start && new Date(row.saved_at).getTime() < start) return false;
      const lifecycle = input.lifecycle || "active";
      if (lifecycle !== "all" && row.lifecycle_state !== lifecycle) {
        return false;
      }
      return true;
    })
    .map((row) => {
      const tags = parsedArray(row.tags_json);
      const titlePresentation = artifactTitlePresentation(row.title, Number(row.version));
      const title = normalizeArtifactSearchText(titlePresentation.title);
      const metadata = normalizeArtifactSearchText(
        [titlePresentation.title, row.summary, row.goal, row.category, row.artifact_type, ...tags]
          .filter(Boolean)
          .join(" "),
      );
      const titleTokens = new Set(searchTokens(title));
      const metadataTokens = new Set(searchTokens(metadata));
      const matchedTokenCount = queryTokens.filter((token) => metadataTokens.has(token)).length;
      let matchRank = 6;
      let matchQuality = "browse";
      if (normalizedQuery) {
        if (title === normalizedQuery) {
          matchRank = 1;
          matchQuality = "exact_title";
        } else if (title.includes(normalizedQuery)) {
          matchRank = 2;
          matchQuality = "title_phrase";
        } else if (queryTokens.length > 0 && queryTokens.every((token) => titleTokens.has(token))) {
          matchRank = 3;
          matchQuality = "all_tokens_in_title";
        } else if (
          queryTokens.length > 0 &&
          queryTokens.every((token) => metadataTokens.has(token))
        ) {
          matchRank = 4;
          matchQuality = "all_tokens_across_metadata";
        } else if (matchedTokenCount > 0) {
          matchRank = 5;
          matchQuality = "partial_tokens";
        } else {
          return undefined;
        }
      }
      return {
        row,
        matchRank,
        matchQuality,
        matchedTokenCount,
        queryTokenCount: queryTokens.length,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.matchRank - right.matchRank ||
        right.matchedTokenCount - left.matchedTokenCount ||
        new Date(right.row.saved_at).getTime() - new Date(left.row.saved_at).getTime() ||
        String(left.row.artifact_id).localeCompare(String(right.row.artifact_id)),
    );
  const offset = input.offset || 0;
  const results = ranked.slice(offset, offset + input.limit).map((match) => {
    const row = match.row;
    return {
      artifact_id: row.artifact_id,
      ...artifactTitlePresentation(row.title, Number(row.version)),
      current_version: Number(row.version),
      artifact_type: row.artifact_type,
      category: row.category,
      tags: parsedArray(row.tags_json),
      summary: row.summary,
      goal: row.goal,
      source: row.source_provider,
      authority: row.source_authority || "HUMAN_CONFIRMED",
      saved_at: row.saved_at,
      lifecycle: {
        state: row.lifecycle_state,
        version: Number(row.lifecycle_version || 0),
        ...(row.replacement_artifact_id
          ? { replacement_artifact_id: row.replacement_artifact_id }
          : {}),
      },
      match: {
        quality: match.matchQuality,
        matched_query_tokens: match.matchedTokenCount,
        query_tokens: match.queryTokenCount,
        partial: match.matchQuality === "partial_tokens",
      },
    };
  });
  const resultCount = ranked.length;
  const nextOffset = offset + results.length;
  return {
    results,
    result_count: resultCount,
    returned_count: results.length,
    applied_limit: input.limit,
    offset,
    truncated: nextOffset < resultCount,
    continuation: nextOffset < resultCount ? { next_offset: nextOffset } : null,
    partial_results_included: results.some((result) => result.match.partial),
  };
}

export function normalizeArtifactSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function searchTokens(value: string): string[] {
  return [...new Set(value.split(" ").filter(Boolean))];
}

function canonicalDecisionValue(value: unknown): string {
  const normalize = (item: any): any => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

async function artifactDecisionConflictsForAccess(database, access) {
  const rows = await database
    .prepare(currentArtifactRevisionQuery())
    .all(access.projectWorkspaceId, access.projectId);
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    if (row.lifecycle_state !== "active") continue;
    for (const record of parsedArray(row.decision_records_json)) {
      const entry = {
        decision_key: record.decision_key,
        value: record.value,
        canonical_value: canonicalDecisionValue(record.value),
        artifact_id: row.artifact_id,
        title: artifactTitlePresentation(row.title, Number(row.version)).title,
        version_id: row.version_id,
        alice_version: Number(row.version),
        source: row.source_provider,
        saved_at: row.saved_at,
      };
      const existing = grouped.get(entry.decision_key) || [];
      existing.push(entry);
      grouped.set(entry.decision_key, existing);
    }
  }
  const candidates: any[] = [];
  for (const [decisionKey, records] of grouped) {
    if (new Set(records.map((record) => record.canonical_value)).size < 2) continue;
    records.sort(
      (left, right) =>
        left.artifact_id.localeCompare(right.artifact_id) ||
        left.version_id.localeCompare(right.version_id),
    );
    const fingerprint = sha256(
      JSON.stringify({
        project_id: access.projectId,
        decision_key: decisionKey,
        records: records.map((record) => ({
          artifact_id: record.artifact_id,
          version_id: record.version_id,
          canonical_value: record.canonical_value,
        })),
      }),
    );
    candidates.push({ decision_key: decisionKey, fingerprint, records });
  }
  const resolutions = await database
    .prepare(
      `SELECT conflict_fingerprint, selected_artifact_id, selected_version_id,
              selected_value_json, resolved_at
       FROM artifact_decision_resolutions
       WHERE workspace_id = ? AND project_id = ?`,
    )
    .all(access.projectWorkspaceId, access.projectId);
  const byFingerprint = new Map<string, any>(
    resolutions.map((row) => [row.conflict_fingerprint, row]),
  );
  return candidates
    .sort((left, right) => left.decision_key.localeCompare(right.decision_key))
    .map((candidate) => {
      const resolution = byFingerprint.get(candidate.fingerprint);
      return {
        decision_key: candidate.decision_key,
        conflict_fingerprint: candidate.fingerprint,
        status: resolution ? "human_resolved" : "unresolved",
        records: candidate.records.map((record) => ({
          decision_key: record.decision_key,
          value: record.value,
          artifact_id: record.artifact_id,
          title: record.title,
          version_id: record.version_id,
          alice_version: record.alice_version,
          source: record.source,
          saved_at: record.saved_at,
        })),
        ...(resolution
          ? {
              resolution: {
                selected_artifact_id: resolution.selected_artifact_id,
                selected_version_id: resolution.selected_version_id,
                selected_value: JSON.parse(resolution.selected_value_json),
                resolved_at: resolution.resolved_at,
                notice:
                  "An authenticated human selected this current record. The source artifacts remain immutable, and Alice does not verify which value is correct.",
              },
            }
          : {}),
        limitation:
          "Detected only because current active artifacts supplied the same explicit decision_key with different structured values; free-form semantic contradictions are not inferred.",
      };
    });
}

export async function searchProjectArtifacts(
  database,
  input: {
    userId: string;
    projectId: string;
    query?: string;
    categories: string[];
    tags: string[];
    sources: string[];
    artifact_types: string[];
    timeline: string;
    limit: number;
    offset?: number;
    lifecycle?: "active" | "superseded" | "archived" | "all";
    include_unverified_imports?: boolean;
    now?: Date;
  },
) {
  const access = await projectScopeForUser(database, {
    userId: input.userId,
    projectId: input.projectId,
    capability: "read",
  });
  if (!access) return undefined;
  const project = await database
    .prepare("SELECT id, name FROM projects WHERE workspace_id = ? AND id = ?")
    .get(access.projectWorkspaceId, access.projectId);
  if (!project) return undefined;
  const rows = await database
    .prepare(currentArtifactSearchQuery())
    .all(access.projectWorkspaceId, access.projectId);
  return {
    project,
    ...filteredArtifactRows(rows, input),
    decision_conflicts: await artifactDecisionConflictsForAccess(database, access),
  };
}

export async function searchAliceArtifacts(
  database,
  input: {
    userId: string;
    connectionId: string;
    query?: string;
    project_id?: string;
    project_name?: string;
    categories: string[];
    tags: string[];
    sources: string[];
    artifact_types: string[];
    timeline: string;
    limit: number;
    offset?: number;
    lifecycle?: "active" | "superseded" | "archived" | "all";
    now?: Date;
  },
) {
  const projects = await listProjects(database, input.userId);
  let matches = projects;
  if (input.project_id) matches = projects.filter((project) => project.id === input.project_id);
  if (input.project_name) {
    const name = input.project_name.toLocaleLowerCase();
    matches = projects.filter((project) => project.name.toLocaleLowerCase() === name);
  }
  if (!input.project_id && !input.project_name && projects.length !== 1) {
    return {
      contract_version: "alice_search_v1",
      status: "project_required" as const,
      projects: projects.map(({ id, name }) => ({ id, name })),
      results: [],
    };
  }
  if (matches.length !== 1) {
    return {
      contract_version: "alice_search_v1",
      status: (matches.length === 0 ? "project_unavailable" : "project_required") as
        "project_unavailable" | "project_required",
      projects: matches.map(({ id, name }) => ({ id, name })),
      results: [],
    };
  }
  const project = matches[0];
  const access = await projectScopeForConnection(database, {
    userId: input.userId,
    connectionId: input.connectionId,
    projectId: project.id,
    capability: "read",
  });
  if (!access) {
    return {
      contract_version: "alice_search_v1",
      status: "project_unavailable" as const,
      projects: [],
      results: [],
    };
  }
  const rows = await database
    .prepare(currentArtifactSearchQuery())
    .all(access.projectWorkspaceId, project.id);
  const page = filteredArtifactRows(rows, input);
  return {
    contract_version: "alice_search_v1",
    status: "ok" as const,
    project: { id: project.id, name: project.name },
    ...page,
    decision_conflicts: await artifactDecisionConflictsForAccess(database, access),
  };
}

async function getArtifactForScope(
  database,
  access,
  input: {
    projectId: string;
    artifactId: string;
    version?: number;
    includeHistory?: boolean;
  },
) {
  const project = await database
    .prepare("SELECT id, name FROM projects WHERE workspace_id = ? AND id = ?")
    .get(access.projectWorkspaceId, input.projectId);
  if (!project) return undefined;
  const current = await currentRevision(
    database,
    access.projectWorkspaceId,
    input.projectId,
    input.artifactId,
  );
  if (!current) return undefined;
  let selected = current;
  if (input.version && input.version !== Number(current.version)) {
    selected = await database
      .prepare(artifactRevisionQuery("AND artifact.id = ? AND revision.version = ?"))
      .get(access.projectWorkspaceId, input.projectId, input.artifactId, input.version);
  }
  if (!selected || selected.content_storage_kind !== "inline_text") return undefined;
  selected.current_version = Number(current.version);
  if (selected.replacement_artifact_id) {
    const replacement = await currentRevision(
      database,
      access.projectWorkspaceId,
      input.projectId,
      selected.replacement_artifact_id,
    );
    if (replacement) {
      selected.replacement_title = artifactTitlePresentation(
        replacement.title,
        Number(replacement.version),
      ).title;
      selected.replacement_current_version = Number(replacement.version);
      selected.replacement_lifecycle_state = replacement.lifecycle_state;
    }
  }
  let history: any[] = [];
  if (input.includeHistory) {
    history = await database
      .prepare(
        `SELECT version, title, source_provider AS source, saved_at
         FROM artifact_versions
         WHERE workspace_id = ? AND project_id = ? AND artifact_id = ?
         ORDER BY version DESC`,
      )
      .all(access.projectWorkspaceId, input.projectId, input.artifactId);
    history = history.map((item) => {
      const version = Number(item.version);
      return { ...item, ...artifactTitlePresentation(item.title, version), version };
    });
  }
  const result: any = artifactResult(selected, project, history);
  const conflicts = await artifactDecisionConflictsForAccess(database, access);
  result.artifact.decision_conflicts = conflicts.filter((conflict) =>
    conflict.records.some((record) => record.artifact_id === input.artifactId),
  );
  return result;
}

export async function getProjectArtifact(
  database,
  input: {
    userId: string;
    projectId: string;
    artifactId: string;
    version?: number;
    includeHistory?: boolean;
  },
) {
  const access = await projectScopeForUser(database, {
    userId: input.userId,
    projectId: input.projectId,
    capability: "read",
  });
  if (!access) return undefined;
  return await getArtifactForScope(database, access, input);
}

export async function getAliceArtifact(
  database,
  input: {
    userId: string;
    connectionId: string;
    projectId: string;
    artifactId: string;
    version?: number;
    includeHistory?: boolean;
  },
) {
  const access = await projectScopeForConnection(database, {
    userId: input.userId,
    connectionId: input.connectionId,
    projectId: input.projectId,
    capability: "read",
  });
  if (!access) return undefined;
  const result = await getArtifactForScope(database, access, input);
  if (result?.artifact.authority === "IMPORTED_UNVERIFIED") return undefined;
  if (
    !result ||
    result.artifact.selected_version !== result.artifact.current_version ||
    result.artifact.lifecycle.state !== "active"
  )
    return result;
  const current = await currentRevision(
    database,
    access.projectWorkspaceId,
    input.projectId,
    input.artifactId,
  );
  if (!current) return undefined;
  const now = new Date();
  const token = `alice_artifact_read_${randomBytes(32).toString("base64url")}`;
  const receiptId = `artifact_read_receipt_${randomUUID()}`;
  const expiresAt = now.getTime() + ARTIFACT_READ_RECEIPT_LIFETIME_MS;
  await database
    .prepare(
      `DELETE FROM artifact_read_receipts
       WHERE expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM artifact_read_receipt_uses use
           WHERE use.receipt_id = artifact_read_receipts.id
         )`,
    )
    .run(now.getTime());
  await database
    .prepare(
      `INSERT INTO artifact_read_receipts
        (id, workspace_id, project_id, user_id, connection_workspace_id, connection_id,
         client_id, artifact_id, version_id, version, lifecycle_version, title, token_hash,
         created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receiptId,
      access.projectWorkspaceId,
      input.projectId,
      input.userId,
      access.userWorkspaceId,
      input.connectionId,
      access.clientId,
      input.artifactId,
      current.version_id,
      Number(current.version),
      Number(current.lifecycle_version || 0),
      current.title,
      sha256(token),
      now.toISOString(),
      expiresAt,
    );
  const artifact: any = result.artifact;
  artifact.retrieval_receipt = {
    token,
    expires_at: new Date(expiresAt).toISOString(),
    purpose: "single_use_current_version_preview",
  };
  return result;
}

export async function getArtifactLifecycleControl(
  database,
  input: { userId: string; projectId: string; artifactId: string },
) {
  const access = await projectScopeForUser(database, {
    userId: input.userId,
    projectId: input.projectId,
    capability: "write",
  });
  if (!access) return undefined;
  const current = await currentRevision(
    database,
    access.projectWorkspaceId,
    access.projectId,
    input.artifactId,
  );
  if (!current) return undefined;
  return {
    state: current.lifecycle_state,
    version: Number(current.lifecycle_version || 0),
    replacement_artifact_id: current.replacement_artifact_id || null,
  };
}

export async function getArtifactDecisionConflictControl(
  database,
  input: { userId: string; projectId: string },
) {
  const access = await projectScopeForUser(database, {
    userId: input.userId,
    projectId: input.projectId,
    capability: "write",
  });
  if (!access) return undefined;
  return {
    decision_conflicts: await artifactDecisionConflictsForAccess(database, access),
  };
}

export async function resolveArtifactDecisionConflict(
  database,
  input: {
    userId: string;
    projectId: string;
    conflictFingerprint: string;
    selectedVersionId: string;
  },
) {
  if (!/^[0-9a-f]{64}$/.test(input.conflictFingerprint)) return undefined;
  return await database.transaction(
    async () => {
      const access = await projectScopeForUser(database, {
        userId: input.userId,
        projectId: input.projectId,
        capability: "write",
      });
      if (!access) return undefined;
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(
          `artifact-decision-conflict:${access.projectWorkspaceId}:${access.projectId}:${input.conflictFingerprint}`,
        );
      const conflicts = await artifactDecisionConflictsForAccess(database, access);
      const conflict = conflicts.find(
        (candidate) => candidate.conflict_fingerprint === input.conflictFingerprint,
      );
      if (!conflict) {
        throw new ArtifactDecisionConflictUserError(
          "The decision conflict changed. Review the current exact records before resolving it.",
        );
      }
      const selected = conflict.records.find(
        (record) => record.version_id === input.selectedVersionId,
      );
      if (!selected) {
        throw new ArtifactDecisionConflictUserError(
          "Choose one exact current record shown in this decision conflict.",
        );
      }
      const existing = await database
        .prepare(
          `SELECT id, selected_artifact_id, selected_version_id, selected_value_json, resolved_at
         FROM artifact_decision_resolutions
         WHERE workspace_id = ? AND project_id = ? AND conflict_fingerprint = ?`,
        )
        .get(access.projectWorkspaceId, access.projectId, input.conflictFingerprint);
      if (existing) {
        if (existing.selected_version_id !== selected.version_id) {
          throw new ArtifactDecisionConflictUserError(
            "This exact decision conflict already has a human resolution. Its immutable selection was not changed.",
          );
        }
        return {
          decision_key: conflict.decision_key,
          conflict_fingerprint: input.conflictFingerprint,
          selected_artifact_id: existing.selected_artifact_id,
          selected_version_id: existing.selected_version_id,
          selected_value: JSON.parse(existing.selected_value_json),
          resolved_at: existing.resolved_at,
        };
      }
      const resolvedAt = new Date().toISOString();
      const resolutionId = `artifact_decision_resolution_${randomUUID()}`;
      await database
        .prepare(
          `INSERT INTO artifact_decision_resolutions
          (id, workspace_id, project_id, decision_key, conflict_fingerprint,
           selected_artifact_id, selected_version_id, selected_value_json,
           resolved_by_user_id, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resolutionId,
          access.projectWorkspaceId,
          access.projectId,
          conflict.decision_key,
          input.conflictFingerprint,
          selected.artifact_id,
          selected.version_id,
          canonicalDecisionValue(selected.value),
          input.userId,
          resolvedAt,
        );
      await appendAuditEvent(database, {
        workspaceId: access.projectWorkspaceId,
        projectId: access.projectId,
        action: "artifact_decision_conflict_resolved",
        actorType: "human_user",
        actorId: input.userId,
        correlationId: resolutionId,
        metadata: {
          decision_key: conflict.decision_key,
          conflict_fingerprint: input.conflictFingerprint,
          selected_artifact_id: selected.artifact_id,
          selected_version_id: selected.version_id,
        },
      });
      return {
        decision_key: conflict.decision_key,
        conflict_fingerprint: input.conflictFingerprint,
        selected_artifact_id: selected.artifact_id,
        selected_version_id: selected.version_id,
        selected_value: selected.value,
        resolved_at: resolvedAt,
      };
    },
    { isolation: "READ COMMITTED" },
  );
}

export async function listArtifactLifecycleReplacements(
  database,
  input: { userId: string; projectId: string; artifactId: string },
) {
  const access = await projectScopeForUser(database, {
    userId: input.userId,
    projectId: input.projectId,
    capability: "write",
  });
  if (!access) return undefined;
  const rows = await database
    .prepare(currentArtifactSearchQuery())
    .all(access.projectWorkspaceId, access.projectId);
  return rows
    .filter((row) => row.artifact_id !== input.artifactId && row.lifecycle_state === "active")
    .map((row) => ({
      artifact_id: row.artifact_id,
      ...artifactTitlePresentation(row.title, Number(row.version)),
      current_version: Number(row.version),
    }))
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title) || left.artifact_id.localeCompare(right.artifact_id),
    );
}

export async function changeArtifactLifecycle(
  database,
  input: {
    userId: string;
    projectId: string;
    artifactId: string;
    action: "archive" | "restore" | "supersede";
    expectedVersion: number;
    replacementArtifactId?: string;
  },
) {
  return await database.transaction(async () => {
    const access = await projectScopeForUser(database, {
      userId: input.userId,
      projectId: input.projectId,
      capability: "write",
    });
    if (!access) return undefined;
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(
        `artifact-lifecycle:${access.projectWorkspaceId}:${access.projectId}:${input.artifactId}`,
      );
    const current = await currentRevision(
      database,
      access.projectWorkspaceId,
      access.projectId,
      input.artifactId,
    );
    if (!current) return undefined;
    const currentLifecycleVersion = Number(current.lifecycle_version || 0);
    if (input.expectedVersion !== currentLifecycleVersion) {
      throw new ArtifactLifecycleUserError(
        "The artifact lifecycle changed. Review its current state before trying again.",
      );
    }
    let nextState: "active" | "superseded" | "archived";
    let replacementArtifactId: string | null = null;
    if (input.action === "archive") {
      if (current.lifecycle_state !== "active") {
        throw new ArtifactLifecycleUserError("Only an active artifact can be archived.");
      }
      nextState = "archived";
    } else if (input.action === "supersede") {
      if (current.lifecycle_state !== "active" || !input.replacementArtifactId) {
        throw new ArtifactLifecycleUserError(
          "Choose an exact active replacement for the active artifact.",
        );
      }
      const replacement = await currentRevision(
        database,
        access.projectWorkspaceId,
        access.projectId,
        input.replacementArtifactId,
      );
      if (
        !replacement ||
        replacement.artifact_id === input.artifactId ||
        replacement.lifecycle_state !== "active"
      ) {
        throw new ArtifactLifecycleUserError("The replacement artifact is unavailable.");
      }
      nextState = "superseded";
      replacementArtifactId = replacement.artifact_id;
    } else {
      if (!["archived", "superseded"].includes(current.lifecycle_state)) {
        throw new ArtifactLifecycleUserError(
          "Only an archived or superseded artifact can be restored.",
        );
      }
      nextState = "active";
    }
    const version = currentLifecycleVersion + 1;
    const changedAt = new Date().toISOString();
    const eventId = `artifact_lifecycle_${randomUUID()}`;
    await database
      .prepare(
        `INSERT INTO artifact_lifecycle_events
          (id, workspace_id, project_id, artifact_id, version, lifecycle_state,
           replacement_artifact_id, changed_by_user_id, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        access.projectWorkspaceId,
        access.projectId,
        input.artifactId,
        version,
        nextState,
        replacementArtifactId,
        input.userId,
        changedAt,
      );
    await appendAuditEvent(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: access.projectId,
      action: input.action === "restore" ? "artifact_restored" : `artifact_${nextState}`,
      actorType: "human_user",
      actorId: input.userId,
      correlationId: `artifact_lifecycle_${eventId}`,
      metadata: {
        artifact_id: input.artifactId,
        lifecycle_version: version,
        lifecycle_state: nextState,
        ...(replacementArtifactId ? { replacement_artifact_id: replacementArtifactId } : {}),
      },
    });
    return {
      artifact_id: input.artifactId,
      lifecycle: {
        state: nextState,
        version,
        ...(replacementArtifactId ? { replacement_artifact_id: replacementArtifactId } : {}),
      },
    };
  });
}
