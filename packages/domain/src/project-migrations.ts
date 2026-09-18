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
import { resolveProjectReferenceForConnection } from "./project-routing.ts";

export const MIGRATION_PREVIEW_LIFETIME_MS = 30 * 60 * 1_000;
export const PROJECT_MIGRATION_VERSION = "alice_project_migration_v2";

export type ProjectMigrationStatus =
  "CREATED" | "INGESTING" | "VERIFYING" | "COMPLETE" | "PARTIAL" | "FAILED";

export class ProjectMigrationUserError extends Error {}

export async function listProjectMigrationActivity(
  database,
  input: { userId: string; projectId: string },
) {
  const project = await projectScopeForUser(database, { ...input, capability: "read" });
  if (!project) return undefined;
  const rows = await database
    .prepare(
      `SELECT id, source_provider, provider_project_name, source_scope,
              scope_completeness, destination_action, observed_count, imported_count,
              exact_bytes_count, content_only_count, reference_count, missing_count,
              external_count, created_at
       FROM migration_sessions
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(project.projectWorkspaceId, project.projectId);
  return rows.map((row) => ({
    ...row,
    entry_kind: "migration_import",
    observed_count: Number(row.observed_count),
    imported_count: Number(row.imported_count),
    exact_bytes_count: Number(row.exact_bytes_count),
    content_only_count: Number(row.content_only_count),
    reference_count: Number(row.reference_count),
    missing_count: Number(row.missing_count),
    external_count: Number(row.external_count),
  }));
}

export async function getProjectImportedMaterial(
  database,
  input: { userId: string; projectId: string },
) {
  const project = await projectScopeForUser(database, input);
  if (!project) return undefined;
  const sessions = await database
    .prepare(
      `SELECT id, source_provider, provider_project_name, migration_version, status,
              reported_source_scope, reported_scope_basis, source_scope, scope_basis,
              reported_scope_completeness, reported_completeness_basis,
              scope_completeness, completeness_basis, destination_action,
              observed_count, imported_count, exact_bytes_count, content_only_count,
              reference_count, missing_count, external_count, unsupported_count,
              alice_confirmed_count, created_at, updated_at, completed_at
       FROM migration_sessions
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(project.projectWorkspaceId, project.projectId);
  const sourceObjects = await database
    .prepare(
      `SELECT id, migration_session_id, source_record_id, source_position, object_type,
              title, content, content_sha256, content_utf8_bytes, speaker, occurred_at,
              conversation_id, provider_item_id, representation, completeness,
              authority, capture_state, created_at
       FROM migration_source_objects
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY migration_session_id, source_position, id`,
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
  const objectsBySession = new Map<string, any[]>();
  for (const object of sourceObjects) {
    const sessionObjects = objectsBySession.get(object.migration_session_id) || [];
    sessionObjects.push(object);
    objectsBySession.set(object.migration_session_id, sessionObjects);
  }
  return {
    project: {
      id: project.projectId,
      role: project.projectRole,
    },
    sessions: sessions.map((session) => {
      const sessionRecords = recordsBySession.get(session.id) || [];
      let sourceReadable =
        session.destination_action === "create_empty_project" || sessionRecords.length > 0;
      const validSourceRecordIds = new Set<string>();
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
        validSourceRecordIds.add(record.id);
      }
      const items: any[] = [];
      for (const item of objectsBySession.get(session.id) || []) {
        if (
          !validSourceRecordIds.has(item.source_record_id) ||
          item.authority !== "SOURCE_UNVERIFIED" ||
          Buffer.byteLength(item.content, "utf8") !== Number(item.content_utf8_bytes) ||
          (item.content_sha256 && sha256(item.content) !== item.content_sha256)
        ) {
          sourceReadable = false;
          continue;
        }
        items.push({
          id: item.id,
          position: Number(item.source_position),
          kind: item.object_type,
          title: item.title || null,
          content: item.content,
          speaker: item.speaker || null,
          occurred_at: item.occurred_at || null,
          conversation_id: item.conversation_id || null,
          provider_item_id: item.provider_item_id || null,
          representation: item.representation,
          completeness: item.completeness,
          authority: item.authority,
          capture_state: String(item.capture_state).toLowerCase(),
        });
      }
      if (sessionRecords.length > 0 && items.length === 0) sourceReadable = false;
      return {
        source: {
          provider: session.source_provider,
          project_name: session.provider_project_name || null,
          authority: "UNVERIFIED_HOST_DERIVED" as const,
        },
        scope: {
          reported_source_scope: session.reported_source_scope,
          reported_scope_basis: session.reported_scope_basis,
          source_scope: session.source_scope,
          scope_basis: session.scope_basis,
          reported_scope_completeness: session.reported_scope_completeness,
          reported_completeness_basis: session.reported_completeness_basis,
          scope_completeness: session.scope_completeness,
          completeness_basis: session.completeness_basis,
          legacy: session.migration_version !== PROJECT_MIGRATION_VERSION,
        },
        destination_action: session.destination_action,
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
    scope: row.scope,
    alice_project_name: row.alice_project_name,
    supplied_item_count: Number(row.supplied_item_count),
    proposed_claim_count: Number(row.proposed_claim_count || 0),
    source_authority: "UNVERIFIED_HOST_DERIVED" as const,
    original_unchanged: true as const,
    project_created: false as const,
    trusted_state_changed: false as const,
    expires_at: new Date(Number(row.expires_at)).toISOString(),
  };
}

function canonicalScope(sourceContext) {
  const reported = sourceContext || {
    reported_scope: "unknown",
    scope_basis: "unavailable",
    reported_completeness: "unknown",
    completeness_basis: "unavailable",
  };
  const conversationIsNarrowed =
    reported.reported_scope === "conversation" &&
    reported.scope_basis === "visible_conversation_only";
  const partialIsObserved =
    reported.reported_completeness === "partial" &&
    reported.completeness_basis === "observed_truncation";
  const boundedResultIsExplicit =
    reported.reported_completeness === "bounded_complete" &&
    reported.completeness_basis === "explicit_tool_result";
  return {
    reported_source_scope: reported.reported_scope,
    reported_scope_basis: reported.scope_basis,
    source_scope: conversationIsNarrowed ? "conversation" : "unknown",
    scope_basis: conversationIsNarrowed ? "visible_conversation_only" : "unavailable",
    reported_scope_completeness: reported.reported_completeness,
    reported_completeness_basis: reported.completeness_basis,
    scope_completeness: partialIsObserved
      ? "partial"
      : boundedResultIsExplicit
        ? "bounded_complete"
        : "unknown",
    completeness_basis: partialIsObserved
      ? "observed_truncation"
      : boundedResultIsExplicit
        ? "explicit_tool_result"
        : "unavailable",
  };
}

function normalizedSourceObject(item, position: number) {
  const objectType = item.kind === "artifact_description" ? "artifact_reference" : item.kind;
  const referenceLike =
    objectType === "artifact_reference" ||
    objectType === "file_reference" ||
    item.capture_state !== "content_only";
  return {
    position,
    objectType,
    representation: referenceLike ? "reference" : "structured_content",
    completeness: item.capture_state === "content_only" ? "complete" : "unavailable",
    captureState: item.capture_state.toUpperCase(),
    contentSha256: sha256(item.content),
    contentUtf8Bytes: Buffer.byteLength(item.content, "utf8"),
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
    scope: {
      reported_source_scope: row.reported_source_scope,
      reported_scope_basis: row.reported_scope_basis,
      source_scope: row.source_scope,
      scope_basis: row.scope_basis,
      reported_scope_completeness: row.reported_scope_completeness,
      reported_completeness_basis: row.reported_completeness_basis,
      scope_completeness: row.scope_completeness,
      completeness_basis: row.completeness_basis,
    },
    destination_action: row.destination_action,
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
  const scope = canonicalScope(payload.source_context);
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
    scope,
    supplied_material: payload.supplied_material,
    source_relationships: payload.source_relationships,
    proposed_claims: payload.proposed_claims,
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
      scope,
      alice_project_name: payload.alice_project_name,
      supplied_item_count: payload.supplied_material.length,
      proposed_claim_count: payload.proposed_claims.length,
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
    destinationAction?:
      "create_project_from_source" | "add_source_to_existing_project" | "create_empty_project";
    targetProject?: string;
  },
) {
  return await database.transaction(
    async () => {
      const connection = await tenantScopeForConnection(database, input);
      if (!connection || connection.clientId !== input.clientId || !connection.provider) {
        return undefined;
      }
      const destinationAction = input.destinationAction || "create_project_from_source";
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
      if (existing) {
        if (existing.destination_action !== destinationAction) return undefined;
        if (
          destinationAction === "add_source_to_existing_project" &&
          input.targetProject !== existing.project_id &&
          input.targetProject !== existing.project_name
        ) {
          return undefined;
        }
        return visibleSession(existing, input.publicUrl);
      }

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
      let existingDestination: { id: string; workspace_id: string; name: string } | undefined;
      if (destinationAction === "add_source_to_existing_project") {
        if (!input.targetProject) return undefined;
        const resolution = await resolveProjectReferenceForConnection(database, {
          userId: connection.userId,
          connectionId: connection.connectionId,
          projectReference: input.targetProject,
          capability: "write",
        });
        if (resolution.status !== "ok") return undefined;
        const scope = await projectScopeForConnection(database, {
          userId: connection.userId,
          connectionId: connection.connectionId,
          projectId: resolution.projectId,
          capability: "write",
        });
        if (!scope) return undefined;
        existingDestination = {
          id: resolution.projectId,
          workspace_id: scope.projectWorkspaceId,
          name: resolution.projectName,
        };
      } else if (input.targetProject) {
        return undefined;
      }
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
        if (existingIntent.destination_action !== destinationAction) return undefined;
        if (existingDestination && existingIntent.project_id !== existingDestination.id) {
          return undefined;
        }
        await database.prepare("DELETE FROM migration_previews WHERE id = ?").run(input.previewId);
        return visibleSession(existingIntent, input.publicUrl);
      }
      const project =
        existingDestination ||
        (await createProject(database, connection.userId, {
          name: payload.alice_project_name,
        }));
      if (!project) return undefined;

      const migrationSessionId = `migration_${randomUUID()}`;
      const sourceRecordId = `migration_source_${randomUUID()}`;
      const now = new Date().toISOString();
      const retainedMaterial =
        destinationAction === "create_empty_project" ? [] : payload.supplied_material;
      const fidelity = fidelityFromMaterial(retainedMaterial);
      const scope = canonicalScope(payload.source_context);
      await database
        .prepare(
          `INSERT INTO migration_sessions
          (id, workspace_id, project_id, created_by_user_id,
           source_connection_workspace_id, source_connection_id, source_client_id,
           source_provider, provider_project_id, provider_project_name,
           reported_source_scope, reported_scope_basis, source_scope, scope_basis,
           reported_scope_completeness, reported_completeness_basis,
           scope_completeness, completeness_basis, destination_action, migration_version,
           status, status_version, observed_count, imported_count, exact_bytes_count,
           content_only_count, reference_count, missing_count, external_count,
           unsupported_count, alice_confirmed_count, error_summary, preview_id,
           intent_idempotency_key, input_payload_sha256, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 1, ?, ?, ?, ?, ?, ?, ?, ?, 0,
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
          scope.reported_source_scope,
          scope.reported_scope_basis,
          scope.source_scope,
          scope.scope_basis,
          scope.reported_scope_completeness,
          scope.reported_completeness_basis,
          scope.scope_completeness,
          scope.completeness_basis,
          destinationAction,
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
      if (retainedMaterial.length > 0) {
        const exactSource = JSON.stringify(retainedMaterial);
        const sourceObjectIds: string[] = [];
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
        for (const [index, item] of retainedMaterial.entries()) {
          const normalized = normalizedSourceObject(item, index + 1);
          const sourceObjectId = `migration_object_${randomUUID()}`;
          sourceObjectIds.push(sourceObjectId);
          await database
            .prepare(
              `INSERT INTO migration_source_objects
              (id, workspace_id, project_id, migration_session_id, source_record_id,
               source_position, object_type, title, content, content_sha256,
               content_utf8_bytes, speaker, occurred_at, conversation_id, provider_item_id,
               representation, completeness, authority, capture_state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     'SOURCE_UNVERIFIED', ?, ?)`,
            )
            .run(
              sourceObjectId,
              project.workspace_id,
              project.id,
              migrationSessionId,
              sourceRecordId,
              normalized.position,
              normalized.objectType,
              item.title || null,
              item.content,
              normalized.contentSha256,
              normalized.contentUtf8Bytes,
              item.speaker || null,
              item.occurred_at || null,
              item.conversation_id || null,
              item.provider_item_id || null,
              normalized.representation,
              normalized.completeness,
              normalized.captureState,
              now,
            );
          if (
            normalized.objectType === "artifact" &&
            normalized.representation === "structured_content" &&
            normalized.completeness === "complete"
          ) {
            const artifactId = `artifact_${randomUUID()}`;
            const versionId = `artifact_version_${randomUUID()}`;
            const title = item.title || `Imported artifact ${index + 1}`;
            await database
              .prepare(
                `INSERT INTO artifacts
                  (id, workspace_id, project_id, created_by_user_id, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(artifactId, project.workspace_id, project.id, connection.userId, now);
            await database
              .prepare(
                `INSERT INTO artifact_versions
                  (id, workspace_id, project_id, artifact_id, version, parent_version_id,
                   title, artifact_type, category, tags_json, content_storage_kind, content_text,
                   storage_key, storage_version_id, media_type, content_sha256,
                   content_utf8_bytes, goal, summary, decisions_json, decision_records_json,
                   constraints_json, rejected_directions_json, open_questions_json,
                   next_steps_json, relevant_context_json, source_connection_workspace_id,
                   source_connection_id, source_client_id, source_provider, source_authority,
                   migration_source_object_id, saved_by_user_id, idempotency_key,
                   payload_sha256, saved_at)
                 VALUES (?, ?, ?, ?, 1, NULL, ?, 'document', 'other', '[]',
                         'inline_text', ?, NULL, NULL, 'text/plain; charset=utf-8', ?, ?,
                         'Preserve the complete content supplied during migration.',
                         'Imported unverified source content.', '[]', '[]', '[]', '[]',
                         '[]', '[]', '[]', ?, ?, ?, ?, 'IMPORTED_UNVERIFIED', ?, ?, ?, ?, ?)`,
              )
              .run(
                versionId,
                project.workspace_id,
                project.id,
                artifactId,
                title,
                item.content,
                normalized.contentSha256,
                normalized.contentUtf8Bytes,
                connection.workspaceId,
                connection.connectionId,
                connection.clientId,
                connection.provider,
                sourceObjectId,
                connection.userId,
                `migration-artifact-${migrationSessionId}-${index + 1}`,
                normalized.contentSha256,
                now,
              );
          }
        }
        for (const relationship of payload.source_relationships) {
          await database
            .prepare(
              `INSERT INTO migration_source_relationships
                (id, workspace_id, project_id, migration_session_id,
                 from_source_object_id, to_source_object_id, relationship_type,
                 evidence_basis, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'PROVIDER_SUPPLIED', ?)`,
            )
            .run(
              `migration_relationship_${randomUUID()}`,
              project.workspace_id,
              project.id,
              migrationSessionId,
              sourceObjectIds[relationship.from_position - 1],
              sourceObjectIds[relationship.to_position - 1],
              relationship.relationship_type,
              now,
            );
        }
        if (payload.proposed_claims.length > 0) {
          const defaultContext = await database
            .prepare(
              `SELECT context_id FROM project_default_contexts
               WHERE workspace_id = ? AND project_id = ?`,
            )
            .get(project.workspace_id, project.id);
          if (!defaultContext) throw new Error("Migration proposal destination is unavailable.");
          const evidenceId = `evidence_${randomUUID()}`;
          const proposalPayload = {
            project_id: project.id,
            summary: "Unverified proposals derived from imported source material.",
            candidate_claims: payload.proposed_claims.map((claim) => ({
              state_key: claim.state_key,
              value: claim.value,
              summary: claim.summary,
              migration_source_object_ids: claim.source_positions.map(
                (position) => sourceObjectIds[position - 1],
              ),
            })),
            source_note:
              "Each proposal cites immutable imported source objects and remains pending human review.",
            source_context: "Imported material · unverified",
            idempotency_key: `migration-proposals-${migrationSessionId}`,
          };
          const exactProposalPayload = JSON.stringify(proposalPayload);
          const proposalHash = sha256(exactProposalPayload);
          await database
            .prepare(
              `INSERT INTO evidence_events
                (id, workspace_id, project_id, exact_payload_json, actor_type,
                 connection_id, connection_workspace_id, client_id,
                 client_classification, tool_name, idempotency_key, payload_hash, created_at)
               VALUES (?, ?, ?, ?, 'mcp_host', ?, ?, ?, ?, 'import_project_proposals',
                       ?, ?, ?)`,
            )
            .run(
              evidenceId,
              project.workspace_id,
              project.id,
              exactProposalPayload,
              connection.connectionId,
              connection.workspaceId,
              connection.clientId,
              connection.provider,
              `migration-proposals-${migrationSessionId}`,
              proposalHash,
              now,
            );
          const candidateIds: string[] = [];
          for (const claim of payload.proposed_claims) {
            const candidateId = `candidate_${randomUUID()}`;
            candidateIds.push(candidateId);
            await database
              .prepare(
                `INSERT INTO candidate_claims
                  (id, workspace_id, project_id, evidence_id, state_key, value_json,
                   summary, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
              )
              .run(
                candidateId,
                project.workspace_id,
                project.id,
                evidenceId,
                claim.state_key,
                JSON.stringify(claim.value),
                claim.summary,
                now,
              );
            await database
              .prepare(
                `INSERT INTO candidate_context_targets
                  (candidate_id, workspace_id, project_id, context_id, targeted_at)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(candidateId, project.workspace_id, project.id, defaultContext.context_id, now);
            for (const position of claim.source_positions) {
              await database
                .prepare(
                  `INSERT INTO migration_candidate_sources
                    (candidate_id, evidence_id, workspace_id, project_id,
                     migration_session_id, source_object_id, cited_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  candidateId,
                  evidenceId,
                  project.workspace_id,
                  project.id,
                  migrationSessionId,
                  sourceObjectIds[position - 1],
                  now,
                );
            }
          }
          await appendAuditEvent(database, {
            workspaceId: project.workspace_id,
            projectId: project.id,
            action: "candidate_update_submitted",
            actorType: "mcp_host",
            actorId: connection.clientId,
            correlationId: `migration_proposals_${migrationSessionId}`,
            metadata: {
              evidence_id: evidenceId,
              candidate_ids: candidateIds,
              candidate_count: candidateIds.length,
              context_id: defaultContext.context_id,
              connection_id: connection.connectionId,
              payload_hash: proposalHash,
              migration_session_id: migrationSessionId,
            },
          });
        }
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
      }
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
