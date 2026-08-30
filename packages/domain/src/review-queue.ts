import { contextScopeForUser, projectScopeForUser, tenantScopeForUser } from "./authorization.ts";

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

export async function listReviewProjects(database, userId) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return [];
  const projects = await database
    .prepare(
      `SELECT project.id, project.name, project.brief
       FROM projects project
       JOIN project_memberships membership
         ON membership.workspace_id = project.workspace_id
        AND membership.project_id = project.id
       WHERE membership.user_id = ? AND membership.ended_at IS NULL
         AND membership.role IN ('owner', 'editor')
         AND project.archived_at IS NULL
       ORDER BY project.name, project.id`,
    )
    .all(tenant.userId);
  const reviewable: any[] = [];
  for (const project of projects) {
    const queue = await getReviewQueue(database, {
      userId,
      projectId: project.id,
      status: "all",
      page: 1,
      pageSize: 1,
    });
    if (!queue) continue;
    reviewable.push({
      ...project,
      total_count: queue.counts.total,
      pending_count: queue.counts.pending,
      accepted_count: queue.counts.accepted,
      rejected_count: queue.counts.rejected,
      latest_candidate_at: queue.latest_candidate_at,
    });
  }
  return reviewable.sort(
    (left, right) =>
      right.pending_count - left.pending_count ||
      String(right.latest_candidate_at || "").localeCompare(
        String(left.latest_candidate_at || ""),
      ) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

export async function getReviewQueue(
  database,
  { userId, projectId, status = "pending", page = 1, pageSize = 20 },
) {
  const scope = await projectScopeForUser(database, {
    userId,
    projectId,
    capability: "write",
  });
  if (!scope || !REVIEW_STATUSES.has(status)) return undefined;
  const project = await database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, scope.projectWorkspaceId);
  if (!project) return undefined;
  const allCandidates = (
    await database
      .prepare(
        `SELECT candidate.id, candidate.state_key, candidate.value_json, candidate.summary,
              candidate.status, candidate.created_at,
              evidence.id AS evidence_id, evidence.exact_payload_json,
              evidence.actor_type, evidence.connection_id, evidence.client_id,
              evidence.client_classification, evidence.tool_name,
              evidence.payload_hash, evidence.created_at AS evidence_created_at,
              accepted.id AS accepted_state_id, accepted.version AS accepted_version,
              accepted.accepted_at,
              target.context_id,
              (SELECT current.id FROM accepted_project_state current
               JOIN accepted_context_entries current_entry
                 ON current_entry.workspace_id = current.workspace_id
                AND current_entry.project_id = current.project_id
                AND current_entry.accepted_state_id = current.id
                AND current_entry.context_id = target.context_id
               WHERE current.workspace_id = candidate.workspace_id
                 AND current.project_id = candidate.project_id
                 AND current.state_key = candidate.state_key
               ORDER BY current.version DESC LIMIT 1) AS current_accepted_state_id,
              (SELECT current.version FROM accepted_project_state current
               JOIN accepted_context_entries current_entry
                 ON current_entry.workspace_id = current.workspace_id
                AND current_entry.project_id = current.project_id
                AND current_entry.accepted_state_id = current.id
                AND current_entry.context_id = target.context_id
               WHERE current.workspace_id = candidate.workspace_id
                 AND current.project_id = candidate.project_id
                 AND current.state_key = candidate.state_key
               ORDER BY current.version DESC LIMIT 1) AS current_accepted_version,
              (SELECT current.value_json FROM accepted_project_state current
               JOIN accepted_context_entries current_entry
                 ON current_entry.workspace_id = current.workspace_id
                AND current_entry.project_id = current.project_id
                AND current_entry.accepted_state_id = current.id
                AND current_entry.context_id = target.context_id
               WHERE current.workspace_id = candidate.workspace_id
                 AND current.project_id = candidate.project_id
                 AND current.state_key = candidate.state_key
               ORDER BY current.version DESC LIMIT 1) AS current_accepted_value_json,
              (SELECT audit.id FROM audit_events audit
               WHERE audit.workspace_id = candidate.workspace_id
                 AND audit.project_id = candidate.project_id
                 AND audit.action IN
                   ('candidate_accepted', 'candidate_rejected', 'accepted_state_superseded')
                 AND audit.safe_metadata_json::jsonb ->> 'candidate_id' = candidate.id
               ORDER BY audit.created_at, audit.id LIMIT 1) AS review_audit_id,
              (SELECT audit.actor_id FROM audit_events audit
               WHERE audit.workspace_id = candidate.workspace_id
                 AND audit.project_id = candidate.project_id
                 AND audit.action IN
                   ('candidate_accepted', 'candidate_rejected', 'accepted_state_superseded')
                 AND audit.safe_metadata_json::jsonb ->> 'candidate_id' = candidate.id
               ORDER BY audit.created_at, audit.id LIMIT 1) AS reviewer_user_id,
              (SELECT audit.correlation_id FROM audit_events audit
               WHERE audit.workspace_id = candidate.workspace_id
                 AND audit.project_id = candidate.project_id
                 AND audit.action IN
                   ('candidate_accepted', 'candidate_rejected', 'accepted_state_superseded')
                 AND audit.safe_metadata_json::jsonb ->> 'candidate_id' = candidate.id
               ORDER BY audit.created_at, audit.id LIMIT 1) AS review_correlation_id,
              (SELECT audit.created_at FROM audit_events audit
               WHERE audit.workspace_id = candidate.workspace_id
                 AND audit.project_id = candidate.project_id
                 AND audit.action IN
                   ('candidate_accepted', 'candidate_rejected', 'accepted_state_superseded')
                 AND audit.safe_metadata_json::jsonb ->> 'candidate_id' = candidate.id
               ORDER BY audit.created_at, audit.id LIMIT 1) AS reviewed_at
       FROM candidate_claims candidate
       JOIN candidate_context_targets target
         ON target.workspace_id = candidate.workspace_id
        AND target.project_id = candidate.project_id
        AND target.candidate_id = candidate.id
       JOIN evidence_events evidence
         ON evidence.id = candidate.evidence_id
        AND evidence.project_id = candidate.project_id
        AND evidence.workspace_id = candidate.workspace_id
       LEFT JOIN accepted_project_state accepted
         ON accepted.candidate_id = candidate.id
        AND accepted.project_id = candidate.project_id
        AND accepted.workspace_id = candidate.workspace_id
       WHERE candidate.project_id = ? AND candidate.workspace_id = ?
       ORDER BY CASE WHEN candidate.status = 'pending' THEN 0 ELSE 1 END,
                candidate.created_at DESC, candidate.id`,
      )
      .all(project.id, scope.projectWorkspaceId)
  ).map((candidate) => ({
    ...candidate,
    ...captureDetails(candidate.exact_payload_json),
    exact_payload_json: undefined,
  }));
  const permitted: any[] = [];
  for (const candidate of allCandidates) {
    if (
      await contextScopeForUser(database, {
        userId,
        projectId,
        contextId: candidate.context_id,
        capability: "write",
      })
    ) {
      permitted.push(candidate);
    }
  }
  const counts = {
    total: permitted.length,
    pending: permitted.filter(({ status: candidateStatus }) => candidateStatus === "pending")
      .length,
    accepted: permitted.filter(({ status: candidateStatus }) => candidateStatus === "accepted")
      .length,
    rejected: permitted.filter(({ status: candidateStatus }) => candidateStatus === "rejected")
      .length,
  };
  const selected =
    status === "all"
      ? permitted
      : permitted.filter(({ status: candidateStatus }) => candidateStatus === status);
  const selectedTotal = selected.length;
  const boundedPageSize = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const pageCount = Math.max(1, Math.ceil(selectedTotal / boundedPageSize));
  const boundedPage = Math.min(pageCount, Math.max(1, Number(page) || 1));
  const candidates = selected.slice(
    (boundedPage - 1) * boundedPageSize,
    boundedPage * boundedPageSize,
  );
  return {
    project,
    candidates,
    counts,
    latest_candidate_at: permitted[0]?.created_at || null,
    filter: status,
    pagination: {
      page: boundedPage,
      page_count: pageCount,
      page_size: boundedPageSize,
      selected_total: selectedTotal,
    },
  };
}
