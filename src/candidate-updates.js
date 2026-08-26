import { createHash, randomUUID } from "node:crypto";

function workspaceIdForUser(userId) {
  return `workspace_${userId}`;
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

function existingSubmission(database, clientId, projectId, idempotencyKey, reviewUrl) {
  const evidence = database
    .prepare(
      `SELECT id FROM evidence_events
       WHERE client_id = ? AND project_id = ? AND idempotency_key = ?`,
    )
    .get(clientId, projectId, idempotencyKey);
  if (!evidence) return undefined;
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
  { clientId, publicUrl, userId, payload },
) {
  const workspaceId = workspaceIdForUser(userId);
  const project = database
    .prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?")
    .get(payload.project_id, workspaceId);
  if (!project) return { error: "Project not found in the authenticated workspace." };

  const reviewUrl = new URL(`/review?project_id=${encodeURIComponent(project.id)}`, publicUrl).href;
  const duplicate = existingSubmission(
    database,
    clientId,
    project.id,
    payload.idempotency_key,
    reviewUrl,
  );
  if (duplicate) return duplicate;

  const exactPayloadJson = JSON.stringify(payload);
  const payloadHash = createHash("sha256").update(exactPayloadJson).digest("hex");
  const evidenceId = `evidence_${randomUUID()}`;
  const candidateIds = payload.candidate_claims.map(() => `candidate_${randomUUID()}`);
  const correlationId = `capture_${randomUUID()}`;
  const createdAt = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO evidence_events
          (id, workspace_id, project_id, exact_payload_json, actor_type, client_id,
           client_classification, tool_name, idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidenceId,
        workspaceId,
        project.id,
        exactPayloadJson,
        "mcp_host",
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

    database
      .prepare(
        `INSERT INTO audit_events
          (id, workspace_id, project_id, action, actor_type, actor_id,
           correlation_id, safe_metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `audit_${randomUUID()}`,
        workspaceId,
        project.id,
        "candidate_update_submitted",
        "mcp_host",
        clientId,
        correlationId,
        JSON.stringify({ evidence_id: evidenceId, candidate_count: candidateIds.length }),
        createdAt,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    const racedDuplicate = existingSubmission(
      database,
      clientId,
      project.id,
      payload.idempotency_key,
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
