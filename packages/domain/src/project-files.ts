import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForUser } from "./authorization.ts";

export const FILE_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

export class ProjectFileUserError extends Error {}

const MEDIA_LIMITS = {
  "application/pdf": FILE_UPLOAD_LIMIT_BYTES,
  "image/jpeg": 10 * 1024 * 1024,
  "image/png": 10 * 1024 * 1024,
  "image/webp": 10 * 1024 * 1024,
  "text/markdown": 2 * 1024 * 1024,
  "text/plain": 2 * 1024 * 1024,
} as const;

export type VerifiedFileMediaType = keyof typeof MEDIA_LIMITS;
export type FileScanStatus =
  | "pending_upload"
  | "scanning"
  | "clean"
  | "threats_found"
  | "unsupported"
  | "scan_failed"
  | "storage_failed";
export type ProviderScanResult = "pending" | "clean" | "threats_found" | "unsupported" | "failed";

export interface PrivateFileStore {
  putObject(input: {
    key: string;
    bytes: Buffer;
    mediaType: VerifiedFileMediaType;
    sha256: string;
  }): Promise<{ versionId: string; etag: string | null }>;
  getScanResult(input: { key: string; versionId: string }): Promise<ProviderScanResult>;
  createSignedDownload(input: {
    key: string;
    versionId: string;
    displayName: string;
    mediaType: VerifiedFileMediaType;
    expiresInSeconds: number;
  }): Promise<string>;
}

type ValidatedFile = {
  bytes: Buffer;
  displayName: string;
  mediaType: VerifiedFileMediaType;
  sha256: string;
};

function sanitizeDisplayName(value: string): string {
  const name = value
    .normalize("NFKC")
    .replace(/[\\/]/g, "_")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? "_" : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name === "." || name === ".." || name.length > 180) {
    throw new ProjectFileUserError("The file name must contain 1 to 180 safe characters.");
  }
  return name;
}

function extensionFor(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

function hasPrefix(bytes: Buffer, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function detectMediaType(bytes: Buffer, name: string): VerifiedFileMediaType {
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1");
    if (!tail.includes("%%EOF")) {
      throw new ProjectFileUserError("The PDF is incomplete or malformed.");
    }
    return "application/pdf";
  }
  if (
    hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    bytes.length >= 24 &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    return "image/webp";
  }

  const extension = extensionFor(name);
  if (![".md", ".txt"].includes(extension)) {
    throw new ProjectFileUserError(
      "Only PDF, PNG, JPEG, WebP, plain-text, and Markdown files are accepted.",
    );
  }
  if (bytes.includes(0)) throw new ProjectFileUserError("Text files cannot contain null bytes.");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectFileUserError("Text files must contain valid UTF-8.");
  }
  return extension === ".md" ? "text/markdown" : "text/plain";
}

