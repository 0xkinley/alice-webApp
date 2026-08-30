import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForUser } from "./authorization.ts";

async function pendingCandidate(database, workspaceId, candidateId) {
  return database
    .prepare(
      `SELECT * FROM candidate_claims
       WHERE id = ? AND workspace_id = ? AND status = 'pending'
       FOR UPDATE`,
    )
    .get(candidateId, workspaceId);
}

async function candidateContextId(database, workspaceId, candidate) {
  const targeted = await database
    .prepare(
      `SELECT context_id FROM candidate_context_targets
       WHERE workspace_id = ? AND project_id = ? AND candidate_id = ?`,
    )
    .get(workspaceId, candidate.project_id, candidate.id);
  if (targeted) return targeted.context_id;
  const projectWide = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND context_kind = 'project_wide'`,
    )
    .get(workspaceId, candidate.project_id);
  if (!projectWide) throw new Error("Candidate project context is missing.");
  await database
    .prepare(
      `INSERT INTO candidate_context_targets
        (candidate_id, workspace_id, project_id, context_id, targeted_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(candidate.id, workspaceId, candidate.project_id, projectWide.id, candidate.created_at);
  return projectWide.id;
}

async function currentAcceptedState(database, workspaceId, candidate, contextId) {
  return database
    .prepare(
      `SELECT accepted.id, accepted.version
       FROM accepted_project_state accepted
       LEFT JOIN accepted_context_entries entry
         ON entry.workspace_id = accepted.workspace_id
        AND entry.project_id = accepted.project_id
        AND entry.accepted_state_id = accepted.id
       WHERE accepted.workspace_id = ? AND accepted.project_id = ?
         AND accepted.state_key = ?
         AND (
           entry.context_id = ?
           OR (
             entry.accepted_state_id IS NULL
             AND EXISTS (
               SELECT 1 FROM work_contexts context
               WHERE context.id = ? AND context.workspace_id = accepted.workspace_id
                 AND context.project_id = accepted.project_id
                 AND context.context_kind = 'project_wide'
             )
           )
         )
       ORDER BY accepted.version DESC LIMIT 1`,
    )
    .get(workspaceId, candidate.project_id, candidate.state_key, contextId, contextId);
}

async function acceptPendingCandidate(database, { candidate, contextId, current, tenant, userId }) {
  const acceptedAt = new Date().toISOString();
  const acceptedStateId = `accepted_${randomUUID()}`;
  const correlationId = `review_${randomUUID()}`;
  const latestVersion = await database
    .prepare(
      `SELECT MAX(version) AS version FROM accepted_project_state
       WHERE workspace_id = ? AND project_id = ? AND state_key = ?`,
    )
    .get(tenant.workspaceId, candidate.project_id, candidate.state_key);
  const version = Number(latestVersion.version || 0) + 1;
  await database
    .prepare(
      `INSERT INTO accepted_project_state
        (id, workspace_id, project_id, candidate_id, evidence_id, state_key,
         value_json, version, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      acceptedStateId,
      tenant.workspaceId,
      candidate.project_id,
      candidate.id,
      candidate.evidence_id,
      candidate.state_key,
      candidate.value_json,
      version,
      acceptedAt,
    );
  await database
    .prepare(
      `INSERT INTO accepted_context_entries
        (accepted_state_id, workspace_id, project_id, context_id, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(acceptedStateId, tenant.workspaceId, candidate.project_id, contextId, acceptedAt);
  const changed = await database
    .prepare(
      `UPDATE candidate_claims SET status = 'accepted'
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .run(candidate.id, tenant.workspaceId);
  if (changed.changes !== 1) throw new Error("Candidate acceptance lost a concurrent race.");
  const action = current ? "accepted_state_superseded" : "candidate_accepted";
  const audit = await appendAuditEvent(database, {
    workspaceId: tenant.workspaceId,
    projectId: candidate.project_id,
    action,
    actorType: "human_reviewer",
    actorId: userId,
    correlationId,
    metadata: {
      accepted_state_id: acceptedStateId,
      candidate_id: candidate.id,
      evidence_id: candidate.evidence_id,
      context_id: contextId,
      state_key: candidate.state_key,
      version,
      ...(current
        ? {
            superseded_accepted_state_id: current.id,
            superseded_version: current.version,
          }
        : {}),
    },
  });
  return {
    acceptedStateId,
    auditEventId: audit.id,
    correlationId,
    projectId: candidate.project_id,
    candidateId: candidate.id,
    evidenceId: candidate.evidence_id,
    contextId,
    version,
    reviewedAt: audit.created_at,
    supersededAcceptedStateId: current?.id,
  };
}

export async function acceptCandidate(database, { candidateId, userId }) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return database.transaction(
    async () => {
      const candidate = await pendingCandidate(database, tenant.workspaceId, candidateId);
      const contextId =
        candidate && (await candidateContextId(database, tenant.workspaceId, candidate));
      if (candidate) {
        await database
          .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
          .get(`${tenant.workspaceId}:${candidate.project_id}:${candidate.state_key}`);
      }
      const current =
        candidate &&
        (await currentAcceptedState(database, tenant.workspaceId, candidate, contextId));
      if (!candidate || current) {
        return undefined;
      }
      return acceptPendingCandidate(database, {
        candidate,
        contextId,
        current: undefined,
        tenant,
        userId,
      });
    },
    { isolation: "READ COMMITTED" },
  );
}

export async function supersedeAcceptedState(
  database,
  { candidateId, supersededAcceptedStateId, userId },
) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return database.transaction(
    async () => {
      const candidate = await pendingCandidate(database, tenant.workspaceId, candidateId);
      const contextId =
        candidate && (await candidateContextId(database, tenant.workspaceId, candidate));
      if (candidate) {
        await database
          .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
          .get(`${tenant.workspaceId}:${candidate.project_id}:${candidate.state_key}`);
      }
      const current =
        candidate &&
        (await currentAcceptedState(database, tenant.workspaceId, candidate, contextId));
      if (!candidate || !current || current.id !== supersededAcceptedStateId) {
        return undefined;
      }
      return acceptPendingCandidate(database, {
        candidate,
        contextId,
        current,
        tenant,
        userId,
      });
    },
    { isolation: "READ COMMITTED" },
  );
}

export async function rejectCandidate(database, { candidateId, userId }) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return database.transaction(
    async () => {
      const candidate = await pendingCandidate(database, tenant.workspaceId, candidateId);
      if (!candidate) {
        return undefined;
      }
      const correlationId = `review_${randomUUID()}`;
      const changed = await database
        .prepare(
          `UPDATE candidate_claims SET status = 'rejected'
         WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
        )
        .run(candidate.id, tenant.workspaceId);
      if (changed.changes !== 1) throw new Error("Candidate rejection lost a concurrent race.");
      const audit = await appendAuditEvent(database, {
        workspaceId: tenant.workspaceId,
        projectId: candidate.project_id,
        action: "candidate_rejected",
        actorType: "human_reviewer",
        actorId: userId,
        correlationId,
        metadata: {
          candidate_id: candidate.id,
          evidence_id: candidate.evidence_id,
          state_key: candidate.state_key,
        },
      });
      return {
        auditEventId: audit.id,
        correlationId,
        projectId: candidate.project_id,
        candidateId: candidate.id,
        evidenceId: candidate.evidence_id,
        reviewedAt: audit.created_at,
      };
    },
    { isolation: "READ COMMITTED" },
  );
}
