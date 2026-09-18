import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  migrationContractVersion,
  migrationSuppliedMaterialListSchema,
  previewProjectMigrationSchema,
} from "@alice/schemas";
import { appendAuditEvent } from "./audit.ts";
import {
  projectScopeForConnection,
  projectScopeForUser,
  tenantScopeForConnection,
} from "./authorization.ts";
import { createProject } from "./projects.ts";

export const MIGRATION_PREVIEW_LIFETIME_MS = 30 * 60 * 1_000;
export const PROJECT_MIGRATION_VERSION = "alice_project_migration_v1";

export type ProjectMigrationStatus =
  "CREATED" | "INGESTING" | "VERIFYING" | "COMPLETE" | "PARTIAL" | "FAILED";

export class ProjectMigrationUserError extends Error {}

export async function getProjectImportedMaterial(
  database,
  input: { userId: string; projectId: string },
) {
  const project = await projectScopeForUser(database, input);
  if (!project) return undefined;
  const sessions = await database
    .prepare(
      `SELECT id, source_provider, provider_project_name, status,
              observed_count, imported_count, exact_bytes_count, content_only_count,
              reference_count, missing_count, external_count, unsupported_count,
              alice_confirmed_count, created_at, updated_at, completed_at
       FROM migration_sessions
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(project.projectWorkspaceId, project.projectId);
  const records = await database
    .prepare(
      `SELECT id, migration_session_id, source_type, authority, capture_state,
              source_provider, provider_project_name, source_format, parser_version,
              exact_content, content_sha256, content_utf8_bytes, created_at
       FROM migration_source_records
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY created_at, id`,
    )
    .all(project.projectWorkspaceId, project.projectId);
  const recordsBySession = new Map<string, any[]>();
  for (const record of records) {
    const sessionRecords = recordsBySession.get(record.migration_session_id) || [];
    sessionRecords.push(record);
    recordsBySession.set(record.migration_session_id, sessionRecords);
  }
  return {
    project: {
      id: project.projectId,
      role: project.projectRole,
    },
    sessions: sessions.map((session) => {
      const sessionRecords = recordsBySession.get(session.id) || [];
      let position = 0;
      let sourceReadable = sessionRecords.length > 0;
      const items: Array<{
        position: number;
        kind: string;
        content: string;
        speaker: string | null;
        occurred_at: string | null;
        capture_state: string;
      }> = [];
      for (const record of sessionRecords) {
        if (
          record.source_type !== "HOST_SNAPSHOT" ||
          record.authority !== "UNVERIFIED_HOST_DERIVED" ||
          record.capture_state !== "CONTENT_ONLY" ||
          record.source_provider !== session.source_provider ||
          record.source_format !== "alice_supplied_material_json" ||
          record.parser_version !== "identity_v1" ||
          Buffer.byteLength(record.exact_content, "utf8") !== Number(record.content_utf8_bytes) ||
          sha256(record.exact_content) !== record.content_sha256
        ) {
          sourceReadable = false;
          continue;
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(record.exact_content);
        } catch {
          sourceReadable = false;
          continue;
        }
        const parsed = migrationSuppliedMaterialListSchema.safeParse(parsedJson);
        if (!parsed.success) {
          sourceReadable = false;
          continue;
        }
        for (const item of parsed.data) {
          position += 1;
          items.push({
            position,
            kind: item.kind,
            content: item.content,
            speaker: item.speaker || null,
            occurred_at: item.occurred_at || null,
            capture_state: item.capture_state,
          });
        }
      }
      return {
        source: {
          provider: session.source_provider,
          project_name: session.provider_project_name || null,
          authority: "UNVERIFIED_HOST_DERIVED" as const,
        },
        scope: {
          source_scope: "unknown" as const,
          scope_basis: "unavailable" as const,
          scope_completeness: "unknown" as const,
          completeness_basis: "unavailable" as const,
          legacy: true as const,
        },
        status: session.status,
        fidelity: {
          observed: Number(session.observed_count),
          imported: Number(session.imported_count),
          exact_bytes: Number(session.exact_bytes_count),
          content_only: Number(session.content_only_count),
          references: Number(session.reference_count),
          missing: Number(session.missing_count),
          external: Number(session.external_count),
          unsupported: Number(session.unsupported_count),
          alice_confirmed: Number(session.alice_confirmed_count),
        },
        source_readable: sourceReadable,
        items,
        created_at: session.created_at,
        updated_at: session.updated_at,
        completed_at: session.completed_at || null,
      };
    }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorityMatches(rawToken: string, storedHash: string): boolean {
  const actual = Buffer.from(sha256(rawToken), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function visiblePreview(row) {
  return {
    contract_version: migrationContractVersion,
    preview_id: row.id,
    preview_version: row.preview_version,
    status: "preview_only" as const,
    source_provider: row.source_provider,
    provider_project_name: row.provider_project_name || null,
    alice_project_name: row.alice_project_name,
    supplied_item_count: Number(row.supplied_item_count),
    source_authority: "UNVERIFIED_HOST_DERIVED" as const,
    original_unchanged: true as const,
    project_created: false as const,
    trusted_state_changed: false as const,
    expires_at: new Date(Number(row.expires_at)).toISOString(),
  };
}

function fidelityFromMaterial(material) {
  const count = (captureState: string) =>
    material.filter((item) => item.capture_state === captureState).length;
  const exactBytes = count("exact_bytes");
  const contentOnly = count("content_only");
  return {
    observed: material.length,
    imported: exactBytes + contentOnly,
    exact_bytes: exactBytes,
    content_only: contentOnly,
    references: count("reference"),
    missing: count("missing"),
    external: count("external"),
    unsupported: 0,
    alice_confirmed: 0,
  };
}

function visibleSession(row, publicUrl: string) {
  return {
    contract_version: migrationContractVersion,
    migration_session_id: row.id,
    project: {
      name: row.project_name,
      url: new URL(
        `/projects/${encodeURIComponent(row.project_id)}/migrations/${encodeURIComponent(row.id)}`,
        publicUrl,
      ).href,
    },
    source: {
      provider: row.source_provider,
      project_name: row.provider_project_name || null,
      authority: "UNVERIFIED_HOST_DERIVED" as const,
    },
    status: row.status,
    status_version: Number(row.status_version),
    fidelity: {
      observed: Number(row.observed_count),
      imported: Number(row.imported_count),
      exact_bytes: Number(row.exact_bytes_count),
      content_only: Number(row.content_only_count),
      references: Number(row.reference_count),
      missing: Number(row.missing_count),
      external: Number(row.external_count),
      unsupported: Number(row.unsupported_count),
      alice_confirmed: Number(row.alice_confirmed_count),
    },
    error_summary: row.error_summary || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
    original_unchanged: true as const,
    source_content_trust: "unverified_host_derived_data" as const,
  };
}

async function sessionRow(database, where: string, ...parameters: unknown[]) {
  return await database
    .prepare(
      `SELECT session.*, project.name AS project_name
       FROM migration_sessions session
       JOIN projects project
         ON project.workspace_id = session.workspace_id
        AND project.id = session.project_id
       WHERE ${where}`,
    )
    .get(...parameters);
}

export async function createProjectMigrationPreview(
  database,
  input: {
    userId: string;
    connectionId: string;
    clientId: string;
    payload: unknown;
  },
) {
  const connection = await tenantScopeForConnection(database, input);
  if (!connection || connection.clientId !== input.clientId || !connection.provider) {
    return undefined;
  }
  const payload = previewProjectMigrationSchema.parse(input.payload);
  const exactPayloadJson = JSON.stringify(payload);
  const payloadSha256 = sha256(exactPayloadJson);
  const previewId = `migration_preview_${randomUUID()}`;
  const authorityToken = `alice_migrate_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  const expiresAt = Date.now() + MIGRATION_PREVIEW_LIFETIME_MS;
  const exactPreview = {
    contract_version: migrationContractVersion,
    preview_id: previewId,
    alice_project_name: payload.alice_project_name,
    source: {
      provider: connection.provider,
      project_id: payload.provider_project_id || null,
      project_name: payload.provider_project_name || null,
      authority: "UNVERIFIED_HOST_DERIVED",
    },
    supplied_material: payload.supplied_material,
    statements: [
      "The original provider project remains unchanged.",
      "Host-supplied material is unverified data, not Alice-confirmed project information.",
      "Nothing is created unless you choose Migrate.",
    ],
  };
  const exactPreviewJson = JSON.stringify(exactPreview);
  const previewVersion = sha256(exactPreviewJson);

  await database.prepare("DELETE FROM migration_previews WHERE expires_at <= ?").run(Date.now());
  await database
    .prepare(
      `INSERT INTO migration_previews
        (id, user_workspace_id, user_id, connection_id, client_id, source_provider,
         alice_project_name, provider_project_id, provider_project_name,
         exact_payload_json, payload_sha256, exact_preview_json, preview_version,
         authority_token_hash, idempotency_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      previewId,
      connection.workspaceId,
      connection.userId,
      connection.connectionId,
      connection.clientId,
      connection.provider,
      payload.alice_project_name,
      payload.provider_project_id || null,
      payload.provider_project_name || null,
      exactPayloadJson,
      payloadSha256,
      exactPreviewJson,
      previewVersion,
      sha256(authorityToken),
      payload.idempotency_key,
      createdAt,
      expiresAt,
    );

  return {
    preview: visiblePreview({
      id: previewId,
      preview_version: previewVersion,
      source_provider: connection.provider,
      provider_project_name: payload.provider_project_name || null,
      alice_project_name: payload.alice_project_name,
      supplied_item_count: payload.supplied_material.length,
      expires_at: expiresAt,
    }),
    authority_token: authorityToken,
    exact_preview: exactPreview,
  };
}

export async function commitProjectMigrationPreview(
  database,
  input: {
    userId: string;
    connectionId: string;
    clientId: string;
    publicUrl: string;
    previewId: string;
    previewVersion: string;
    authorityToken: string;
  },
) {
  return await database.transaction(
    async () => {
      const connection = await tenantScopeForConnection(database, input);
      if (!connection || connection.clientId !== input.clientId || !connection.provider) {
        return undefined;
      }
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`migration-preview:${input.previewId}`);

      const existing = await sessionRow(
        database,
        `session.preview_id = ? AND session.created_by_user_id = ?
       AND session.source_connection_id = ? AND session.source_client_id = ?`,
        input.previewId,
        connection.userId,
        connection.connectionId,
        connection.clientId,
      );
      if (existing) return visibleSession(existing, input.publicUrl);

      const preview = await database
        .prepare(
          `SELECT * FROM migration_previews
         WHERE id = ? AND user_workspace_id = ? AND user_id = ?
           AND connection_id = ? AND client_id = ?`,
        )
        .get(
          input.previewId,
          connection.workspaceId,
          connection.userId,
          connection.connectionId,
          connection.clientId,
        );
      if (!preview) return undefined;
      if (Number(preview.expires_at) <= Date.now()) {
        await database.prepare("DELETE FROM migration_previews WHERE id = ?").run(input.previewId);
        return undefined;
      }
      if (
        preview.preview_version !== input.previewVersion ||
        !authorityMatches(input.authorityToken, preview.authority_token_hash)
      ) {
        return undefined;
      }

      const payload = previewProjectMigrationSchema.parse(JSON.parse(preview.exact_payload_json));
      if (sha256(preview.exact_payload_json) !== preview.payload_sha256) return undefined;
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`migration-intent:${connection.connectionId}:${preview.idempotency_key}`);
      const existingIntent = await sessionRow(
        database,
        `session.source_connection_id = ? AND session.intent_idempotency_key = ?`,
        connection.connectionId,
        preview.idempotency_key,
      );
      if (existingIntent) {
        if (existingIntent.input_payload_sha256 !== preview.payload_sha256) return undefined;
        await database.prepare("DELETE FROM migration_previews WHERE id = ?").run(input.previewId);
        return visibleSession(existingIntent, input.publicUrl);
      }
      const project = await createProject(database, connection.userId, {
        name: payload.alice_project_name,
      });
      if (!project) return undefined;

      const migrationSessionId = `migration_${randomUUID()}`;
      const sourceRecordId = `migration_source_${randomUUID()}`;
      const now = new Date().toISOString();
      const fidelity = fidelityFromMaterial(payload.supplied_material);
      await database
        .prepare(
          `INSERT INTO migration_sessions
          (id, workspace_id, project_id, created_by_user_id,
           source_connection_workspace_id, source_connection_id, source_client_id,
           source_provider, provider_project_id, provider_project_name, migration_version,
           status, status_version, observed_count, imported_count, exact_bytes_count,
           content_only_count, reference_count, missing_count, external_count,
           unsupported_count, alice_confirmed_count, error_summary, preview_id,
           intent_idempotency_key, input_payload_sha256, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 1, ?, ?, ?, ?, ?, ?, ?, ?, 0,
                 NULL, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          migrationSessionId,
          project.workspace_id,
          project.id,
          connection.userId,
          connection.workspaceId,
          connection.connectionId,
          connection.clientId,
          connection.provider,
          payload.provider_project_id || null,
          payload.provider_project_name || null,
          PROJECT_MIGRATION_VERSION,
          fidelity.observed,
          fidelity.imported,
          fidelity.exact_bytes,
          fidelity.content_only,
          fidelity.references,
          fidelity.missing,
          fidelity.external,
          fidelity.unsupported,
          input.previewId,
          payload.idempotency_key,
          preview.payload_sha256,
          now,
          now,
        );
      await database
        .prepare(
          `INSERT INTO migration_events
          (id, workspace_id, project_id, migration_session_id, event_sequence,
           event_type, previous_status, next_status, status_version,
           actor_type, actor_id, error_code, created_at)
         VALUES (?, ?, ?, ?, 1, 'SESSION_CREATED', NULL, 'CREATED', 1,
                 'human_user', ?, NULL, ?)`,
        )
        .run(
          `migration_event_${randomUUID()}`,
          project.workspace_id,
          project.id,
          migrationSessionId,
          connection.userId,
          now,
        );
      const exactSource = JSON.stringify(payload.supplied_material);
      await database
        .prepare(
          `INSERT INTO migration_source_records
          (id, workspace_id, project_id, migration_session_id, source_type, authority,
           capture_state, source_provider, provider_project_id, provider_project_name,
           source_format, parser_version, exact_content, content_sha256,
           content_utf8_bytes, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, 'HOST_SNAPSHOT', 'UNVERIFIED_HOST_DERIVED', 'CONTENT_ONLY',
                 ?, ?, ?, 'alice_supplied_material_json', 'identity_v1', ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceRecordId,
          project.workspace_id,
          project.id,
          migrationSessionId,
          connection.provider,
          payload.provider_project_id || null,
          payload.provider_project_name || null,
          exactSource,
          sha256(exactSource),
          Buffer.byteLength(exactSource, "utf8"),
          payload.idempotency_key,
          now,
        );
      await database
        .prepare(
          `INSERT INTO migration_events
          (id, workspace_id, project_id, migration_session_id, event_sequence,
           event_type, previous_status, next_status, status_version,
           actor_type, actor_id, error_code, created_at)
         VALUES (?, ?, ?, ?, 2, 'SOURCE_INGESTED', 'CREATED', 'CREATED', 1,
                 'alice_system', 'alice_migration', NULL, ?)`,
        )
        .run(
          `migration_event_${randomUUID()}`,
          project.workspace_id,
          project.id,
          migrationSessionId,
          now,
        );
      await appendAuditEvent(database, {
        workspaceId: project.workspace_id,
        projectId: project.id,
        action: "project_migration_started",
        actorType: "human_user",
        actorId: connection.userId,
        correlationId: migrationSessionId,
        metadata: {
          migration_session_id: migrationSessionId,
          source_provider: connection.provider,
          observed_count: fidelity.observed,
        },
      });
      await database.prepare("DELETE FROM migration_previews WHERE id = ?").run(input.previewId);

      await transitionProjectMigration(database, {
        userId: connection.userId,
        projectId: project.id,
        migrationSessionId,
        nextStatus: "INGESTING",
        expectedStatusVersion: 1,
      });
      await transitionProjectMigration(database, {
        userId: connection.userId,
        projectId: project.id,
        migrationSessionId,
        nextStatus: "VERIFYING",
        expectedStatusVersion: 2,
      });
      const partial =
        fidelity.references + fidelity.missing + fidelity.external + fidelity.unsupported > 0;
      await transitionProjectMigration(database, {
        userId: connection.userId,
        projectId: project.id,
        migrationSessionId,
        nextStatus: partial ? "PARTIAL" : "COMPLETE",
        expectedStatusVersion: 3,
        ...(partial
          ? {
              errorCode: "incomplete_supplied_scope",
            }
          : {}),
      });

      const created = await sessionRow(database, "session.id = ?", migrationSessionId);
      return visibleSession(created, input.publicUrl);
    },
    { isolation: "READ COMMITTED" },
  );
}

export async function getProjectMigrationStatus(
  database,
  input: {
    userId: string;
    connectionId?: string;
    clientId?: string;
    projectId: string;
    migrationSessionId: string;
    publicUrl: string;
  },
) {
  const scope = input.connectionId
    ? await projectScopeForConnection(database, {
        userId: input.userId,
        connectionId: input.connectionId,
        projectId: input.projectId,
        capability: "read",
      })
    : await projectScopeForUser(database, {
        userId: input.userId,
        projectId: input.projectId,
        capability: "read",
      });
  if (!scope || (input.clientId && "clientId" in scope && scope.clientId !== input.clientId)) {
    return undefined;
  }
  const row = await sessionRow(
    database,
    `session.workspace_id = ? AND session.project_id = ? AND session.id = ?`,
    scope.projectWorkspaceId,
    scope.projectId,
    input.migrationSessionId,
  );
  return row ? visibleSession(row, input.publicUrl) : undefined;
}

const allowedTransitions: Record<ProjectMigrationStatus, ProjectMigrationStatus[]> = {
  CREATED: ["INGESTING", "FAILED"],
  INGESTING: ["VERIFYING", "PARTIAL", "FAILED"],
  VERIFYING: ["COMPLETE", "PARTIAL", "FAILED"],
  COMPLETE: [],
  PARTIAL: ["INGESTING", "VERIFYING", "COMPLETE", "FAILED"],
  FAILED: ["INGESTING"],
};

const migrationErrorSummaries = {
  incomplete_supplied_scope:
    "Some supplied material is reference-only, missing, external, or unsupported.",
  missing_reference: "One or more referenced items were not supplied.",
  source_processing_failed: "The supplied source could not be processed.",
} as const;

type MigrationErrorCode = keyof typeof migrationErrorSummaries;

export async function transitionProjectMigration(
  database,
  input: {
    userId: string;
    projectId: string;
    migrationSessionId: string;
    nextStatus: ProjectMigrationStatus;
    expectedStatusVersion: number;
    errorCode?: MigrationErrorCode;
    counterIncrements?: Partial<{
      observed: number;
      imported: number;
      exact_bytes: number;
      content_only: number;
      references: number;
      missing: number;
      external: number;
      unsupported: number;
      alice_confirmed: number;
    }>;
  },
) {
  return await database.transaction(
    async () => {
      const scope = await projectScopeForUser(database, {
        userId: input.userId,
        projectId: input.projectId,
        capability: "write",
      });
      if (!scope) return undefined;
      const current = await database
        .prepare(
          `SELECT * FROM migration_sessions
         WHERE workspace_id = ? AND project_id = ? AND id = ? FOR UPDATE`,
        )
        .get(scope.projectWorkspaceId, scope.projectId, input.migrationSessionId);
      if (
        !current ||
        Number(current.status_version) !== input.expectedStatusVersion ||
        !allowedTransitions[current.status as ProjectMigrationStatus]?.includes(input.nextStatus)
      ) {
        return undefined;
      }
      const errorCode = input.errorCode || null;
      if (errorCode && !Object.hasOwn(migrationErrorSummaries, errorCode)) {
        throw new ProjectMigrationUserError("The migration error code is unsupported.");
      }
      if (
        (["PARTIAL", "FAILED"] as ProjectMigrationStatus[]).includes(input.nextStatus) !==
        Boolean(errorCode)
      ) {
        throw new ProjectMigrationUserError(
          "Partial and failed migrations require one supported content-free error code.",
        );
      }
      const errorSummary = errorCode ? migrationErrorSummaries[errorCode] : null;
      const increments = input.counterIncrements || {};
      for (const value of Object.values(increments)) {
        if (!Number.isInteger(value) || value! < 0) {
          throw new ProjectMigrationUserError(
            "Migration counter increments must be non-negative integers.",
          );
        }
      }
      const next = {
        observed: Number(current.observed_count) + (increments.observed || 0),
        imported: Number(current.imported_count) + (increments.imported || 0),
        exact_bytes: Number(current.exact_bytes_count) + (increments.exact_bytes || 0),
        content_only: Number(current.content_only_count) + (increments.content_only || 0),
        references: Number(current.reference_count) + (increments.references || 0),
        missing: Number(current.missing_count) + (increments.missing || 0),
        external: Number(current.external_count) + (increments.external || 0),
        unsupported: Number(current.unsupported_count) + (increments.unsupported || 0),
        alice_confirmed: Number(current.alice_confirmed_count) + (increments.alice_confirmed || 0),
      };
      if (
        next.imported > next.observed ||
        next.exact_bytes + next.content_only > next.imported ||
        [next.references, next.missing, next.external, next.unsupported].some(
          (count) => count > next.observed,
        )
      ) {
        throw new ProjectMigrationUserError(
          "Migration counters do not describe a valid observed set.",
        );
      }
      const now = new Date(Date.now() + Number(current.status_version)).toISOString();
      const statusVersion = Number(current.status_version) + 1;
      const completedAt = input.nextStatus === "COMPLETE" ? now : null;
      await database
        .prepare(
          `UPDATE migration_sessions
         SET status = ?, status_version = ?, observed_count = ?, imported_count = ?,
             exact_bytes_count = ?, content_only_count = ?, reference_count = ?,
             missing_count = ?, external_count = ?, unsupported_count = ?,
             alice_confirmed_count = ?, error_summary = ?, updated_at = ?, completed_at = ?
         WHERE workspace_id = ? AND project_id = ? AND id = ?`,
        )
        .run(
          input.nextStatus,
          statusVersion,
          next.observed,
          next.imported,
          next.exact_bytes,
          next.content_only,
          next.references,
          next.missing,
          next.external,
          next.unsupported,
          next.alice_confirmed,
          errorSummary,
          now,
          completedAt,
          scope.projectWorkspaceId,
          scope.projectId,
          input.migrationSessionId,
        );
      const eventSequenceRow = await database
        .prepare(
          `SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence
         FROM migration_events
         WHERE workspace_id = ? AND project_id = ? AND migration_session_id = ?`,
        )
        .get(scope.projectWorkspaceId, scope.projectId, input.migrationSessionId);
      await database
        .prepare(
          `INSERT INTO migration_events
          (id, workspace_id, project_id, migration_session_id, event_sequence,
           event_type, previous_status, next_status, status_version,
           actor_type, actor_id, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'alice_system', 'alice_migration', ?, ?)`,
        )
        .run(
          `migration_event_${randomUUID()}`,
          scope.projectWorkspaceId,
          scope.projectId,
          input.migrationSessionId,
          Number(eventSequenceRow.next_sequence),
          (current.status === "FAILED" || current.status === "PARTIAL") &&
            input.nextStatus === "INGESTING"
            ? "RETRY_STARTED"
            : "STATUS_CHANGED",
          current.status,
          input.nextStatus,
          statusVersion,
          errorCode,
          now,
        );
      return await sessionRow(database, "session.id = ?", input.migrationSessionId);
    },
    { isolation: "READ COMMITTED" },
  );
}
