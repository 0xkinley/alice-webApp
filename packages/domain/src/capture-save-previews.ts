import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { contextScopeForConnection, tenantScopeForConnection } from "./authorization.ts";
import { saveCandidateUpdate } from "./candidate-updates.ts";
import { projectDestinationForConnection } from "./project-routing.ts";
import {
  getLatestSaveCheckpoint,
  recordSaveConfirmationReceipt,
} from "./save-confirmation-receipts.ts";
import { confirmCapturedUpdate, getCapturePreview } from "./trusted-state.ts";

export const CAPTURE_SAVE_PREVIEW_LIFETIME_MS = 30 * 60 * 1_000;

export class CaptureSavePreviewUserError extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalSecretHash(expected: string, token: string): boolean {
  const actual = sha256(token);
  return (
    /^[0-9a-f]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
  );
}

async function replacementSnapshot(database, workspaceId, projectId, contextId, claims) {
  const replacements: any[] = [];
  for (const claim of claims) {
    const current = await database
      .prepare(
        `SELECT accepted.id, accepted.version, accepted.value_json, accepted.accepted_at,
                exclusion.removed_at
         FROM accepted_project_state accepted
         JOIN accepted_context_entries entry
           ON entry.workspace_id = accepted.workspace_id
          AND entry.project_id = accepted.project_id
          AND entry.accepted_state_id = accepted.id
         LEFT JOIN context_entry_exclusions exclusion
           ON exclusion.workspace_id = accepted.workspace_id
          AND exclusion.project_id = accepted.project_id
          AND exclusion.accepted_state_id = accepted.id
         WHERE accepted.workspace_id = ? AND accepted.project_id = ?
           AND accepted.state_key = ? AND entry.context_id = ?
         ORDER BY accepted.version DESC LIMIT 1`,
      )
      .get(workspaceId, projectId, claim.state_key, contextId);
    replacements.push({
      state_key: claim.state_key,
      accepted_state_id: current?.id || null,
      version: current ? Number(current.version) : null,
      value_json: current?.value_json || null,
      removed_at: current?.removed_at || null,
    });
  }
  return replacements;
}

function safePreview(row) {
  const preview = JSON.parse(row.exact_preview_json);
  return {
    ...preview,
    expired: Number(row.expires_at) <= Date.now(),
  };
}

