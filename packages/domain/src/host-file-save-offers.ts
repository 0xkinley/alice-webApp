import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { contextScopeForConnection, contextScopeForUser } from "./authorization.ts";
import { projectDestinationForConnection } from "./project-routing.ts";
import {
  FILE_UPLOAD_INTENT_LIFETIME_MS,
  FILE_UPLOAD_URL_LIFETIME_SECONDS,
  finalizeProjectFileUpload,
  refreshProjectFileScan,
  sanitizeProjectFileDisplayName,
  validateProjectFileUploadDeclaration,
} from "./project-files.ts";
import type { PrivateFileStore } from "./project-files.ts";

export const HOST_FILE_SAVE_OFFER_LIFETIME_MS = 30 * 60 * 1_000;

export type HostFileSaveDecision = "save_file_only" | "cancelled";
export type HostFileTransferPath = "host_capability" | "browser_fallback";

export class HostFileSaveOfferUserError extends Error {}

function canonicalRequest(input) {
  return JSON.stringify({
    project_id: input.projectId,
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
    },
    source_host: offer.source_host,
    conversation_reference: offer.conversation_reference,
    confirmation_url: new URL(`/file-save-offers/${encodeURIComponent(offer.id)}`, publicUrl).href,
    expires_at: new Date(Number(offer.expires_at)).toISOString(),
    preview_version: decisionVersion(offer),
    bytes_received: false,
    trusted_state_changed: false,
  };
}

