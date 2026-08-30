import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForUser } from "./authorization.ts";

function parseJson(value) {
  return JSON.parse(value);
}

function captureSummary(exactPayloadJson) {
  try {
    return JSON.parse(exactPayloadJson).summary;
  } catch {
    return undefined;
  }
}

function removalPreviewVersion(preview) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        accepted_state_id: preview.entry.id,
        project_id: preview.project.id,
        context_id: preview.context.id,
        state_key: preview.entry.state_key,
        value: preview.entry.value,
        version: preview.entry.version,
        accepted_at: preview.entry.accepted_at,
      }),
    )
    .digest("hex");
  return `removal_preview_${digest}`;
}

async function buildRemovalPreview(database, tenant, { projectId, contextId, acceptedStateId }) {
  const row = await database
    .prepare(
      `SELECT accepted.id, accepted.state_key, accepted.value_json, accepted.version,
              accepted.accepted_at, accepted.candidate_id, accepted.evidence_id,
              candidate.summary, evidence.payload_hash,
              evidence.created_at AS evidence_created_at,
              evidence.client_classification,
              project.name AS project_name, project.brief AS project_brief,
              context.name AS context_name, context.description AS context_description,
              context.visibility, context.updated_at AS context_updated_at
       FROM accepted_project_state accepted
       JOIN accepted_context_entries entry
         ON entry.workspace_id = accepted.workspace_id
        AND entry.project_id = accepted.project_id
        AND entry.accepted_state_id = accepted.id
       JOIN candidate_claims candidate
         ON candidate.workspace_id = accepted.workspace_id
        AND candidate.project_id = accepted.project_id
        AND candidate.id = accepted.candidate_id
       JOIN evidence_events evidence
         ON evidence.workspace_id = accepted.workspace_id
        AND evidence.project_id = accepted.project_id
        AND evidence.id = accepted.evidence_id
       JOIN projects project
         ON project.workspace_id = accepted.workspace_id AND project.id = accepted.project_id
       JOIN work_contexts context
         ON context.workspace_id = entry.workspace_id
        AND context.project_id = entry.project_id
        AND context.id = entry.context_id
        AND context.archived_at IS NULL
       LEFT JOIN context_entry_exclusions exclusion
         ON exclusion.workspace_id = accepted.workspace_id
        AND exclusion.project_id = accepted.project_id
        AND exclusion.accepted_state_id = accepted.id
       WHERE accepted.workspace_id = ? AND accepted.project_id = ?
         AND entry.context_id = ? AND accepted.id = ? AND exclusion.id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM accepted_project_state newer
           JOIN accepted_context_entries newer_entry
             ON newer_entry.workspace_id = newer.workspace_id
            AND newer_entry.project_id = newer.project_id
            AND newer_entry.accepted_state_id = newer.id
           WHERE newer.workspace_id = accepted.workspace_id
             AND newer.project_id = accepted.project_id
             AND newer.state_key = accepted.state_key
             AND newer_entry.context_id = entry.context_id
             AND newer.version > accepted.version
         )`,
    )
    .get(tenant.workspaceId, projectId, contextId, acceptedStateId);
  if (!row) return undefined;
  const preview = {
    project: { id: projectId, name: row.project_name, brief: row.project_brief },
    context: {
      id: contextId,
      name: row.context_name,
      description: row.context_description,
      visibility: row.visibility,
      updated_at: row.context_updated_at,
    },
    entry: {
      id: row.id,
      state_key: row.state_key,
      value: parseJson(row.value_json),
      summary: row.summary,
      version: row.version,
      accepted_at: row.accepted_at,
      candidate_id: row.candidate_id,
      evidence_id: row.evidence_id,
      payload_hash: row.payload_hash,
      evidence_created_at: row.evidence_created_at,
      client_classification: row.client_classification,
    },
  };
  return { ...preview, preview_version: removalPreviewVersion(preview) };
}

export async function getRemovalPreview(
  database,
  { userId, projectId, contextId, acceptedStateId },
) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return buildRemovalPreview(database, tenant, { projectId, contextId, acceptedStateId });
}

