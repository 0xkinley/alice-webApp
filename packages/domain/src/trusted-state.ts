import { createHash, randomUUID } from "node:crypto";
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
      `SELECT accepted.id, accepted.version, accepted.value_json, accepted.accepted_at
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

function capturePreviewVersion(preview) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        evidence_id: preview.evidence_id,
        payload_hash: preview.payload_hash,
        project_id: preview.project.id,
        context_id: preview.context.id,
        candidates: preview.candidates.map((candidate) => ({
          id: candidate.id,
          state_key: candidate.state_key,
          value_json: candidate.value_json,
          summary: candidate.summary,
          status: candidate.status,
          current_accepted_state_id: candidate.current?.id || null,
          current_accepted_version: candidate.current?.version || null,
          current_accepted_value_json: candidate.current?.value_json || null,
        })),
      }),
    )
    .digest("hex");
  return `capture_preview_${digest}`;
}

async function captureCandidates(database, tenant, evidenceId, { lock = false } = {}) {
  const evidence = await database
    .prepare(
      `SELECT evidence.id, evidence.project_id, evidence.exact_payload_json,
              evidence.payload_hash, evidence.created_at, evidence.client_classification,
              project.name AS project_name, project.brief AS project_brief
       FROM evidence_events evidence
       JOIN projects project
         ON project.workspace_id = evidence.workspace_id AND project.id = evidence.project_id
       WHERE evidence.id = ? AND evidence.workspace_id = ?`,
    )
    .get(evidenceId, tenant.workspaceId);
  if (!evidence) return undefined;
  const candidates = await database
    .prepare(
      `SELECT candidate.id, candidate.project_id, candidate.evidence_id,
              candidate.state_key, candidate.value_json, candidate.summary,
              candidate.status, candidate.created_at, target.context_id
       FROM candidate_claims candidate
       JOIN candidate_context_targets target
         ON target.workspace_id = candidate.workspace_id
        AND target.project_id = candidate.project_id
        AND target.candidate_id = candidate.id
       WHERE candidate.evidence_id = ? AND candidate.workspace_id = ?
       ORDER BY candidate.id${lock ? " FOR UPDATE OF candidate" : ""}`,
    )
    .all(evidence.id, tenant.workspaceId);
  if (candidates.length === 0) return undefined;
  const contextIds = new Set(candidates.map(({ context_id: contextId }) => contextId));
  if (contextIds.size !== 1) throw new Error("Captured update has inconsistent context targets.");
  const context = await database
    .prepare(
      `SELECT id, name, description, visibility, updated_at
       FROM work_contexts
       WHERE id = ? AND workspace_id = ? AND project_id = ? AND archived_at IS NULL`,
    )
    .get(candidates[0].context_id, tenant.workspaceId, evidence.project_id);
  if (!context) return undefined;
  return { candidates, context, evidence };
}

async function buildCapturePreview(database, tenant, evidenceId, options = {}) {
  const captured = await captureCandidates(database, tenant, evidenceId, options);
  if (!captured) return undefined;
  const candidates: any[] = [];
  for (const candidate of captured.candidates) {
    candidates.push({
      ...candidate,
      current: await currentAcceptedState(
        database,
        tenant.workspaceId,
        candidate,
        candidate.context_id,
      ),
    });
  }
  const preview = {
    evidence_id: captured.evidence.id,
    payload_hash: captured.evidence.payload_hash,
    captured_at: captured.evidence.created_at,
    client_classification: captured.evidence.client_classification,
    project: {
      id: captured.evidence.project_id,
      name: captured.evidence.project_name,
      brief: captured.evidence.project_brief,
    },
    context: captured.context,
    candidates,
    ...captureDetails(captured.evidence.exact_payload_json),
  };
  return { ...preview, preview_version: capturePreviewVersion(preview) };
}

export async function getCapturePreview(database, { evidenceId, userId }) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return buildCapturePreview(database, tenant, evidenceId);
}

async function acceptPendingCandidate(database, options) {
  const { candidate, contextId, current, tenant, userId } = options;
  let { acceptedAt, correlationId } = options;
  acceptedAt ||= new Date().toISOString();
  const acceptedStateId = `accepted_${randomUUID()}`;
  correlationId ||= `review_${randomUUID()}`;
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

export async function confirmCapturedUpdate(
  database,
  { evidenceId, expectedPreviewVersion, userId },
) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return database.transaction(
    async () => {
      const captured = await captureCandidates(database, tenant, evidenceId, { lock: true });
      if (!captured) return undefined;
      for (const stateKey of [
        ...new Set(captured.candidates.map(({ state_key: key }) => key)),
      ].sort()) {
        await database
          .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
          .get(`${tenant.workspaceId}:${captured.evidence.project_id}:${stateKey}`);
      }
      const preview = await buildCapturePreview(database, tenant, evidenceId);
      if (
        !preview ||
        preview.preview_version !== expectedPreviewVersion ||
        preview.candidates.some(({ status }) => status !== "pending")
      ) {
        return { conflict: true };
      }

      const acceptedAt = new Date().toISOString();
      const correlationId = `capture_confirmation_${randomUUID()}`;
      const accepted: any[] = [];
      for (const candidate of preview.candidates) {
        accepted.push(
          await acceptPendingCandidate(database, {
            candidate,
            contextId: preview.context.id,
            current: candidate.current,
            tenant,
            userId,
            acceptedAt,
            correlationId,
          }),
        );
      }
      const audit = await appendAuditEvent(database, {
        workspaceId: tenant.workspaceId,
        projectId: preview.project.id,
        action: "candidate_update_confirmed",
        actorType: "human_reviewer",
        actorId: userId,
        correlationId,
        metadata: {
          evidence_id: preview.evidence_id,
          candidate_ids: preview.candidates.map(({ id }) => id),
          context_id: preview.context.id,
        },
      });
      return {
        conflict: false,
        projectId: preview.project.id,
        contextId: preview.context.id,
        evidenceId: preview.evidence_id,
        accepted,
        auditEventId: audit.id,
        correlationId,
      };
    },
    { isolation: "READ COMMITTED" },
  );
}

export async function cancelCapturedUpdate(
  database,
  { evidenceId, expectedPreviewVersion, userId },
) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return database.transaction(
    async () => {
      const preview = await buildCapturePreview(database, tenant, evidenceId, { lock: true });
      if (!preview) return undefined;
      if (
        preview.preview_version !== expectedPreviewVersion ||
        preview.candidates.some(({ status }) => status !== "pending")
      ) {
        return { conflict: true };
      }
      const correlationId = `capture_cancellation_${randomUUID()}`;
      for (const candidate of preview.candidates) {
        const changed = await database
          .prepare(
            `UPDATE candidate_claims SET status = 'rejected'
             WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
          )
          .run(candidate.id, tenant.workspaceId);
        if (changed.changes !== 1)
          throw new Error("Candidate cancellation lost a concurrent race.");
        await appendAuditEvent(database, {
          workspaceId: tenant.workspaceId,
          projectId: preview.project.id,
          action: "candidate_rejected",
          actorType: "human_reviewer",
          actorId: userId,
          correlationId,
          metadata: {
            candidate_id: candidate.id,
            evidence_id: preview.evidence_id,
            context_id: preview.context.id,
            state_key: candidate.state_key,
            cancellation: true,
          },
        });
      }
      const audit = await appendAuditEvent(database, {
        workspaceId: tenant.workspaceId,
        projectId: preview.project.id,
        action: "candidate_update_cancelled",
        actorType: "human_reviewer",
        actorId: userId,
        correlationId,
        metadata: {
          evidence_id: preview.evidence_id,
          candidate_ids: preview.candidates.map(({ id }) => id),
          context_id: preview.context.id,
        },
      });
      return {
        conflict: false,
        projectId: preview.project.id,
        contextId: preview.context.id,
        evidenceId: preview.evidence_id,
        auditEventId: audit.id,
        correlationId,
        reviewedAt: audit.created_at,
      };
    },
    { isolation: "READ COMMITTED" },
  );
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