function allowedExtensions(mediaType: VerifiedFileMediaType): string[] {
  return {
    "application/pdf": [".pdf"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
    "image/webp": [".webp"],
    "text/markdown": [".md"],
    "text/plain": [".txt"],
  }[mediaType];
}

function normalizeClaimedMediaType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() || "";
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

export function validateProjectFile(input: {
  bytes: Buffer | Uint8Array;
  fileName: string;
  claimedMediaType?: string;
}): ValidatedFile {
  const bytes = Buffer.from(input.bytes);
  if (bytes.length < 1 || bytes.length > FILE_UPLOAD_LIMIT_BYTES) {
    throw new ProjectFileUserError(
      `Files must contain data and be no larger than ${FILE_UPLOAD_LIMIT_BYTES} bytes.`,
    );
  }
  const displayName = sanitizeDisplayName(input.fileName);
  const mediaType = detectMediaType(bytes, displayName);
  if (!allowedExtensions(mediaType).includes(extensionFor(displayName))) {
    throw new ProjectFileUserError("The file extension does not match the verified file type.");
  }
  if (bytes.length > MEDIA_LIMITS[mediaType]) {
    throw new ProjectFileUserError(
      `This ${mediaType} file exceeds its ${MEDIA_LIMITS[mediaType]} byte limit.`,
    );
  }
  const claimed = normalizeClaimedMediaType(input.claimedMediaType || "");
  const permittedClaims =
    mediaType === "text/markdown" ? ["text/markdown", "text/plain"] : [mediaType];
  if (claimed && claimed !== "application/octet-stream" && !permittedClaims.includes(claimed)) {
    throw new ProjectFileUserError(
      "The supplied media type does not match the verified file type.",
    );
  }
  return {
    bytes,
    displayName,
    mediaType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function authorizedContext(database, userId: string, projectId: string, contextId: string) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const context = await database
    .prepare(
      `SELECT p.id AS project_id, p.name AS project_name, c.id AS context_id, c.name AS context_name
       FROM projects p
       JOIN work_contexts c ON c.workspace_id = p.workspace_id AND c.project_id = p.id
       WHERE p.workspace_id = ? AND p.id = ? AND c.id = ? AND c.archived_at IS NULL`,
    )
    .get(tenant.workspaceId, projectId, contextId);
  if (!context) return undefined;
  return { ...context, workspaceId: tenant.workspaceId };
}

export async function uploadProjectFile(
  database,
  store: PrivateFileStore,
  input: {
    userId: string;
    projectId: string;
    contextId: string;
    fileName: string;
    claimedMediaType?: string;
    bytes: Buffer | Uint8Array;
    sourceHost?: string;
  },
) {
  const file = validateProjectFile(input);
  const context = await authorizedContext(database, input.userId, input.projectId, input.contextId);
  if (!context) return undefined;

  const correlationId = `file_upload_${randomUUID()}`;
  let object;
  let reference;
  let shouldUpload = false;
  await database.transaction(async () => {
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`${context.workspaceId}:file:${file.sha256}`);
    object = await database
      .prepare(
        `SELECT id, byte_size, verified_media_type, storage_key, storage_version_id, scan_status
         FROM file_objects WHERE workspace_id = ? AND content_sha256 = ? FOR UPDATE`,
      )
      .get(context.workspaceId, file.sha256);
    if (!object) {
      const id = `file_${randomUUID()}`;
      object = {
        byte_size: file.bytes.length,
        id,
        storage_key: `objects/${randomUUID()}`,
        storage_version_id: null,
        scan_status: "pending_upload",
        verified_media_type: file.mediaType,
      };
      const now = new Date().toISOString();
      await database
        .prepare(
          `INSERT INTO file_objects
            (id, workspace_id, content_sha256, byte_size, verified_media_type, storage_key,
             scan_provider, scan_status, scan_updated_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'aws_guardduty_s3', 'pending_upload', ?, ?)`,
        )
        .run(
          id,
          context.workspaceId,
          file.sha256,
          file.bytes.length,
          file.mediaType,
          object.storage_key,
          now,
          now,
        );
      shouldUpload = true;
    } else if (object.verified_media_type !== file.mediaType) {
      throw new ProjectFileUserError("The file type conflicts with an existing exact-byte object.");
    } else if (object.scan_status === "storage_failed") {
      await database
        .prepare(
          `UPDATE file_objects SET scan_status = 'pending_upload', scan_updated_at = ?
           WHERE workspace_id = ? AND id = ? AND scan_status = 'storage_failed'`,
        )
        .run(new Date().toISOString(), context.workspaceId, object.id);
      object.scan_status = "pending_upload";
      shouldUpload = true;
    } else if (["threats_found", "unsupported", "scan_failed"].includes(object.scan_status)) {
      throw new ProjectFileUserError("This file could not be accepted.");
    }

    reference = await database
      .prepare(
        `SELECT r.id, r.display_name, r.referenced_at, e.id AS exclusion_id
         FROM file_context_references r
         LEFT JOIN file_reference_exclusions e
           ON e.workspace_id = r.workspace_id AND e.project_id = r.project_id
          AND e.context_id = r.context_id AND e.file_reference_id = r.id
         WHERE r.workspace_id = ? AND r.project_id = ?
           AND r.context_id = ? AND r.file_object_id = ?`,
      )
      .get(context.workspaceId, input.projectId, input.contextId, object.id);
    if (!reference) {
      reference = {
        id: `file_ref_${randomUUID()}`,
        display_name: file.displayName,
        referenced_at: new Date().toISOString(),
      };
      await database
        .prepare(
          `INSERT INTO file_context_references
            (id, workspace_id, project_id, context_id, file_object_id, display_name,
             source_host, uploader_user_id, access_scope, referenced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inherit_context', ?)`,
        )
        .run(
          reference.id,
          context.workspaceId,
          input.projectId,
          input.contextId,
          object.id,
          file.displayName,
          String(input.sourceHost || "alice_web").slice(0, 80),
          input.userId,
          reference.referenced_at,
        );
      await appendAuditEvent(database, {
        workspaceId: context.workspaceId,
        projectId: input.projectId,
        action: "file_reference_created",
        actorType: "human_user",
        actorId: input.userId,
        correlationId,
        metadata: {
          context_id: input.contextId,
          file_object_id: object.id,
          file_reference_id: reference.id,
          source_host: String(input.sourceHost || "alice_web").slice(0, 80),
        },
      });
    } else if (reference.exclusion_id) {
      throw new ProjectFileUserError(
        "This exact file was removed from this context. Upload a changed version to add it again.",
      );
    }
  });

  if (shouldUpload) {
    try {
      const stored = await store.putObject({
        key: object.storage_key,
        bytes: file.bytes,
        mediaType: file.mediaType,
        sha256: file.sha256,
      });
      if (!stored.versionId) throw new Error("Private object storage did not return a version.");
      await database.transaction(async () => {
        await database
          .prepare(
            `UPDATE file_objects
             SET storage_version_id = ?, storage_etag = ?, scan_status = 'scanning', scan_updated_at = ?
             WHERE workspace_id = ? AND id = ? AND scan_status = 'pending_upload'`,
          )
          .run(
            stored.versionId,
            stored.etag,
            new Date().toISOString(),
            context.workspaceId,
            object.id,
          );
        await appendAuditEvent(database, {
          workspaceId: context.workspaceId,
          projectId: input.projectId,
          action: "file_upload_received_for_scan",
          actorType: "human_user",
          actorId: input.userId,
          correlationId,
          metadata: {
            byte_size: file.bytes.length,
            file_object_id: object.id,
            verified_media_type: file.mediaType,
          },
        });
      });
      object.scan_status = "scanning";
      object.storage_version_id = stored.versionId;
    } catch (error) {
      await database.transaction(async () => {
        const failed = await database
          .prepare(
            `UPDATE file_objects SET scan_status = 'storage_failed', scan_updated_at = ?
             WHERE workspace_id = ? AND id = ? AND scan_status = 'pending_upload'`,
          )
          .run(new Date().toISOString(), context.workspaceId, object.id);
        if (failed.changes) {
          await appendAuditEvent(database, {
            workspaceId: context.workspaceId,
            projectId: input.projectId,
            action: "file_upload_failed",
            actorType: "human_user",
            actorId: input.userId,
            correlationId,
            metadata: { file_object_id: object.id, scan_status: "storage_failed" },
          });
        }
      });
      throw new ProjectFileUserError(
        "The private file upload failed before scanning. Please retry.",
        {
          cause: error,
        },
      );
    }
  }

  return {
    context,
    id: reference.id,
    object_id: object.id,
    display_name: reference.display_name,
    media_type: object.verified_media_type,
    byte_size: object.byte_size,
    scan_status: object.scan_status as FileScanStatus,
  };
}

export async function listProjectFiles(
  database,
  input: {
    userId: string;
    projectId: string;
    contextId: string;
  },
) {
  const context = await authorizedContext(database, input.userId, input.projectId, input.contextId);
  if (!context) return undefined;
  const rows = await database
    .prepare(
      `SELECT r.id, r.display_name, r.source_host, r.access_scope, r.referenced_at,
              o.id AS object_id, o.byte_size, o.verified_media_type AS media_type,
              o.scan_status, o.scan_updated_at,
              e.id AS exclusion_id, e.reason AS removal_reason,
              e.removed_by_user_id, e.removed_at
       FROM file_context_references r
       JOIN file_objects o ON o.workspace_id = r.workspace_id AND o.id = r.file_object_id
       LEFT JOIN file_reference_exclusions e
         ON e.workspace_id = r.workspace_id AND e.project_id = r.project_id
        AND e.context_id = r.context_id AND e.file_reference_id = r.id
       WHERE r.workspace_id = ? AND r.project_id = ? AND r.context_id = ?
       ORDER BY r.referenced_at DESC, r.id DESC`,
    )
    .all(context.workspaceId, input.projectId, input.contextId);
  return {
    context,
    files: rows.filter(({ exclusion_id: exclusionId }) => !exclusionId),
    removed: rows.filter(({ exclusion_id: exclusionId }) => Boolean(exclusionId)),
  };
}

async function authorizedFileReference(
  database,
  input: {
    userId: string;
    projectId: string;
    referenceId: string;
  },
) {
  const tenant = await tenantScopeForUser(database, input.userId);
  if (!tenant) return undefined;
  return await database
    .prepare(
      `SELECT r.id, r.context_id, r.display_name, r.file_object_id,
              o.storage_key, o.storage_version_id, o.verified_media_type AS media_type,
              o.scan_status
       FROM file_context_references r
       JOIN file_objects o ON o.workspace_id = r.workspace_id AND o.id = r.file_object_id
       JOIN work_contexts c ON c.workspace_id = r.workspace_id
         AND c.project_id = r.project_id AND c.id = r.context_id
       LEFT JOIN file_reference_exclusions e
         ON e.workspace_id = r.workspace_id AND e.project_id = r.project_id
        AND e.context_id = r.context_id AND e.file_reference_id = r.id
       WHERE r.workspace_id = ? AND r.project_id = ? AND r.id = ?
         AND c.archived_at IS NULL AND e.id IS NULL`,
    )
    .get(tenant.workspaceId, input.projectId, input.referenceId);
}

async function fileReferenceView(
  database,
  tenant,
  input: { projectId: string; referenceId: string },
) {
  return await database
    .prepare(
      `SELECT r.id, r.context_id, r.file_object_id, r.display_name, r.source_host,
              r.uploader_user_id, r.access_scope, r.referenced_at,
              o.byte_size, o.verified_media_type AS media_type, o.scan_status,
              o.scan_updated_at, p.name AS project_name, c.name AS context_name,
              c.visibility, e.id AS exclusion_id, e.reason AS removal_reason,
              e.removed_by_user_id, e.removed_at
       FROM file_context_references r
       JOIN file_objects o ON o.workspace_id = r.workspace_id AND o.id = r.file_object_id
       JOIN projects p ON p.workspace_id = r.workspace_id AND p.id = r.project_id
       JOIN work_contexts c ON c.workspace_id = r.workspace_id
         AND c.project_id = r.project_id AND c.id = r.context_id
       LEFT JOIN file_reference_exclusions e
         ON e.workspace_id = r.workspace_id AND e.project_id = r.project_id
        AND e.context_id = r.context_id AND e.file_reference_id = r.id
       WHERE r.workspace_id = ? AND r.project_id = ? AND r.id = ? AND c.archived_at IS NULL`,
    )
    .get(tenant.workspaceId, input.projectId, input.referenceId);
}

function fileRemovalPreviewVersion(file): string {
  return `file_removal_preview_${createHash("sha256")
    .update(
      JSON.stringify({
        file_reference_id: file.id,
        file_object_id: file.file_object_id,
        context_id: file.context_id,
        display_name: file.display_name,
        scan_status: file.scan_status,
        referenced_at: file.referenced_at,
      }),
    )
    .digest("hex")}`;
}

export async function getProjectFileView(
  database,
  input: {
    userId: string;
    projectId: string;
    referenceId: string;
  },
) {
  const tenant = await tenantScopeForUser(database, input.userId);
  if (!tenant) return undefined;
  return await fileReferenceView(database, tenant, input);
}

export async function getProjectFileRemovalPreview(
  database,
  input: {
    userId: string;
    projectId: string;
    referenceId: string;
  },
) {
  const file = await getProjectFileView(database, input);
  if (!file || file.exclusion_id) return undefined;
  return { ...file, preview_version: fileRemovalPreviewVersion(file) };
}

export async function removeProjectFileReference(
  database,
  input: {
    userId: string;
    projectId: string;
    referenceId: string;
    expectedPreviewVersion: string;
    reason?: string;
  },
) {
  const tenant = await tenantScopeForUser(database, input.userId);
  if (!tenant) return undefined;
  const normalizedReason = String(input.reason || "").trim();
  if (normalizedReason.length > 500) {
    throw new ProjectFileUserError("Removal reason exceeds 500 characters.");
  }
  const initial = await fileReferenceView(database, tenant, input);
  if (!initial || initial.exclusion_id) return undefined;
  return await database.transaction(
    async () => {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`${tenant.workspaceId}:file-reference:${input.referenceId}`);
      const file = await fileReferenceView(database, tenant, input);
      if (
        !file ||
        file.exclusion_id ||
        fileRemovalPreviewVersion(file) !== input.expectedPreviewVersion
      ) {
        return { conflict: true as const };
      }
      const exclusionId = `file_exclusion_${randomUUID()}`;
      const removedAt = new Date().toISOString();
      const correlationId = `file_removal_${randomUUID()}`;
      await database
        .prepare(
          `INSERT INTO file_reference_exclusions
            (id, workspace_id, project_id, context_id, file_reference_id, reason,
             removed_by_user_id, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          exclusionId,
          tenant.workspaceId,
          input.projectId,
          file.context_id,
          input.referenceId,
          normalizedReason,
          input.userId,
          removedAt,
        );
      await database
        .prepare(
          `UPDATE work_contexts SET updated_at = ?
           WHERE workspace_id = ? AND project_id = ? AND id = ?`,
        )
        .run(removedAt, tenant.workspaceId, input.projectId, file.context_id);
      const audit = await appendAuditEvent(database, {
        workspaceId: tenant.workspaceId,
        projectId: input.projectId,
        action: "file_reference_removed",
        actorType: "human_user",
        actorId: input.userId,
        correlationId,
        metadata: {
          context_id: file.context_id,
          file_object_id: file.file_object_id,
          file_reference_id: input.referenceId,
          exclusion_id: exclusionId,
        },
      });
      return {
        conflict: false as const,
        contextId: file.context_id,
        exclusionId,
        removedAt,
        auditEventId: audit.id,
      };
    },
    { isolation: "READ COMMITTED" },
  );
}

export async function refreshProjectFileScan(
  database,
  store: PrivateFileStore,
  input: { userId: string; projectId: string; referenceId: string },
) {
  const reference = await authorizedFileReference(database, input);
  if (!reference) return undefined;
  if (reference.scan_status !== "scanning") return reference;
  const result = await store.getScanResult({
    key: reference.storage_key,
    versionId: reference.storage_version_id,
  });
  if (result === "pending") return reference;
  const nextStatus = result === "failed" ? "scan_failed" : result;
  const tenant = await tenantScopeForUser(database, input.userId);
  await database.transaction(async () => {
    const updated = await database
      .prepare(
        `UPDATE file_objects SET scan_status = ?, scan_updated_at = ?
         WHERE workspace_id = ? AND id = ? AND scan_status = 'scanning'`,
      )
      .run(nextStatus, new Date().toISOString(), tenant!.workspaceId, reference.file_object_id);
    if (updated.changes) {
      await appendAuditEvent(database, {
        workspaceId: tenant!.workspaceId,
        projectId: input.projectId,
        action: "file_scan_completed",
        actorType: "human_user",
        actorId: input.userId,
        correlationId: `file_scan_${randomUUID()}`,
        metadata: { file_object_id: reference.file_object_id, scan_status: nextStatus },
      });
    }
  });
  return { ...reference, scan_status: nextStatus };
}

export async function getProjectFileDownload(
  database,
  store: PrivateFileStore,
  input: { userId: string; projectId: string; referenceId: string },
) {
  const reference = await authorizedFileReference(database, input);
  if (!reference) return undefined;
  if (reference.scan_status !== "clean" || !reference.storage_version_id) {
    return { available: false as const, scan_status: reference.scan_status as FileScanStatus };
  }
  const url = await store.createSignedDownload({
    key: reference.storage_key,
    versionId: reference.storage_version_id,
    displayName: reference.display_name,
    mediaType: reference.media_type,
    expiresInSeconds: 60,
  });
  return { available: true as const, url };
}
