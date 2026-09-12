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
                 revision.decisions_json, revision.constraints_json,
                 revision.rejected_directions_json, revision.open_questions_json,
                 revision.next_steps_json, revision.relevant_context_json,
                 revision.source_provider, revision.saved_at
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
                 revision.goal, revision.summary, revision.source_provider, revision.saved_at
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
      saved_at: row.saved_at,
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
           goal, summary, decisions_json, constraints_json, rejected_directions_json,
           open_questions_json, next_steps_json, relevant_context_json,
           source_connection_workspace_id, source_connection_id, source_client_id,
           source_provider, saved_by_user_id, idempotency_key, payload_sha256, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inline_text', ?, NULL, NULL,
                 'text/plain; charset=utf-8', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now?: Date;
  },
) {
  const normalizedQuery = input.query ? normalizeArtifactSearchText(input.query) : "";
  const queryTokens = searchTokens(normalizedQuery);
  const start = timelineStart(input.timeline, input.now || new Date());
  const ranked = rows
    .filter((row) => {
      const tags = parsedArray(row.tags_json);
      if (input.categories.length > 0 && !input.categories.includes(row.category)) return false;
      if (input.tags.length > 0 && !input.tags.every((tag) => tags.includes(tag))) return false;
      if (input.sources.length > 0 && !input.sources.includes(row.source_provider)) return false;
      if (input.artifact_types.length > 0 && !input.artifact_types.includes(row.artifact_type)) {
        return false;
      }
      if (start && new Date(row.saved_at).getTime() < start) return false;
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
      saved_at: row.saved_at,
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
  return artifactResult(selected, project, history);
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
  if (!result || result.artifact.selected_version !== result.artifact.current_version)
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
         client_id, artifact_id, version_id, version, title, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
