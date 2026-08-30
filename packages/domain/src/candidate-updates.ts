import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForConnection } from "./authorization.ts";

// Host submissions remain candidate-only domain operations.

async function clientClassification(database, clientId) {
  const row = await database
    .prepare("SELECT client_name FROM oauth_clients WHERE client_id = ?")
    .get(clientId);
  const name = String(row?.client_name || "unknown").toLowerCase();
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("claude") || name.includes("anthropic")) return "claude";
  return "unknown_mcp_client";
}

async function existingSubmission(
  database,
  workspaceId,
  connectionId,
  projectId,
  idempotencyKey,
  payloadHash,
  reviewUrl,
) {
  const evidence = await database
    .prepare(
      `SELECT id, exact_payload_json, actor_type, connection_id, client_id,
              client_classification, tool_name, payload_hash, created_at
       FROM evidence_events
       WHERE workspace_id = ? AND connection_id = ? AND project_id = ? AND idempotency_key = ?`,
    )
    .get(workspaceId, connectionId, projectId, idempotencyKey);
  if (!evidence) return undefined;
  if (evidence.payload_hash !== payloadHash) {
    return { error: "The idempotency key was already used with a different payload." };
  }

  const candidates = await database
    .prepare(
      `SELECT id, state_key, status FROM candidate_claims
       WHERE workspace_id = ? AND project_id = ? AND evidence_id = ?
       ORDER BY created_at, id`,
    )
    .all(workspaceId, projectId, evidence.id);
  const targets = await database
    .prepare(
      `SELECT DISTINCT target.context_id
       FROM candidate_context_targets target
       JOIN candidate_claims candidate
         ON candidate.workspace_id = target.workspace_id
        AND candidate.project_id = target.project_id
        AND candidate.id = target.candidate_id
       WHERE target.workspace_id = ? AND target.project_id = ? AND candidate.evidence_id = ?`,
    )
    .all(workspaceId, projectId, evidence.id);
  const auditEvents = await database
    .prepare(
      `SELECT id, correlation_id FROM audit_events
       WHERE workspace_id = ? AND project_id = ? AND action = 'candidate_update_submitted'
         AND safe_metadata_json::jsonb ->> 'evidence_id' = ?
       ORDER BY created_at, id`,
    )
    .all(workspaceId, projectId, evidence.id);

  let submittedClaims;
  try {
    submittedClaims = JSON.parse(evidence.exact_payload_json).candidate_claims;
  } catch {
    return { error: "The stored capture receipt is incomplete." };
  }
  if (!Array.isArray(submittedClaims) || submittedClaims.length !== candidates.length) {
    return { error: "The stored capture receipt is incomplete." };
  }

  const candidatesByStateKey = new Map();
  for (const candidate of candidates) {
    const bucket = candidatesByStateKey.get(candidate.state_key) || [];
    bucket.push(candidate);
    candidatesByStateKey.set(candidate.state_key, bucket);
  }
  const orderedCandidates = submittedClaims.map((claim) =>
    candidatesByStateKey.get(claim.state_key)?.shift(),
  );
  if (
    orderedCandidates.some((candidate) => !candidate) ||
    [...candidatesByStateKey.values()].some((bucket) => bucket.length > 0) ||
    auditEvents.length !== 1 ||
    targets.length !== 1
  ) {
    return { error: "The stored capture receipt is incomplete." };
  }

  const statuses = orderedCandidates.map((candidate) => candidate.status);
  const pendingCount = statuses.filter((status) => status === "pending").length;
  const status =
    pendingCount === statuses.length
      ? "pending_review"
      : pendingCount === 0
        ? "reviewed"
        : "partially_reviewed";
  const audit = auditEvents[0];
  return {
    evidence_id: evidence.id,
    context_id: targets[0].context_id,
    candidate_ids: orderedCandidates.map((candidate) => candidate.id),
    candidate_statuses: orderedCandidates.map((candidate) => ({
      candidate_id: candidate.id,
      status: candidate.status,
    })),
    audit_event_id: audit.id,
    correlation_id: audit.correlation_id,
    status,
    trusted_state_changed: false,
    deduplicated: true,
    review_url: reviewUrl,
    provenance: {
      actor_type: evidence.actor_type,
      connection_id: evidence.connection_id,
      client_id: evidence.client_id,
      client_classification: evidence.client_classification,
      tool_name: evidence.tool_name,
      payload_hash: evidence.payload_hash,
      captured_at: evidence.created_at,
    },
  };
}

