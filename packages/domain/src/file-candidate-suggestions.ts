import { createHash } from "node:crypto";
import {
  captureValidationLimits,
  pdfExtractionVersion,
  suggestProjectUpdatesFromFileSchema,
} from "@alice/schemas";
import { tenantScopeForConnection } from "./authorization.ts";
import { saveCandidateUpdate } from "./candidate-updates.ts";
import { getProjectPdfExtractionForSuggestion, type PrivateFileStore } from "./project-files.ts";

const FILE_SUGGESTION_NOTE =
  "Suggested from an exact alice. PDF embedded-text extraction. The file and excerpt remain untrusted evidence until exact human confirmation.";

export async function suggestProjectUpdatesFromFile(
  database,
  store: PrivateFileStore,
  { clientId, connectionId, publicUrl, userId, payload },
) {
  const parsed = suggestProjectUpdatesFromFileSchema.safeParse(payload);
  if (!parsed.success) return { error: "The file suggestion request is invalid." };
  const request = parsed.data;
  const tenant = await tenantScopeForConnection(database, { userId, connectionId });
  if (!tenant || tenant.clientId !== clientId) {
    return { error: "Authenticated tenant context is missing." };
  }
  if (!request.project_id) return { error: "An exact alice. project is required." };
  const extracted = await getProjectPdfExtractionForSuggestion(database, store, {
    userId,
    connectionId,
    projectId: request.project_id,
    referenceId: request.file_reference_id,
  });
  if (!extracted) {
    return { error: "The current clean PDF is not available for an authorized file suggestion." };
  }
  const { extraction, reference } = extracted;
  const { start_character: start, end_character: end } = request.extraction;
  if (end > extraction.characters.length) {
    return { error: "The extraction receipt is beyond the exact current PDF extraction." };
  }
  const excerpt = extraction.characters.slice(start, end).join("");
  const excerptHash = createHash("sha256").update(excerpt).digest("hex");
  if (!excerpt.trim() || excerptHash !== request.extraction.excerpt_sha256) {
    return { error: "The extraction receipt does not match the exact current PDF extraction." };
  }
  const fileSource = {
    file_reference_id: reference.id,
    logical_file_id: reference.logical_file_id,
    file_version: Number(reference.version),
    content_sha256: reference.content_sha256,
    display_name: reference.display_name,
    media_type: "application/pdf",
    source_context_id: reference.context_id,
    extraction_version: pdfExtractionVersion,
    parser: "pdfjs-dist@6.2.108",
    method: "embedded_text_only",
    start_character: start,
    end_character: end,
    excerpt_sha256: excerptHash,
    total_pages: extraction.totalPages,
  };
  const capturePayload = {
    project_id: request.project_id,
    context_id: reference.context_id,
    summary: request.summary,
    candidate_claims: request.candidate_claims,
    source_note: FILE_SUGGESTION_NOTE,
    source_context: excerpt,
    idempotency_key: request.idempotency_key,
    file_source: fileSource,
  };
  if (
    Buffer.byteLength(JSON.stringify(capturePayload), "utf8") > captureValidationLimits.payloadBytes
  ) {
    return {
      error: `The exact file-backed capture exceeds ${captureValidationLimits.payloadBytes} UTF-8 bytes.`,
    };
  }

  return saveCandidateUpdate(database, {
    clientId,
    connectionId,
    publicUrl,
    userId,
    payload: capturePayload,
    toolName: "suggest_project_updates_from_file",
    evidenceFileSource: {
      sourceContextId: reference.context_id,
      fileReferenceId: reference.id,
      fileObjectId: reference.file_object_id,
      logicalFileId: reference.logical_file_id,
      fileVersion: Number(reference.version),
      contentSha256: reference.content_sha256,
      extractionVersion: pdfExtractionVersion,
      startCharacter: start,
      endCharacter: end,
      excerptSha256: excerptHash,
    },
  });
}
