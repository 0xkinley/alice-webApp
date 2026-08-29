import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForUser } from "./authorization.ts";

function pendingCandidate(database, workspaceId, candidateId) {
  return database
    .prepare(
      `SELECT * FROM candidate_claims
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .get(candidateId, workspaceId);
}

function currentAcceptedState(database, workspaceId, candidate) {
  return database
    .prepare(
      `SELECT id, version FROM accepted_project_state
       WHERE workspace_id = ? AND project_id = ? AND state_key = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(workspaceId, candidate.project_id, candidate.state_key);
}

function acceptPendingCandidate(database, { candidate, current, tenant, userId }) {
  const acceptedAt = new Date().toISOString();
  const acceptedStateId = `accepted_${randomUUID()}`;
  const correlationId = `review_${randomUUID()}`;
  const version = current ? current.version + 1 : 1;
  database
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
  const changed = database
    .prepare(
      `UPDATE candidate_claims SET status = 'accepted'
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .run(candidate.id, tenant.workspaceId);
  if (changed.changes !== 1) throw new Error("Candidate acceptance lost a concurrent race.");
  const action = current ? "accepted_state_superseded" : "candidate_accepted";
  const audit = appendAuditEvent(database, {
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
    version,
    reviewedAt: audit.created_at,
    supersededAcceptedStateId: current?.id,
  };
}

export function acceptCandidate(database, { candidateId, userId }) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  database.exec("BEGIN IMMEDIATE");
  try {
    const candidate = pendingCandidate(database, tenant.workspaceId, candidateId);
    const current = candidate && currentAcceptedState(database, tenant.workspaceId, candidate);
    if (!candidate || current) {
      database.exec("COMMIT");
      return undefined;
    }
    const result = acceptPendingCandidate(database, {
      candidate,
      current: undefined,
      tenant,
      userId,
    });
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function supersedeAcceptedState(
  database,
  { candidateId, supersededAcceptedStateId, userId },
) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  database.exec("BEGIN IMMEDIATE");
  try {
    const candidate = pendingCandidate(database, tenant.workspaceId, candidateId);
    const current = candidate && currentAcceptedState(database, tenant.workspaceId, candidate);
    if (!candidate || !current || current.id !== supersededAcceptedStateId) {
      database.exec("COMMIT");
      return undefined;
    }
    const result = acceptPendingCandidate(database, { candidate, current, tenant, userId });
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function rejectCandidate(database, { candidateId, userId }) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  database.exec("BEGIN IMMEDIATE");
  try {
    const candidate = pendingCandidate(database, tenant.workspaceId, candidateId);
    if (!candidate) {
      database.exec("COMMIT");
      return undefined;
    }
    const correlationId = `review_${randomUUID()}`;
    const changed = database
      .prepare(
        `UPDATE candidate_claims SET status = 'rejected'
         WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
      )
      .run(candidate.id, tenant.workspaceId);
    if (changed.changes !== 1) throw new Error("Candidate rejection lost a concurrent race.");
    const audit = appendAuditEvent(database, {
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
    database.exec("COMMIT");
    return {
      auditEventId: audit.id,
      correlationId,
      projectId: candidate.project_id,
      candidateId: candidate.id,
      evidenceId: candidate.evidence_id,
      reviewedAt: audit.created_at,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