export async function saveCandidateUpdate(
  database,
  { clientId, connectionId, publicUrl, userId, payload },
) {
  const tenant = await tenantScopeForConnection(database, { userId, connectionId });
  if (!tenant || tenant.clientId !== clientId) {
    return { error: "Authenticated tenant context is missing." };
  }
  const project = await database
    .prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?")
    .get(payload.project_id, tenant.workspaceId);
  if (!project) return { error: "Project not found in the authenticated workspace." };

  const targetContext = await database
    .prepare(
      `SELECT id
       FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL
         AND ${payload.context_id ? "id = ?" : "context_kind = 'project_wide'"}`,
    )
    .get(tenant.workspaceId, project.id, ...(payload.context_id ? [payload.context_id] : []));
  if (!targetContext) return { error: "Context not found in the authenticated project." };

  const reviewUrl = new URL(
    `/review?project_id=${encodeURIComponent(project.id)}&context_id=${encodeURIComponent(targetContext.id)}`,
    publicUrl,
  ).href;
  const exactPayloadJson = JSON.stringify(payload);
  const payloadHash = createHash("sha256").update(exactPayloadJson).digest("hex");
  const evidenceId = `evidence_${randomUUID()}`;
  const candidateIds = payload.candidate_claims.map(() => `candidate_${randomUUID()}`);
  const correlationId = `capture_${randomUUID()}`;
  const createdAt = new Date().toISOString();

  return database.transaction(
    async () => {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`${connectionId}:${project.id}:${payload.idempotency_key}`);
      const duplicate = await existingSubmission(
        database,
        tenant.workspaceId,
        connectionId,
        project.id,
        payload.idempotency_key,
        payloadHash,
        reviewUrl,
      );
      if (duplicate) {
        return duplicate;
      }

      await database
        .prepare(
          `INSERT INTO evidence_events
          (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
           client_id, client_classification, tool_name, idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidenceId,
          tenant.workspaceId,
          project.id,
          exactPayloadJson,
          "mcp_host",
          connectionId,
          clientId,
          await clientClassification(database, clientId),
          "save_project_update",
          payload.idempotency_key,
          payloadHash,
          createdAt,
        );

      const insertCandidate = database.prepare(
        `INSERT INTO candidate_claims
        (id, workspace_id, project_id, evidence_id, state_key, value_json, summary, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      );
      for (const [index, claim] of payload.candidate_claims.entries()) {
        await insertCandidate.run(
          candidateIds[index],
          tenant.workspaceId,
          project.id,
          evidenceId,
          claim.state_key,
          JSON.stringify(claim.value),
          claim.summary,
          createdAt,
        );
        await database
          .prepare(
            `INSERT INTO candidate_context_targets
              (candidate_id, workspace_id, project_id, context_id, targeted_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(candidateIds[index], tenant.workspaceId, project.id, targetContext.id, createdAt);
      }

      await appendAuditEvent(database, {
        workspaceId: tenant.workspaceId,
        projectId: project.id,
        action: "candidate_update_submitted",
        actorType: "mcp_host",
        actorId: clientId,
        correlationId,
        metadata: {
          evidence_id: evidenceId,
          candidate_ids: candidateIds,
          candidate_count: candidateIds.length,
          context_id: targetContext.id,
          connection_id: connectionId,
          payload_hash: payloadHash,
        },
      });
      const result = await existingSubmission(
        database,
        tenant.workspaceId,
        connectionId,
        project.id,
        payload.idempotency_key,
        payloadHash,
        reviewUrl,
      );
      if (!result || result.error) throw new Error("Capture receipt was not created atomically.");
      return { ...result, deduplicated: false };
    },
    { isolation: "READ COMMITTED" },
  );
}