export async function createCaptureSavePreview(
  database,
  input: {
    userId: string;
    connectionId: string;
    clientId: string;
    publicUrl: string;
    payload: any;
    now?: Date;
  },
) {
  const connection = await tenantScopeForConnection(database, input);
  if (!connection || connection.clientId !== input.clientId || !connection.provider) {
    return { error: "Authenticated tenant context is missing." };
  }
  const target = await projectDestinationForConnection(database, {
    ...input,
    projectId: input.payload.project_id,
    capability: "write",
  });
  if (!target) return { error: "The save destination is unavailable." };
  const access = await contextScopeForConnection(database, {
    ...input,
    projectId: target.projectId,
    contextId: target.contextId,
    capability: "write",
  });
  if (!access || access.clientId !== input.clientId) {
    return { error: "The save destination is unavailable." };
  }

  const exactPayload = {
    ...input.payload,
    project_id: target.projectId,
    context_id: target.contextId,
  };
  const exactPayloadJson = JSON.stringify(exactPayload);
  const payloadHash = sha256(exactPayloadJson);
  const replacements = await replacementSnapshot(
    database,
    access.projectWorkspaceId,
    target.projectId,
    target.contextId,
    exactPayload.candidate_claims,
  );
  const lastSaved = await getLatestSaveCheckpoint(database, {
    workspaceId: access.projectWorkspaceId,
    projectId: target.projectId,
    connectionId: input.connectionId,
  });
  const previewId = `capture_save_preview_${randomUUID()}`;
  const authorityToken = `alice_save_${randomBytes(32).toString("base64url")}`;
  const now = input.now || new Date();
  const createdAt = now.toISOString();
  const expiresAt = now.getTime() + CAPTURE_SAVE_PREVIEW_LIFETIME_MS;
  const previewBase = {
    contract_version: "alice_save_card_v1",
    card_type: "context_capture",
    preview_id: previewId,
    destination: {
      project_id: target.projectId,
      project_name: target.projectName,
    },
    payload: {
      summary: exactPayload.summary,
      candidate_claims: exactPayload.candidate_claims.map((claim, index) => ({
        ...claim,
        current_saved:
          replacements[index].value_json === null
            ? null
            : {
                accepted_state_id: replacements[index].accepted_state_id,
                version: replacements[index].version,
                value: JSON.parse(replacements[index].value_json),
                removed_at: replacements[index].removed_at,
              },
      })),
      source_note: exactPayload.source_note || null,
      source_context: exactPayload.source_context || null,
    },
    source_host: connection.provider,
    created_at: createdAt,
    expires_at: new Date(expiresAt).toISOString(),
    status: "awaiting_save",
    pre_save_state: "preview_only",
    trusted_state_changed: false,
    last_saved: lastSaved || null,
    fallback_url: new URL(`/save-previews/${encodeURIComponent(previewId)}`, input.publicUrl).href,
  };
  const previewVersion = sha256(JSON.stringify(previewBase));
  const preview = { ...previewBase, preview_version: previewVersion };
  await database
    .prepare("DELETE FROM capture_save_previews WHERE expires_at <= ?")
    .run(now.getTime());
  await database
    .prepare(
      `INSERT INTO capture_save_previews
        (id, workspace_id, project_id, context_id, user_id,
         connection_workspace_id, connection_id, client_id, client_classification,
         exact_payload_json, payload_hash, replacement_snapshot_json, exact_preview_json,
         preview_version, authority_token_hash, target_selection_version, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      previewId,
      access.projectWorkspaceId,
      target.projectId,
      target.contextId,
      input.userId,
      access.userWorkspaceId,
      input.connectionId,
      input.clientId,
      connection.provider,
      exactPayloadJson,
      payloadHash,
      JSON.stringify(replacements),
      JSON.stringify(preview),
      previewVersion,
      sha256(authorityToken),
      target.routingVersion,
      createdAt,
      expiresAt,
    );
  return { preview, authorityToken };
}

async function previewRow(database, previewId: string, userId: string) {
  return database
    .prepare(
      `SELECT * FROM capture_save_previews
       WHERE id = ? AND user_id = ?`,
    )
    .get(previewId, userId);
}

export async function getCaptureSavePreview(
  database,
  input: { previewId: string; userId: string; now?: Date },
) {
  const row = await previewRow(database, input.previewId, input.userId);
  if (!row) return undefined;
  const access = await contextScopeForConnection(database, {
    userId: input.userId,
    connectionId: row.connection_id,
    projectId: row.project_id,
    contextId: row.context_id,
    capability: "write",
  });
  if (!access) return undefined;
  return {
    ...safePreview(row),
    expired: Number(row.expires_at) <= (input.now || new Date()).getTime(),
  };
}

async function acceptedReceipt(database, capture, deduplicated: boolean) {
  const accepted = await database
    .prepare(
      `SELECT accepted.id AS accepted_state_id, accepted.version,
              accepted.state_key, accepted.accepted_at
       FROM accepted_project_state accepted
       WHERE accepted.workspace_id = ? AND accepted.project_id = ?
         AND accepted.candidate_id IN (${capture.candidate_ids.map(() => "?").join(", ")})
       ORDER BY accepted.state_key, accepted.version`,
    )
    .all(capture.workspace_id, capture.project_id, ...capture.candidate_ids);
  return {
    status: "saved",
    project_id: capture.project_id,
    evidence_id: capture.evidence_id,
    accepted,
    saved_at: accepted[0]?.accepted_at || null,
    deduplicated,
    trusted_state_changed: true,
  };
}

async function persistCaptureReceipt(database, row, receipt, payload) {
  return await recordSaveConfirmationReceipt(database, {
    previewId: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    userId: row.user_id,
    connectionWorkspaceId: row.connection_workspace_id,
    connectionId: row.connection_id,
    clientId: row.client_id,
    saveKind: "project_information",
    savedAt: receipt.saved_at,
    receipt: {
      evidence_id: receipt.evidence_id,
      accepted: receipt.accepted,
      deduplicated: receipt.deduplicated,
      selected_count: payload.candidate_claims.length,
      selected_items: payload.candidate_claims.map((claim) => ({
        state_key: claim.state_key,
        summary: claim.summary,
      })),
      trusted_state_changed: true,
    },
  });
}

export async function commitCaptureSavePreview(
  database,
  input: {
    previewId: string;
    previewVersion: string;
    userId: string;
    authority: "mcp_app" | "web_session";
    authorityToken?: string;
    selectedClaimIndices?: number[];
    publicUrl: string;
    now?: Date;
  },
) {
  const result = await database.transaction(
    async () => {
      await database
        .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`capture-save-preview:${input.previewId}`);
      const row = await previewRow(database, input.previewId, input.userId);
      if (!row) return undefined;
      if (Number(row.expires_at) <= (input.now || new Date()).getTime()) {
        await database.prepare("DELETE FROM capture_save_previews WHERE id = ?").run(row.id);
        return { previewExpired: true as const };
      }
      if (
        input.previewVersion !== row.preview_version ||
        (input.authority === "mcp_app" &&
          (!input.authorityToken ||
            !equalSecretHash(row.authority_token_hash, input.authorityToken)))
      ) {
        throw new CaptureSavePreviewUserError(
          "The exact Save authority is unavailable or the preview changed.",
        );
      }
      const access = await contextScopeForConnection(database, {
        userId: input.userId,
        connectionId: row.connection_id,
        projectId: row.project_id,
        contextId: row.context_id,
        capability: "write",
      });
      if (!access || access.clientId !== row.client_id) {
        throw new CaptureSavePreviewUserError(
          "The project access changed. Review a new exact Save card.",
        );
      }
      const completePayload = JSON.parse(row.exact_payload_json);
      const selectedClaimIndices =
        input.selectedClaimIndices || completePayload.candidate_claims.map((_, index) => index);
      if (
        selectedClaimIndices.length === 0 ||
        new Set(selectedClaimIndices).size !== selectedClaimIndices.length ||
        selectedClaimIndices.some(
          (index) => !Number.isInteger(index) || !completePayload.candidate_claims[index],
        )
      ) {
        throw new CaptureSavePreviewUserError(
          "The selected project items no longer match this exact Save card.",
        );
      }
      const isPartial = selectedClaimIndices.length !== completePayload.candidate_claims.length;
      const payload = {
        ...completePayload,
        summary: isPartial
          ? `${selectedClaimIndices.length} selected project ${selectedClaimIndices.length === 1 ? "item" : "items"}`
          : completePayload.summary,
        candidate_claims: selectedClaimIndices.map(
          (index) => completePayload.candidate_claims[index],
        ),
        ...(isPartial ? { source_note: undefined, source_context: undefined } : {}),
      };
      if (isPartial) {
        delete payload.source_note;
        delete payload.source_context;
      }
      const currentReplacements = await replacementSnapshot(
        database,
        row.workspace_id,
        row.project_id,
        row.context_id,
        payload.candidate_claims,
      );
      const expectedReplacements = JSON.parse(row.replacement_snapshot_json).filter((_, index) =>
        selectedClaimIndices.includes(index),
      );
      if (JSON.stringify(currentReplacements) !== JSON.stringify(expectedReplacements)) {
        throw new CaptureSavePreviewUserError(
          "Saved context changed after this preview. Review a new exact Save card.",
        );
      }

      const captured: any = await saveCandidateUpdate(database, {
        clientId: row.client_id,
        connectionId: row.connection_id,
        publicUrl: input.publicUrl,
        userId: input.userId,
        payload,
      });
      if (!captured || captured.error) {
        throw new CaptureSavePreviewUserError(
          captured?.error || "The exact Save could not be prepared.",
        );
      }
      const receiptInput = {
        ...captured,
        workspace_id: row.workspace_id,
        project_id: row.project_id,
        context_id: row.context_id,
      };
      const statuses = captured.candidate_statuses.map(({ status }) => status);
      if (statuses.every((status) => status === "accepted")) {
        const accepted = await acceptedReceipt(database, receiptInput, true);
        const receipt = await persistCaptureReceipt(database, row, accepted, payload);
        await database.prepare("DELETE FROM capture_save_previews WHERE id = ?").run(row.id);
        return { ...accepted, ...receipt };
      }
      if (!statuses.every((status) => status === "pending")) {
        throw new CaptureSavePreviewUserError(
          "This exact save request was already reviewed with a different outcome.",
        );
      }
      const candidatePreview = await getCapturePreview(database, {
        evidenceId: captured.evidence_id,
        userId: input.userId,
      });
      if (!candidatePreview) {
        throw new Error("The candidate preview was not created atomically.");
      }
      const confirmed: any = await confirmCapturedUpdate(database, {
        evidenceId: captured.evidence_id,
        expectedPreviewVersion: candidatePreview.preview_version,
        userId: input.userId,
      });
      if (!confirmed || confirmed.conflict) {
        throw new CaptureSavePreviewUserError(
          "Saved context changed before confirmation. Review a new exact Save card.",
        );
      }
      const accepted = await acceptedReceipt(
        database,
        receiptInput,
        Boolean(captured.deduplicated),
      );
      const receipt = await persistCaptureReceipt(database, row, accepted, payload);
      await database.prepare("DELETE FROM capture_save_previews WHERE id = ?").run(row.id);
      return { ...accepted, ...receipt };
    },
    { isolation: "READ COMMITTED" },
  );
  if (result?.previewExpired) {
    throw new CaptureSavePreviewUserError(
      "This Save card expired. Ask the host for a new exact preview.",
    );
  }
  return result;
}
