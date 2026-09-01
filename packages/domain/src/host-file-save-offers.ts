import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { activeTargetForConnection } from "./active-targets.ts";
import { contextScopeForConnection, contextScopeForUser } from "./authorization.ts";
import { sanitizeProjectFileDisplayName } from "./project-files.ts";

export const HOST_FILE_SAVE_OFFER_LIFETIME_MS = 30 * 60 * 1_000;

export type HostFileSaveDecision = "save_file_only" | "save_and_suggest_context" | "cancelled";

export class HostFileSaveOfferUserError extends Error {}

function canonicalRequest(input) {
  return JSON.stringify({
    file_name: input.fileName,
    declared_media_type: input.declaredMediaType || null,
    declared_byte_size: input.declaredByteSize || null,
    declared_sha256: input.declaredSha256 || null,
    conversation_reference: input.conversationReference || null,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(left) &&
    /^[0-9a-f]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function decisionVersion(offer): string {
  return sha256(
    JSON.stringify({
      offer_id: offer.id,
      workspace_id: offer.workspace_id,
      project_id: offer.project_id,
      context_id: offer.context_id,
      user_id: offer.user_id,
      connection_workspace_id: offer.connection_workspace_id,
      connection_id: offer.connection_id,
      target_selection_version: offer.target_selection_version,
      display_name: offer.display_name,
      declared_media_type: offer.declared_media_type,
      declared_byte_size: offer.declared_byte_size,
      declared_sha256: offer.declared_sha256,
      source_host: offer.source_host,
      conversation_reference: offer.conversation_reference,
      created_at: offer.created_at,
      expires_at: Number(offer.expires_at),
    }),
  );
}

function safeOfferResult(offer, publicUrl: string) {
  return {
    offer_id: offer.id,
    status: offer.decision || "pending",
    file: {
      name: offer.display_name,
      declared_media_type: offer.declared_media_type,
      declared_byte_size:
        offer.declared_byte_size === null ? null : Number(offer.declared_byte_size),
      declared_sha256: offer.declared_sha256,
    },
    destination: {
      project_id: offer.project_id,
      project_name: offer.project_name,
      context_id: offer.context_id,
      context_name: offer.context_name,
      access: offer.visibility,
    },
    source_host: offer.source_host,
    conversation_reference: offer.conversation_reference,
    confirmation_url: new URL(`/file-save-offers/${encodeURIComponent(offer.id)}`, publicUrl).href,
    expires_at: new Date(Number(offer.expires_at)).toISOString(),
    bytes_received: false,
    trusted_state_changed: false,
  };
}

async function offerForConnectionRetry(database, input) {
  return await database
    .prepare(
      `SELECT offer.*, project.name AS project_name, context.name AS context_name,
              context.visibility, decision.decision
       FROM host_file_save_offers offer
       JOIN projects project
         ON project.workspace_id = offer.workspace_id AND project.id = offer.project_id
       JOIN work_contexts context
         ON context.workspace_id = offer.workspace_id
        AND context.project_id = offer.project_id AND context.id = offer.context_id
       LEFT JOIN host_file_save_decisions decision ON decision.offer_id = offer.id
       WHERE offer.user_id = ? AND offer.connection_id = ? AND offer.idempotency_key = ?`,
    )
    .get(input.userId, input.connectionId, input.idempotencyKey);
}

export async function createHostFileSaveOffer(
  database,
  input: {
    userId: string;
    connectionId: string;
    publicUrl: string;
    payload: {
      file_name: string;
      declared_media_type?: string | undefined;
      declared_byte_size?: number | undefined;
      declared_sha256?: string | undefined;
      conversation_reference?: string | undefined;
      idempotency_key: string;
    };
  },
) {
  const fileName = sanitizeProjectFileDisplayName(input.payload.file_name);
  const request = {
    fileName,
    declaredMediaType: input.payload.declared_media_type || null,
    declaredByteSize: input.payload.declared_byte_size || null,
    declaredSha256: input.payload.declared_sha256 || null,
    conversationReference: input.payload.conversation_reference || null,
  };
  const requestHash = sha256(canonicalRequest(request));
  const created = await database.transaction(async () => {
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`host-file-save-offer:${input.connectionId}:${input.payload.idempotency_key}`);
    const existing = await offerForConnectionRetry(database, {
      userId: input.userId,
      connectionId: input.connectionId,
      idempotencyKey: input.payload.idempotency_key,
    });
    if (existing) {
      if (!equalHash(existing.request_hash, requestHash)) {
        throw new HostFileSaveOfferUserError(
          "This idempotency key was already used for a different file save offer.",
        );
      }
      return existing;
    }
    const target = await activeTargetForConnection(database, input);
    if (!target) {
      return {
        error: `Select an active alice. project/work context at ${new URL("/connections", input.publicUrl).href}`,
      };
    }
    if (!["chatgpt", "claude"].includes(target.surface)) {
      return {
        error: "Host attachment save offers are not enabled for this unverified MCP surface.",
      };
    }
    const access = await contextScopeForConnection(database, {
      userId: input.userId,
      connectionId: input.connectionId,
      projectId: target.project_id,
      contextId: target.context_id,
      capability: "write",
    });
    if (!access) return { error: "The active alice. target is not writable." };

    const offerId = `file_save_offer_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const expiresAt = Date.now() + HOST_FILE_SAVE_OFFER_LIFETIME_MS;
    await database
      .prepare(
        `INSERT INTO host_file_save_offers
          (id, workspace_id, project_id, context_id, user_id,
           connection_workspace_id, connection_id,
           idempotency_key, request_hash, target_selection_version, display_name,
           declared_media_type, declared_byte_size, declared_sha256, source_host,
           conversation_reference, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        offerId,
        access.projectWorkspaceId,
        target.project_id,
        target.context_id,
        input.userId,
        access.userWorkspaceId,
        input.connectionId,
        input.payload.idempotency_key,
        requestHash,
        target.selection_version,
        fileName,
        request.declaredMediaType,
        request.declaredByteSize,
        request.declaredSha256,
        target.surface,
        request.conversationReference,
        createdAt,
        expiresAt,
      );
    await appendAuditEvent(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: target.project_id,
      action: "host_file_save_offered",
      actorType: "ai_tool",
      actorId: input.connectionId,
      correlationId: offerId,
      metadata: {
        offer_id: offerId,
        context_id: target.context_id,
        source_host: target.surface,
        has_declared_hash: Boolean(request.declaredSha256),
        has_conversation_reference: Boolean(request.conversationReference),
      },
    });
    return await offerForConnectionRetry(database, {
      userId: input.userId,
      connectionId: input.connectionId,
      idempotencyKey: input.payload.idempotency_key,
    });
  });
  if (created && "error" in created) return created;
  return safeOfferResult(created, input.publicUrl);
}

async function offerForUser(database, userId: string, offerId: string) {
  const offer = await database
    .prepare(
      `SELECT offer.*, project.name AS project_name, context.name AS context_name,
              context.visibility, decision.decision, decision.decided_at
       FROM host_file_save_offers offer
       JOIN projects project
         ON project.workspace_id = offer.workspace_id AND project.id = offer.project_id
       JOIN work_contexts context
         ON context.workspace_id = offer.workspace_id
        AND context.project_id = offer.project_id AND context.id = offer.context_id
       LEFT JOIN host_file_save_decisions decision ON decision.offer_id = offer.id
       WHERE offer.id = ? AND offer.user_id = ?`,
    )
    .get(offerId, userId);
  if (!offer) return undefined;
  const access = await contextScopeForUser(database, {
    userId,
    projectId: offer.project_id,
    contextId: offer.context_id,
    capability: "write",
  });
  if (!access) return undefined;
  const active = await activeTargetForConnection(database, {
    userId,
    connectionId: offer.connection_id,
  });
  return {
    ...offer,
    target_is_current:
      active?.project_id === offer.project_id &&
      active?.context_id === offer.context_id &&
      active?.selection_version === offer.target_selection_version,
  };
}

export async function getHostFileSaveOfferPreview(database, input) {
  const offer = await offerForUser(database, input.userId, input.offerId);
  if (!offer) return undefined;
  return {
    ...safeOfferResult(offer, input.publicUrl),
    created_at: offer.created_at,
    decision_at: offer.decided_at || null,
    decision_version: decisionVersion(offer),
    expired: !offer.decision && Number(offer.expires_at) <= Date.now(),
    target_is_current: offer.target_is_current,
  };
}

export async function decideHostFileSaveOffer(
  database,
  input: {
    userId: string;
    offerId: string;
    previewVersion: string;
    decision: HostFileSaveDecision;
    publicUrl: string;
  },
) {
  if (!["save_file_only", "save_and_suggest_context", "cancelled"].includes(input.decision)) {
    throw new HostFileSaveOfferUserError("Choose one of the exact file save actions shown.");
  }
  return await database.transaction(async () => {
    await database
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`host-file-save-decision:${input.offerId}`);
    const offer = await offerForUser(database, input.userId, input.offerId);
    if (!offer) return undefined;
    if (offer.decision) {
      throw new HostFileSaveOfferUserError("This file save offer was already decided.");
    }
    if (Number(offer.expires_at) <= Date.now()) {
      throw new HostFileSaveOfferUserError(
        "This file save offer expired. Ask the host for a new offer.",
      );
    }
    if (!offer.target_is_current) {
      throw new HostFileSaveOfferUserError(
        "The active project or context changed. Review a new exact file save offer.",
      );
    }
    const exactVersion = decisionVersion(offer);
    if (!equalHash(exactVersion, String(input.previewVersion || ""))) {
      throw new HostFileSaveOfferUserError(
        "The file save preview changed. Reload it before making a decision.",
      );
    }
    const decidedAt = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO host_file_save_decisions
          (offer_id, workspace_id, project_id, context_id, decided_by_user_id,
           decision, decision_version, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        offer.id,
        offer.workspace_id,
        offer.project_id,
        offer.context_id,
        input.userId,
        input.decision,
        exactVersion,
        decidedAt,
      );
    await appendAuditEvent(database, {
      workspaceId: offer.workspace_id,
      projectId: offer.project_id,
      action:
        input.decision === "cancelled"
          ? "host_file_save_cancelled"
          : "host_file_save_transfer_authorized",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: offer.id,
      metadata: {
        offer_id: offer.id,
        context_id: offer.context_id,
        decision: input.decision,
        bytes_received: false,
      },
    });
    return {
      ...(await getHostFileSaveOfferPreview(database, input)),
      status: input.decision,
      decision_at: decidedAt,
    };
  });
}
