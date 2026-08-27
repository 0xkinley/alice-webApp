import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForUser } from "./authorization.ts";

export function acceptCandidate(database, { candidateId, userId }) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const candidate = database
    .prepare(
      `SELECT * FROM candidate_claims
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .get(candidateId, tenant.workspaceId);
  if (!candidate) return undefined;

  const acceptedAt = new Date().toISOString();
  const acceptedStateId = `accepted_${randomUUID()}`;
  const correlationId = `review_${randomUUID()}`;
  database.exec("BEGIN IMMEDIATE");
  try {
    const { version } = database
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM accepted_project_state
         WHERE workspace_id = ? AND project_id = ? AND state_key = ?`,
      )
      .get(tenant.workspaceId, candidate.project_id, candidate.state_key);
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
    appendAuditEvent(database, {
      workspaceId: tenant.workspaceId,
      projectId: candidate.project_id,
      action: "candidate_accepted",
      actorType: "human_reviewer",
      actorId: userId,
      correlationId,
      metadata: {
        accepted_state_id: acceptedStateId,
        candidate_id: candidate.id,
        evidence_id: candidate.evidence_id,
        state_key: candidate.state_key,
        version,
      },
    });
    database.exec("COMMIT");
    return {
      acceptedStateId,
      projectId: candidate.project_id,
      candidateId: candidate.id,
      evidenceId: candidate.evidence_id,
      version,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
