import { tenantScopeForUser } from "./authorization.ts";

export function getReviewQueue(database, { userId, projectId }) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const project = database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, tenant.workspaceId);
  if (!project) return undefined;
  const candidates = database
    .prepare(
      `SELECT candidate.*, evidence.client_classification,
              evidence.created_at AS evidence_created_at
       FROM candidate_claims candidate
       JOIN evidence_events evidence
         ON evidence.id = candidate.evidence_id
        AND evidence.project_id = candidate.project_id
        AND evidence.workspace_id = candidate.workspace_id
       WHERE candidate.project_id = ? AND candidate.workspace_id = ?
       ORDER BY candidate.created_at, candidate.id`,
    )
    .all(project.id, tenant.workspaceId);
  return { project, candidates };
}
