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
         ORDER BY accepted.state_key, accepted.id`,
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
                evidence.payload_hash, evidence.client_classification
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
    removed: [],
    history,
  };
}