export async function removeSavedContextEntry(
  database,
  { userId, projectId, contextId, acceptedStateId, expectedPreviewVersion, reason = "" },
) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const normalizedReason = String(reason).trim();
  if (normalizedReason.length > 500) throw new Error("Removal reason exceeds 500 characters.");
  const initial = await buildRemovalPreview(database, tenant, {
    projectId,
    contextId,
    acceptedStateId,
  });
  if (!initial) return undefined;
  return database.transaction(
    async () => {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`${tenant.workspaceId}:${projectId}:${initial.entry.state_key}`);
      const preview = await buildRemovalPreview(database, tenant, {
        projectId,
        contextId,
        acceptedStateId,
      });
      if (!preview || preview.preview_version !== expectedPreviewVersion) {
        return { conflict: true };
      }
      const removedAt = new Date().toISOString();
      const exclusionId = `context_exclusion_${randomUUID()}`;
      const correlationId = `context_removal_${randomUUID()}`;
      await database
        .prepare(
          `INSERT INTO context_entry_exclusions
            (id, workspace_id, project_id, context_id, accepted_state_id, reason,
             removed_by_user_id, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          exclusionId,
          tenant.workspaceId,
          projectId,
          contextId,
          acceptedStateId,
          normalizedReason,
          tenant.userId,
          removedAt,
        );
      await database
        .prepare(
          `INSERT INTO context_history_events
            (id, workspace_id, project_id, context_id, action, actor_user_id,
             safe_metadata_json, created_at)
           VALUES (?, ?, ?, ?, 'context_entry_removed', ?, ?, ?)`,
        )
        .run(
          `context_event_${randomUUID()}`,
          tenant.workspaceId,
          projectId,
          contextId,
          tenant.userId,
          JSON.stringify({ accepted_state_id: acceptedStateId, exclusion_id: exclusionId }),
          removedAt,
        );
      await database
        .prepare(
          `UPDATE work_contexts SET updated_at = ?
           WHERE workspace_id = ? AND project_id = ? AND id = ?`,
        )
        .run(removedAt, tenant.workspaceId, projectId, contextId);
      const audit = await appendAuditEvent(database, {
        workspaceId: tenant.workspaceId,
        projectId,
        action: "saved_context_removed",
        actorType: "human_user",
        actorId: tenant.userId,
        correlationId,
        metadata: {
          accepted_state_id: acceptedStateId,
          context_id: contextId,
          exclusion_id: exclusionId,
          state_key: preview.entry.state_key,
          version: preview.entry.version,
        },
      });
      return {
        conflict: false,
        projectId,
        contextId,
        acceptedStateId,
        exclusionId,
        removedAt,
        auditEventId: audit.id,
        correlationId,
      };
    },
    { isolation: "READ COMMITTED" },
  );
}

export async function getSavedContextView(database, { userId, projectId, contextId }) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const project = await database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, tenant.workspaceId);
  if (!project) return undefined;
  const contexts = await database
    .prepare(
      `SELECT id, name, description, context_kind, visibility, created_at, updated_at
       FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL
       ORDER BY CASE WHEN context_kind = 'project_wide' THEN 0 ELSE 1 END, name, id`,
    )
    .all(tenant.workspaceId, project.id);
  const context = contextId
    ? contexts.find(({ id }) => id === contextId)
    : contexts.find(({ context_kind: kind }) => kind === "project_wide");
  if (!context) return undefined;

  const saved = (
    await database
      .prepare(
        `SELECT accepted.id, accepted.state_key, accepted.value_json, accepted.version,
                accepted.accepted_at, accepted.candidate_id, accepted.evidence_id,
                candidate.summary, evidence.payload_hash,
                evidence.created_at AS evidence_created_at,
                evidence.client_classification
         FROM accepted_project_state accepted
         JOIN accepted_context_entries entry
           ON entry.workspace_id = accepted.workspace_id
          AND entry.project_id = accepted.project_id
          AND entry.accepted_state_id = accepted.id
         JOIN candidate_claims candidate
           ON candidate.workspace_id = accepted.workspace_id
          AND candidate.project_id = accepted.project_id
          AND candidate.id = accepted.candidate_id
         JOIN evidence_events evidence
           ON evidence.workspace_id = accepted.workspace_id
          AND evidence.project_id = accepted.project_id
          AND evidence.id = accepted.evidence_id
         LEFT JOIN context_entry_exclusions exclusion
           ON exclusion.workspace_id = accepted.workspace_id
          AND exclusion.project_id = accepted.project_id
          AND exclusion.accepted_state_id = accepted.id
         WHERE accepted.workspace_id = ? AND accepted.project_id = ? AND entry.context_id = ?
           AND exclusion.id IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM accepted_project_state newer
             JOIN accepted_context_entries newer_entry
               ON newer_entry.workspace_id = newer.workspace_id
              AND newer_entry.project_id = newer.project_id
              AND newer_entry.accepted_state_id = newer.id
             WHERE newer.workspace_id = accepted.workspace_id
               AND newer.project_id = accepted.project_id
               AND newer.state_key = accepted.state_key
               AND newer_entry.context_id = entry.context_id
               AND newer.version > accepted.version
           )
         ORDER BY accepted.state_key, accepted.id`,
      )
      .all(tenant.workspaceId, project.id, context.id)
  ).map((entry) => ({ ...entry, value: parseJson(entry.value_json), value_json: undefined }));

  const removed = (
    await database
      .prepare(
        `SELECT accepted.id, accepted.state_key, accepted.value_json, accepted.version,
                accepted.accepted_at, accepted.candidate_id, accepted.evidence_id,
                candidate.summary, evidence.payload_hash,
                evidence.created_at AS evidence_created_at,
                evidence.client_classification, exclusion.id AS exclusion_id,
                exclusion.reason, exclusion.removed_at, exclusion.removed_by_user_id
         FROM accepted_project_state accepted
         JOIN accepted_context_entries entry
           ON entry.workspace_id = accepted.workspace_id
          AND entry.project_id = accepted.project_id
          AND entry.accepted_state_id = accepted.id
         JOIN context_entry_exclusions exclusion
           ON exclusion.workspace_id = accepted.workspace_id
          AND exclusion.project_id = accepted.project_id
          AND exclusion.accepted_state_id = accepted.id
         JOIN candidate_claims candidate
           ON candidate.workspace_id = accepted.workspace_id
          AND candidate.project_id = accepted.project_id
          AND candidate.id = accepted.candidate_id
         JOIN evidence_events evidence
           ON evidence.workspace_id = accepted.workspace_id
          AND evidence.project_id = accepted.project_id
          AND evidence.id = accepted.evidence_id
         WHERE accepted.workspace_id = ? AND accepted.project_id = ? AND entry.context_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM accepted_project_state newer
             JOIN accepted_context_entries newer_entry
               ON newer_entry.workspace_id = newer.workspace_id
              AND newer_entry.project_id = newer.project_id
              AND newer_entry.accepted_state_id = newer.id
             WHERE newer.workspace_id = accepted.workspace_id
               AND newer.project_id = accepted.project_id
               AND newer.state_key = accepted.state_key
               AND newer_entry.context_id = entry.context_id
               AND newer.version > accepted.version
           )
         ORDER BY exclusion.removed_at DESC, exclusion.id`,
      )
      .all(tenant.workspaceId, project.id, context.id)
  ).map((entry) => ({ ...entry, value: parseJson(entry.value_json), value_json: undefined }));

  const needsAttention = (
    await database
      .prepare(
        `SELECT candidate.id, candidate.state_key, candidate.value_json, candidate.summary,
                candidate.created_at, candidate.evidence_id, evidence.payload_hash,
                evidence.exact_payload_json, evidence.client_classification
         FROM candidate_claims candidate
         JOIN candidate_context_targets target
           ON target.workspace_id = candidate.workspace_id
          AND target.project_id = candidate.project_id
          AND target.candidate_id = candidate.id
         JOIN evidence_events evidence
           ON evidence.workspace_id = candidate.workspace_id
          AND evidence.project_id = candidate.project_id
          AND evidence.id = candidate.evidence_id
         WHERE candidate.workspace_id = ? AND candidate.project_id = ?
           AND target.context_id = ? AND candidate.status = 'pending'
         ORDER BY candidate.created_at DESC, candidate.id`,
      )
      .all(tenant.workspaceId, project.id, context.id)
  ).map((entry) => ({
    ...entry,
    value: parseJson(entry.value_json),
    value_json: undefined,
    capture_summary: captureSummary(entry.exact_payload_json),
    exact_payload_json: undefined,
  }));

  const history = (
    await database
      .prepare(
        `SELECT candidate.id, candidate.state_key, candidate.value_json, candidate.summary,
                candidate.status, candidate.created_at, candidate.evidence_id,
                accepted.id AS accepted_state_id, accepted.version, accepted.accepted_at,
                evidence.payload_hash, evidence.client_classification,
                exclusion.id AS exclusion_id, exclusion.reason AS removal_reason,
                exclusion.removed_at
         FROM candidate_claims candidate
         JOIN candidate_context_targets target
           ON target.workspace_id = candidate.workspace_id
          AND target.project_id = candidate.project_id
          AND target.candidate_id = candidate.id
         JOIN evidence_events evidence
           ON evidence.workspace_id = candidate.workspace_id
          AND evidence.project_id = candidate.project_id
          AND evidence.id = candidate.evidence_id
         LEFT JOIN accepted_project_state accepted
           ON accepted.workspace_id = candidate.workspace_id
          AND accepted.project_id = candidate.project_id
          AND accepted.candidate_id = candidate.id
         LEFT JOIN context_entry_exclusions exclusion
           ON exclusion.workspace_id = accepted.workspace_id
          AND exclusion.project_id = accepted.project_id
          AND exclusion.accepted_state_id = accepted.id
         WHERE candidate.workspace_id = ? AND candidate.project_id = ? AND target.context_id = ?
         ORDER BY candidate.created_at DESC, candidate.id`,
      )
      .all(tenant.workspaceId, project.id, context.id)
  ).map((entry) => ({ ...entry, value: parseJson(entry.value_json), value_json: undefined }));

  return {
    project,
    context,
    contexts,
    saved,
    needs_attention: needsAttention,
    removed,
    history,
  };
}
