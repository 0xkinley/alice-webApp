import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import {
  contextScopeForConnection,
  projectScopeForConnection,
  tenantScopeForConnection,
} from "./authorization.ts";

type EvidenceFileSource = {
  sourceContextId: string;
  fileReferenceId: string;
  fileObjectId: string;
  logicalFileId: string;
  fileVersion: number;
  contentSha256: string;
  extractionVersion: string;
  startCharacter: number;
  endCharacter: number;
  excerptSha256: string;
};

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
  publicUrl,
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
  const fileSources = await database
    .prepare(
      `SELECT evidence_id FROM evidence_file_sources
       WHERE workspace_id = ? AND project_id = ? AND evidence_id = ?`,
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
    targets.length !== 1 ||
    (evidence.tool_name === "suggest_project_updates_from_file" && fileSources.length !== 1) ||
    (evidence.tool_name !== "suggest_project_updates_from_file" && fileSources.length !== 0)
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
  const reviewUrl = new URL(`/review/captures/${encodeURIComponent(evidence.id)}`, publicUrl).href;
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
  {
    clientId,
    connectionId,
    publicUrl,
    userId,
    payload,
    toolName = "save_project_update",
    evidenceFileSource = undefined,
  }: {
    clientId: string;
    connectionId: string;
    publicUrl: string;
    userId: string;
    payload: any;
    toolName?: "save_project_update" | "suggest_project_updates_from_file";
    evidenceFileSource?: EvidenceFileSource;
  },
) {
  if (
    !["save_project_update", "suggest_project_updates_from_file"].includes(toolName) ||
    (toolName === "suggest_project_updates_from_file") !== Boolean(evidenceFileSource)
  ) {
    throw new Error("Candidate capture provenance configuration is invalid.");
  }
  const tenant = await tenantScopeForConnection(database, { userId, connectionId });
  if (!tenant || tenant.clientId !== clientId) {
    return { error: "Authenticated tenant context is missing." };
  }
  const activeTarget = await database
    .prepare(
      `SELECT project_workspace_id, project_id, context_id FROM active_connection_targets
       WHERE connection_id = ? AND user_id = ? AND workspace_id = ?`,
    )
    .get(connectionId, tenant.userId, tenant.workspaceId);
  if (
    activeTarget &&
    ((payload.project_id && payload.project_id !== activeTarget.project_id) ||
      (payload.context_id && payload.context_id !== activeTarget.context_id))
  ) {
    return { error: "The requested destination does not match this connection's active target." };
  }
  const projectId = activeTarget?.project_id || payload.project_id;
  if (!projectId) {
    return { error: "Select an active alice. project and work context before saving." };
  }
  const project = await projectScopeForConnection(database, {
    userId,
    connectionId,
    projectId,
    capability: "write",
  });
  if (!project || project.clientId !== clientId) {
    return { error: "Project not found in the authenticated workspace." };
  }

  const targetContextRow = await database
    .prepare(
      `SELECT id
       FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL
         AND ${activeTarget?.context_id || payload.context_id ? "id = ?" : "context_kind = 'project_wide'"}`,
    )
    .get(
      project.projectWorkspaceId,
      project.projectId,
      ...(activeTarget?.context_id || payload.context_id
        ? [activeTarget?.context_id || payload.context_id]
        : []),
    );
  if (!targetContextRow) return { error: "Context not found in the authenticated project." };
  const targetContext = await contextScopeForConnection(database, {
    userId,
    connectionId,
    projectId: project.projectId,
    contextId: targetContextRow.id,
    capability: "write",
  });
  if (!targetContext) return { error: "Context not found in the authenticated project." };

  const evidenceFileSourceIsValid = async () => {
    if (!evidenceFileSource) return true;
    const exactSource = await database
      .prepare(
        `SELECT reference.id, reference.context_id, context.context_kind,
                reference.file_object_id, reference.logical_file_id, reference.version,
                object.content_sha256
         FROM file_context_references reference
         JOIN file_objects object
           ON object.workspace_id = reference.workspace_id
          AND object.id = reference.file_object_id
         JOIN work_contexts context
           ON context.workspace_id = reference.workspace_id
          AND context.project_id = reference.project_id
          AND context.id = reference.context_id
         WHERE reference.workspace_id = ? AND reference.project_id = ?
           AND reference.context_id = ? AND reference.id = ? AND reference.file_object_id = ?
           AND reference.logical_file_id = ? AND reference.version = ?
           AND object.content_sha256 = ? AND object.verified_media_type = 'application/pdf'
           AND object.scan_status = 'clean' AND object.storage_version_id IS NOT NULL
           AND context.archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM file_reference_exclusions exclusion
             JOIN file_context_references grouped
               ON grouped.workspace_id = exclusion.workspace_id
              AND grouped.project_id = exclusion.project_id
              AND grouped.context_id = exclusion.context_id
              AND grouped.id = exclusion.file_reference_id
             WHERE grouped.workspace_id = reference.workspace_id
               AND grouped.project_id = reference.project_id
               AND grouped.context_id = reference.context_id
               AND grouped.logical_file_id = reference.logical_file_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM file_context_references newer
             JOIN file_objects newer_object
               ON newer_object.workspace_id = newer.workspace_id
              AND newer_object.id = newer.file_object_id
             WHERE newer.workspace_id = reference.workspace_id
               AND newer.project_id = reference.project_id
               AND newer.context_id = reference.context_id
               AND newer.logical_file_id = reference.logical_file_id
               AND newer.version > reference.version
               AND newer_object.scan_status = 'clean'
           )`,
      )
      .get(
        project.projectWorkspaceId,
        project.projectId,
        evidenceFileSource.sourceContextId,
        evidenceFileSource.fileReferenceId,
        evidenceFileSource.fileObjectId,
        evidenceFileSource.logicalFileId,
        evidenceFileSource.fileVersion,
        evidenceFileSource.contentSha256,
      );
    const payloadSource = payload.file_source;
    return !(
      !exactSource ||
      (exactSource.context_kind !== "project_wide" &&
        exactSource.context_id !== targetContext.contextId) ||
      !payloadSource ||
      payloadSource.file_reference_id !== evidenceFileSource.fileReferenceId ||
      payloadSource.logical_file_id !== evidenceFileSource.logicalFileId ||
      payloadSource.file_version !== evidenceFileSource.fileVersion ||
      payloadSource.content_sha256 !== evidenceFileSource.contentSha256 ||
      payloadSource.source_context_id !== evidenceFileSource.sourceContextId ||
      payloadSource.extraction_version !== evidenceFileSource.extractionVersion ||
      payloadSource.start_character !== evidenceFileSource.startCharacter ||
      payloadSource.end_character !== evidenceFileSource.endCharacter ||
      payloadSource.excerpt_sha256 !== evidenceFileSource.excerptSha256 ||
      payloadSource.parser !== "pdfjs-dist@6.2.108" ||
      payloadSource.method !== "embedded_text_only"
    );
  };

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
        .get(`${connectionId}:${project.projectId}:${payload.idempotency_key}`);
      if (evidenceFileSource) {
        await database
          .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
          .get(`${project.projectWorkspaceId}:logical-file:${evidenceFileSource.logicalFileId}`);
        if (!(await evidenceFileSourceIsValid())) {
          return { error: "The exact PDF evidence provenance is invalid or no longer current." };
        }
      }
      const duplicate = await existingSubmission(
        database,
        project.projectWorkspaceId,
        connectionId,
        project.projectId,
        payload.idempotency_key,
        payloadHash,
        publicUrl,
      );
      if (duplicate) {
        return duplicate;
      }

      await database
        .prepare(
          `INSERT INTO evidence_events
          (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
           connection_workspace_id, client_id, client_classification, tool_name,
           idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidenceId,
          project.projectWorkspaceId,
          project.projectId,
          exactPayloadJson,
          "mcp_host",
          connectionId,
          project.userWorkspaceId,
          clientId,
          await clientClassification(database, clientId),
          toolName,
          payload.idempotency_key,
          payloadHash,
          createdAt,
        );

      if (evidenceFileSource) {
        await database
          .prepare(
            `INSERT INTO evidence_file_sources
              (evidence_id, workspace_id, project_id, source_context_id, file_reference_id,
               file_object_id, logical_file_id, file_version, content_sha256,
               extraction_version, extraction_start_character, extraction_end_character,
               excerpt_sha256, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evidenceId,
            project.projectWorkspaceId,
            project.projectId,
            evidenceFileSource.sourceContextId,
            evidenceFileSource.fileReferenceId,
            evidenceFileSource.fileObjectId,
            evidenceFileSource.logicalFileId,
            evidenceFileSource.fileVersion,
            evidenceFileSource.contentSha256,
            evidenceFileSource.extractionVersion,
            evidenceFileSource.startCharacter,
            evidenceFileSource.endCharacter,
            evidenceFileSource.excerptSha256,
            createdAt,
          );
      }

      const insertCandidate = database.prepare(
        `INSERT INTO candidate_claims
        (id, workspace_id, project_id, evidence_id, state_key, value_json, summary, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      );
      for (const [index, claim] of payload.candidate_claims.entries()) {
        await insertCandidate.run(
          candidateIds[index],
          project.projectWorkspaceId,
          project.projectId,
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
          .run(
            candidateIds[index],
            project.projectWorkspaceId,
            project.projectId,
            targetContext.contextId,
            createdAt,
          );
      }

      await appendAuditEvent(database, {
        workspaceId: project.projectWorkspaceId,
        projectId: project.projectId,
        action: "candidate_update_submitted",
        actorType: "mcp_host",
        actorId: clientId,
        correlationId,
        metadata: {
          evidence_id: evidenceId,
          candidate_ids: candidateIds,
          candidate_count: candidateIds.length,
          context_id: targetContext.contextId,
          connection_id: connectionId,
          payload_hash: payloadHash,
        },
      });
      const result = await existingSubmission(
        database,
        project.projectWorkspaceId,
        connectionId,
        project.projectId,
        payload.idempotency_key,
        payloadHash,
        publicUrl,
      );
      if (!result || result.error) throw new Error("Capture receipt was not created atomically.");
      return { ...result, deduplicated: false };
    },
    { isolation: "READ COMMITTED" },
  );
}