async function createAppAuthority(database, offer) {
  const token = `alice_file_save_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO host_file_save_offer_authorities
        (id, offer_id, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `file_save_authority_${randomUUID()}`,
      offer.id,
      sha256(token),
      createdAt,
      Number(offer.expires_at),
    );
  return token;
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
      project_id: string;
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
    projectId: input.payload.project_id,
    fileName,
    declaredMediaType: input.payload.declared_media_type || null,
    declaredByteSize: input.payload.declared_byte_size || null,
    declaredSha256: input.payload.declared_sha256 || null,
    conversationReference: input.payload.conversation_reference || null,
  };
  const requestHash = sha256(canonicalRequest(request));
  const created = await database.transaction(async () => {
    await database
      .prepare("DELETE FROM host_file_save_offer_authorities WHERE expires_at <= ?")
      .run(Date.now());
    await database
      .prepare(
        `DELETE FROM host_file_save_offers
         WHERE expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM host_file_save_decisions decision
             WHERE decision.offer_id = host_file_save_offers.id
           )`,
      )
      .run(Date.now());
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
    const target = await projectDestinationForConnection(database, {
      ...input,
      projectId: input.payload.project_id,
      capability: "write",
    });
    if (!target) {
      return { error: "The requested alice. project is not writable." };
    }
    if (!["chatgpt", "claude"].includes(target.provider)) {
      return {
        error: "Host attachment save offers are not enabled for this unverified MCP surface.",
      };
    }
    const access = await contextScopeForConnection(database, {
      userId: input.userId,
      connectionId: input.connectionId,
      projectId: target.projectId,
      contextId: target.contextId,
      capability: "write",
    });
    if (!access) return { error: "The requested alice. project is not writable." };

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
        target.projectId,
        target.contextId,
        input.userId,
        access.userWorkspaceId,
        input.connectionId,
        input.payload.idempotency_key,
        requestHash,
        target.routingVersion,
        fileName,
        request.declaredMediaType,
        request.declaredByteSize,
        request.declaredSha256,
        target.provider,
        request.conversationReference,
        createdAt,
        expiresAt,
      );
    return await offerForConnectionRetry(database, {
      userId: input.userId,
      connectionId: input.connectionId,
      idempotencyKey: input.payload.idempotency_key,
    });
  });
  if (created && "error" in created) return created;
  const authorityToken =
    !created.decision && Number(created.expires_at) > Date.now()
      ? await createAppAuthority(database, created)
      : undefined;
  return { ...safeOfferResult(created, input.publicUrl), authorityToken };
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
  return { ...offer, target_is_current: true };
}

export async function getHostFileSaveOfferPreview(database, input) {
  const offer = await offerForUser(database, input.userId, input.offerId);
  if (!offer) return undefined;
  const completion = await transferCompletion(database, input.offerId);
  return {
    ...safeOfferResult(offer, input.publicUrl),
    created_at: offer.created_at,
    decision_at: offer.decided_at || null,
    decision_version: decisionVersion(offer),
    expired: !offer.decision && Number(offer.expires_at) <= Date.now(),
    transfer_authority_expired: Number(offer.expires_at) <= Date.now(),
    target_is_current: offer.target_is_current,
    transfer: completion ? safeTransferReceipt(completion) : null,
  };
}

export async function decideHostFileSaveOffer(
  database,
  input: {
    userId: string;
    offerId: string;
    previewVersion: string;
    decision: HostFileSaveDecision;
    authority: "mcp_app" | "web_session";
    authorityToken?: string;
    publicUrl: string;
  },
) {
  if (input.decision !== "save_file_only") {
    throw new HostFileSaveOfferUserError("The only available decision is Save.");
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
    const exactVersion = decisionVersion(offer);
    if (!equalHash(exactVersion, String(input.previewVersion || ""))) {
      throw new HostFileSaveOfferUserError(
        "The file save preview changed. Reload it before making a decision.",
      );
    }
    if (input.authority === "mcp_app") {
      const tokenHash = sha256(String(input.authorityToken || ""));
      const authority = await database
        .prepare(
          `SELECT id FROM host_file_save_offer_authorities
           WHERE offer_id = ? AND token_hash = ? AND expires_at > ?`,
        )
        .get(offer.id, tokenHash, Date.now());
      if (!authority) {
        throw new HostFileSaveOfferUserError(
          "The authenticated Save authority is unavailable or expired.",
        );
      }
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
      action: "host_file_save_transfer_authorized",
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
    await database
      .prepare("DELETE FROM host_file_save_offer_authorities WHERE offer_id = ?")
      .run(offer.id);
    return {
      ...(await getHostFileSaveOfferPreview(database, input)),
      status: input.decision,
      decision_at: decidedAt,
    };
  });
}

function transferRequestHash(file): string {
  return sha256(
    JSON.stringify({
      file_name: file.displayName,
      media_type: file.mediaType,
      byte_size: file.byteSize,
      sha256: file.sha256,
    }),
  );
}

async function confirmedOfferForTransfer(
  database,
  input: {
    userId: string;
    offerId: string;
    connectionId?: string;
    startedIntentId?: string;
    transferPath?: HostFileTransferPath;
  },
) {
  const offer = await offerForUser(database, input.userId, input.offerId);
  if (!offer || (input.connectionId && offer.connection_id !== input.connectionId))
    return undefined;
  if (!offer.decision || offer.decision === "cancelled") {
    throw new HostFileSaveOfferUserError(
      "This attachment does not have an authenticated alice. transfer confirmation.",
    );
  }
  const started = input.startedIntentId
    ? await database
        .prepare(
          `SELECT intent_id FROM host_file_save_transfer_intents
           WHERE offer_id = ? AND intent_id = ? AND transfer_path = ?
             AND initiated_by_user_id = ?`,
        )
        .get(input.offerId, input.startedIntentId, input.transferPath, input.userId)
    : undefined;
  if (Number(offer.expires_at) <= Date.now() && !started) {
    throw new HostFileSaveOfferUserError(
      "This attachment transfer authority expired. Ask the host for a new exact offer.",
    );
  }
  return offer;
}

async function transferCompletion(database, offerId: string) {
  return await database
    .prepare(
      `SELECT completion.offer_id, completion.intent_id, completion.workspace_id,
              completion.project_id, completion.context_id, completion.file_reference_id,
              completion.completed_at, availability.available_at,
              object.scan_status, offer.source_host, offer.conversation_reference,
              decision.decision
       FROM host_file_save_transfer_completions completion
       JOIN host_file_save_offers offer ON offer.id = completion.offer_id
       JOIN host_file_save_decisions decision ON decision.offer_id = completion.offer_id
       JOIN file_context_references reference
         ON reference.workspace_id = completion.workspace_id
        AND reference.project_id = completion.project_id
        AND reference.context_id = completion.context_id
        AND reference.id = completion.file_reference_id
       JOIN file_objects object
         ON object.workspace_id = reference.workspace_id AND object.id = reference.file_object_id
       LEFT JOIN host_file_save_transfer_availability availability
         ON availability.offer_id = completion.offer_id
       WHERE completion.offer_id = ?`,
    )
    .get(offerId);
}

function safeTransferReceipt(row) {
  const available = Boolean(row.available_at);
  return {
    status: available ? ("completed" as const) : ("pending" as const),
    stage: available ? ("available" as const) : ("final_security_scan" as const),
    offer_id: row.offer_id,
    intent_id: row.intent_id,
    project_id: row.project_id,
    context_id: row.context_id,
    file_reference_id: row.file_reference_id,
    source_host: row.source_host,
    conversation_provenance_preserved: Boolean(row.conversation_reference),
    suggestions_requested: row.decision === "save_and_suggest_context",
    scan_status: row.scan_status,
    received_at: row.completed_at,
    available_at: row.available_at || null,
    trusted_state_changed: false,
  };
}

async function refreshCompletedHostTransfer(
  database,
  store: PrivateFileStore,
  input: { userId: string; offerId: string },
) {
  let completion = await transferCompletion(database, input.offerId);
  if (!completion) return undefined;
  if (completion.available_at) return safeTransferReceipt(completion);
  const refreshed = await refreshProjectFileScan(database, store, {
    userId: input.userId,
    projectId: completion.project_id,
    referenceId: completion.file_reference_id,
  });
  if (!refreshed) return undefined;
  if (refreshed.scan_status !== "clean") {
    if (refreshed.scan_status === "scanning") return safeTransferReceipt(completion);
    throw new HostFileSaveOfferUserError(
      "The transferred file did not pass the final private-file security gate.",
    );
  }
  const availableAt = new Date().toISOString();
  await database.transaction(
    async () => {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`host-file-transfer-finalize:${input.offerId}`);
      const current = await transferCompletion(database, input.offerId);
      if (!current || current.available_at) return;
      await database
        .prepare(
          `INSERT INTO host_file_save_transfer_availability
            (offer_id, intent_id, workspace_id, project_id, context_id, file_reference_id,
             available_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.offer_id,
          current.intent_id,
          current.workspace_id,
          current.project_id,
          current.context_id,
          current.file_reference_id,
          availableAt,
        );
      await appendAuditEvent(database, {
        workspaceId: current.workspace_id,
        projectId: current.project_id,
        action: "host_file_save_completed",
        actorType: "human_user",
        actorId: input.userId,
        correlationId: current.offer_id,
        metadata: {
          offer_id: current.offer_id,
          context_id: current.context_id,
          file_reference_id: current.file_reference_id,
          source_host: current.source_host,
          conversation_provenance_preserved: Boolean(current.conversation_reference),
          suggestions_requested: current.decision === "save_and_suggest_context",
        },
      });
    },
    { isolation: "READ COMMITTED" },
  );
  completion = await transferCompletion(database, input.offerId);
  return safeTransferReceipt(completion);
}

