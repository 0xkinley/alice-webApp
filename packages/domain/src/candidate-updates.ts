import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";

// Host submissions remain candidate-only domain operations.

function workspaceIdForUser(database, userId) {
  return database.prepare("SELECT id FROM workspaces WHERE user_id = ?").get(userId)?.id;
}

function clientClassification(database, clientId) {
  const row = database
    .prepare("SELECT client_name FROM oauth_clients WHERE client_id = ?")
    .get(clientId);
  const name = String(row?.client_name || "unknown").toLowerCase();
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("claude") || name.includes("anthropic")) return "claude";
  return "unknown_mcp_client";
}

function existingSubmission(
  database,
  connectionId,
  projectId,
  idempotencyKey,
  payloadHash,
  reviewUrl,
) {
  const evidence = database
    .prepare(
      `SELECT id, payload_hash FROM evidence_events
       WHERE connection_id = ? AND project_id = ? AND idempotency_key = ?`,
    )
    .get(connectionId, projectId, idempotencyKey);
  if (!evidence) return undefined;
  if (evidence.payload_hash !== payloadHash) {
    return { error: "The idempotency key was already used with a different payload." };
  }
  const candidates = database
    .prepare("SELECT id FROM candidate_claims WHERE evidence_id = ? ORDER BY created_at, id")
    .all(evidence.id);
  return {
    evidence_id: evidence.id,
    candidate_ids: candidates.map((candidate) => candidate.id),
    status: "pending_review",
    trusted_state_changed: false,
    deduplicated: true,
    review_url: reviewUrl,
  };
}

export function saveCandidateUpdate(
  database,
  { clientId, connectionId, publicUrl, userId, payload },
) {
  const workspaceId = workspaceIdForUser(database, userId);
  if (!workspaceId || !connectionId) return { error: "Authenticated tenant context is missing." };
  const project = database
    .prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?")
    .get(payload.project_id, workspaceId);
  if (!project) return { error: "Project not found in the authenticated workspace." };

  const reviewUrl = new URL(`/review?project_id=${encodeURIComponent(project.id)}`, publicUrl).href;
  const exactPayloadJson = JSON.stringify(payload);
  const payloadHash = createHash("sha256").update(exactPayloadJson).digest("hex");
  const duplicate = existingSubmission(
    database,
    connectionId,
    project.id,
    payload.idempotency_key,
    payloadHash,
    reviewUrl,
  );
  if (duplicate) return duplicate;

  const evidenceId = `evidence_${randomUUID()}`;
  const candidateIds = payload.candidate_claims.map(() => `candidate_${randomUUID()}`);
  const correlationId = `capture_${randomUUID()}`;
  const createdAt = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO evidence_events
          (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
           client_id, client_classification, tool_name, idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidenceId,
        workspaceId,
        project.id,
        exactPayloadJson,
        "mcp_host",
        connectionId,
        clientId,
        clientClassification(database, clientId),
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
    payload.candidate_claims.forEach((claim, index) => {
      insertCandidate.run(
        candidateIds[index],
        workspaceId,
        project.id,
        evidenceId,
        claim.state_key,
        JSON.stringify(claim.value),
        claim.summary,
        createdAt,
      );
    });

    appendAuditEvent(database, {
      workspaceId,
      projectId: project.id,
      action: "candidate_update_submitted",
      actorType: "mcp_host",
      actorId: clientId,
      correlationId,
      metadata: { evidence_id: evidenceId, candidate_count: candidateIds.length },
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    const racedDuplicate = existingSubmission(
      database,
      connectionId,
      project.id,
      payload.idempotency_key,
      payloadHash,
      reviewUrl,
    );
    if (racedDuplicate) return racedDuplicate;
    throw error;
  }

  return {
    evidence_id: evidenceId,
    candidate_ids: candidateIds,
    status: "pending_review",
    trusted_state_changed: false,
    deduplicated: false,
    review_url: reviewUrl,
  };
}
