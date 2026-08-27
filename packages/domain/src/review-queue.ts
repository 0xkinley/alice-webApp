import { tenantScopeForUser } from "./authorization.ts";

const REVIEW_STATUSES = new Set(["all", "pending", "accepted", "rejected"]);

function captureDetails(exactPayloadJson) {
  try {
    const payload = JSON.parse(exactPayloadJson);
    return {
      capture_summary: payload.summary,
      source_note: payload.source_note,
      source_context: payload.source_context,
    };
  } catch {
    return { capture_summary: undefined, source_note: undefined, source_context: undefined };
  }
}

export function listReviewProjects(database, userId) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return [];
  return database
    .prepare(
      `SELECT project.id, project.name, project.brief,
              COUNT(candidate.id) AS total_count,
              COALESCE(SUM(CASE WHEN candidate.status = 'pending' THEN 1 ELSE 0 END), 0)
                AS pending_count,
              COALESCE(SUM(CASE WHEN candidate.status = 'accepted' THEN 1 ELSE 0 END), 0)
                AS accepted_count,
              COALESCE(SUM(CASE WHEN candidate.status = 'rejected' THEN 1 ELSE 0 END), 0)
                AS rejected_count,
              MAX(candidate.created_at) AS latest_candidate_at
       FROM projects project
       LEFT JOIN candidate_claims candidate
         ON candidate.project_id = project.id
        AND candidate.workspace_id = project.workspace_id
       WHERE project.workspace_id = ?
       GROUP BY project.id, project.name, project.brief
       ORDER BY pending_count DESC, latest_candidate_at DESC, project.name, project.id`,
    )
    .all(tenant.workspaceId);
}

export function getReviewQueue(
  database,
  { userId, projectId, status = "pending", page = 1, pageSize = 20 },
) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant || !REVIEW_STATUSES.has(status)) return undefined;
  const project = database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, tenant.workspaceId);
  if (!project) return undefined;

  const counts = database
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
              COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
       FROM candidate_claims
       WHERE project_id = ? AND workspace_id = ?`,
    )
    .get(project.id, tenant.workspaceId);
  const selectedTotal = status === "all" ? counts.total : counts[status];
  const boundedPageSize = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const pageCount = Math.max(1, Math.ceil(selectedTotal / boundedPageSize));
  const boundedPage = Math.min(pageCount, Math.max(1, Number(page) || 1));
  const statusClause = status === "all" ? "" : "AND candidate.status = ?";
  const parameters =
    status === "all"
      ? [project.id, tenant.workspaceId, boundedPageSize, (boundedPage - 1) * boundedPageSize]
      : [
          project.id,
          tenant.workspaceId,
          status,
          boundedPageSize,
          (boundedPage - 1) * boundedPageSize,
        ];
  const candidates = database
    .prepare(
      `SELECT candidate.id, candidate.state_key, candidate.value_json, candidate.summary,
              candidate.status, candidate.created_at,
              evidence.id AS evidence_id, evidence.exact_payload_json,
              evidence.actor_type, evidence.connection_id, evidence.client_id,
              evidence.client_classification, evidence.tool_name,
              evidence.payload_hash, evidence.created_at AS evidence_created_at,
              accepted.id AS accepted_state_id, accepted.version AS accepted_version,
              accepted.accepted_at
       FROM candidate_claims candidate
       JOIN evidence_events evidence
         ON evidence.id = candidate.evidence_id
        AND evidence.project_id = candidate.project_id
        AND evidence.workspace_id = candidate.workspace_id
       LEFT JOIN accepted_project_state accepted
         ON accepted.candidate_id = candidate.id
        AND accepted.project_id = candidate.project_id
        AND accepted.workspace_id = candidate.workspace_id
       WHERE candidate.project_id = ? AND candidate.workspace_id = ?
         ${statusClause}
       ORDER BY CASE WHEN candidate.status = 'pending' THEN 0 ELSE 1 END,
                candidate.created_at DESC, candidate.id
       LIMIT ? OFFSET ?`,
    )
    .all(...parameters)
    .map((candidate) => ({
      ...candidate,
      ...captureDetails(candidate.exact_payload_json),
      exact_payload_json: undefined,
    }));
  return {
    project,
    candidates,
    counts,
    filter: status,
    pagination: {
      page: boundedPage,
      page_count: pageCount,
      page_size: boundedPageSize,
      selected_total: selectedTotal,
    },
  };
}