export async function beginHostFileSaveTransfer(
  database,
  store: PrivateFileStore,
  input: {
    userId: string;
    connectionId?: string;
    offerId: string;
    transferPath: HostFileTransferPath;
    fileName: string;
    claimedMediaType?: string;
    byteSize: number;
    sha256: string;
    idempotencyKey: string;
  },
) {
  if (!store.createSignedUpload) {
    throw new HostFileSaveOfferUserError("Direct private file transfer is not available.");
  }
  const createSignedUpload = store.createSignedUpload.bind(store);
  if (!["host_capability", "browser_fallback"].includes(input.transferPath)) {
    throw new HostFileSaveOfferUserError("The attachment transfer path is invalid.");
  }
  if (input.transferPath === "host_capability" && !input.connectionId) {
    throw new HostFileSaveOfferUserError("The host transfer connection is unavailable.");
  }
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!/^[0-9A-Za-z._:-]{8,128}$/.test(idempotencyKey)) {
    throw new HostFileSaveOfferUserError("The transfer idempotency key is invalid.");
  }
  const file = validateProjectFileUploadDeclaration(input);
  const prepared = await database.transaction(
    async () => {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`host-file-transfer:${input.offerId}:${input.transferPath}:${idempotencyKey}`);
      const offer = await confirmedOfferForTransfer(database, input);
      if (!offer) return undefined;
      if (file.displayName !== offer.display_name) {
        throw new HostFileSaveOfferUserError(
          "The selected file name does not match the exact confirmed attachment.",
        );
      }
      if (offer.declared_media_type && file.mediaType !== offer.declared_media_type) {
        throw new HostFileSaveOfferUserError(
          "The file type does not match the exact confirmed attachment metadata.",
        );
      }
      if (offer.declared_byte_size !== null && Number(offer.declared_byte_size) !== file.byteSize) {
        throw new HostFileSaveOfferUserError(
          "The file size does not match the exact confirmed attachment metadata.",
        );
      }
      if (offer.declared_sha256 && !equalHash(offer.declared_sha256, file.sha256)) {
        throw new HostFileSaveOfferUserError(
          "The file hash does not match the exact confirmed attachment metadata.",
        );
      }
      const requestHash = transferRequestHash(file);
      const existing = await database
        .prepare(
          `SELECT transfer.intent_id, transfer.request_hash,
                  intent.staging_storage_key, intent.declared_byte_size,
                  intent.claimed_media_type, intent.declared_sha256, intent.expires_at
           FROM host_file_save_transfer_intents transfer
           JOIN file_upload_intents intent ON intent.id = transfer.intent_id
           WHERE transfer.offer_id = ? AND transfer.transfer_path = ?
             AND transfer.idempotency_key = ?`,
        )
        .get(input.offerId, input.transferPath, idempotencyKey);
      if (existing) {
        if (!equalHash(existing.request_hash, requestHash)) {
          throw new HostFileSaveOfferUserError(
            "This transfer idempotency key was already used for different file bytes.",
          );
        }
        return { existing: true, intent: existing, offer };
      }

      const intentId = `file_upload_${randomUUID()}`;
      const stagingKey = `staging/${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const expiresAt = Date.now() + FILE_UPLOAD_INTENT_LIFETIME_MS;
      await database
        .prepare(
          `INSERT INTO file_upload_intents
            (id, workspace_id, project_id, context_id, initiated_by_user_id, display_name,
             claimed_media_type, declared_byte_size, declared_sha256, staging_storage_key,
             replaces_reference_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          intentId,
          offer.workspace_id,
          offer.project_id,
          offer.context_id,
          input.userId,
          offer.display_name,
          file.mediaType,
          file.byteSize,
          file.sha256,
          stagingKey,
          expiresAt,
          createdAt,
        );
      await database
        .prepare(
          `INSERT INTO host_file_save_transfer_intents
            (intent_id, offer_id, workspace_id, project_id, context_id,
             initiated_by_user_id, decision, transfer_path, idempotency_key,
             request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intentId,
          offer.id,
          offer.workspace_id,
          offer.project_id,
          offer.context_id,
          input.userId,
          offer.decision,
          input.transferPath,
          idempotencyKey,
          requestHash,
          createdAt,
        );
      await appendAuditEvent(database, {
        workspaceId: offer.workspace_id,
        projectId: offer.project_id,
        action: "host_file_save_transfer_started",
        actorType: input.transferPath === "host_capability" ? "ai_tool" : "human_user",
        actorId: input.transferPath === "host_capability" ? input.connectionId! : input.userId,
        correlationId: offer.id,
        metadata: {
          offer_id: offer.id,
          context_id: offer.context_id,
          intent_id: intentId,
          transfer_path: input.transferPath,
          source_host: offer.source_host,
          conversation_provenance_preserved: Boolean(offer.conversation_reference),
        },
      });
      return {
        existing: false,
        offer,
        intent: {
          intent_id: intentId,
          staging_storage_key: stagingKey,
          declared_byte_size: file.byteSize,
          claimed_media_type: file.mediaType,
          declared_sha256: file.sha256,
          expires_at: expiresAt,
        },
      };
    },
    { isolation: "READ COMMITTED" },
  );
  if (!prepared) return undefined;
  if (prepared.existing) {
    const completed = await refreshCompletedHostTransfer(database, store, input);
    if (completed) return completed;
    if (Number(prepared.intent.expires_at) <= Date.now()) {
      throw new HostFileSaveOfferUserError(
        "This upload attempt expired. Start a new attempt with a new idempotency key.",
      );
    }
  }
  const signed = await createSignedUpload({
    key: prepared.intent.staging_storage_key,
    byteSize: Number(prepared.intent.declared_byte_size),
    mediaType: prepared.intent.claimed_media_type,
    sha256: prepared.intent.declared_sha256,
    expiresInSeconds: FILE_UPLOAD_URL_LIFETIME_SECONDS,
  });
  return {
    status: "ready" as const,
    offer_id: prepared.offer.id,
    intent_id: prepared.intent.intent_id,
    transfer_path: input.transferPath,
    upload_url: signed.url,
    upload_headers: signed.headers,
    upload_expires_in_seconds: signed.expiresInSeconds,
    intent_expires_at: new Date(Number(prepared.intent.expires_at)).toISOString(),
    file: {
      name: file.displayName,
      media_type: file.mediaType,
      byte_size: file.byteSize,
      sha256: file.sha256,
    },
  };
}

export async function finalizeHostFileSaveTransfer(
  database,
  store: PrivateFileStore,
  input: {
    userId: string;
    connectionId?: string;
    offerId: string;
    intentId: string;
    transferPath: HostFileTransferPath;
    storageVersionId: string;
  },
) {
  return await database.transaction(
    async () => {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`host-file-transfer-finalize:${input.offerId}`);
      const offer = await confirmedOfferForTransfer(database, {
        ...input,
        startedIntentId: input.intentId,
      });
      if (!offer) return undefined;
      const link = await database
        .prepare(
          `SELECT intent_id FROM host_file_save_transfer_intents
           WHERE offer_id = ? AND intent_id = ? AND transfer_path = ?
             AND initiated_by_user_id = ?`,
        )
        .get(input.offerId, input.intentId, input.transferPath, input.userId);
      if (!link) return undefined;
      const completed = await refreshCompletedHostTransfer(database, store, input);
      if (completed) return completed;
      const finalized = await finalizeProjectFileUpload(database, store, {
        userId: input.userId,
        projectId: offer.project_id,
        intentId: input.intentId,
        storageVersionId: input.storageVersionId,
        hostFileSaveOfferId: offer.id,
      });
      if (!finalized) return undefined;
      if (finalized.status === "pending") {
        return { status: "pending" as const, stage: "staging_security_scan" as const };
      }
      await database
        .prepare(
          `INSERT INTO host_file_save_transfer_completions
            (offer_id, intent_id, workspace_id, project_id, context_id,
             file_reference_id, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          offer.id,
          input.intentId,
          offer.workspace_id,
          offer.project_id,
          offer.context_id,
          finalized.file_reference_id,
          new Date().toISOString(),
        );
      await appendAuditEvent(database, {
        workspaceId: offer.workspace_id,
        projectId: offer.project_id,
        action: "host_file_save_received",
        actorType: input.transferPath === "host_capability" ? "ai_tool" : "human_user",
        actorId: input.transferPath === "host_capability" ? input.connectionId! : input.userId,
        correlationId: offer.id,
        metadata: {
          offer_id: offer.id,
          context_id: offer.context_id,
          intent_id: input.intentId,
          file_reference_id: finalized.file_reference_id,
          transfer_path: input.transferPath,
          source_host: offer.source_host,
          final_scan_status: finalized.scan_status,
        },
      });
      return await refreshCompletedHostTransfer(database, store, input);
    },
    { isolation: "READ COMMITTED" },
  );
}
