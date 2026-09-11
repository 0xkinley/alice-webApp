import { projectScopeForConnection } from "./authorization.ts";

export type SaveConfirmationKind = "artifact" | "project_information";

export async function recordSaveConfirmationReceipt(
  database,
  input: {
    previewId: string;
    workspaceId: string;
    projectId: string;
    userId: string;
    connectionWorkspaceId: string;
    connectionId: string;
    clientId: string;
    saveKind: SaveConfirmationKind;
    receipt: Record<string, unknown>;
    savedAt: string;
  },
) {
  const receipt = {
    ...input.receipt,
    contract_version: "alice_save_confirmation_receipt_v1",
    status: "saved",
    preview_id: input.previewId,
    save_kind: input.saveKind,
    destination: { project_id: input.projectId },
    saved_at: input.savedAt,
  };
  await database
    .prepare(
      `INSERT INTO save_confirmation_receipts
        (id, workspace_id, project_id, user_id, connection_workspace_id,
         connection_id, client_id, save_kind, receipt_json, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.previewId,
      input.workspaceId,
      input.projectId,
      input.userId,
      input.connectionWorkspaceId,
      input.connectionId,
      input.clientId,
      input.saveKind,
      JSON.stringify(receipt),
      input.savedAt,
    );
  return receipt;
}

export async function getSaveConfirmationReceipt(
  database,
  input: {
    previewId: string;
    userId: string;
    connectionId: string;
    publicUrl?: string;
  },
) {
  const row = await database
    .prepare(
      `SELECT receipt.*, project.name AS project_name
       FROM save_confirmation_receipts receipt
       JOIN projects project
         ON project.workspace_id = receipt.workspace_id
        AND project.id = receipt.project_id
       WHERE receipt.id = ? AND receipt.user_id = ?`,
    )
    .get(input.previewId, input.userId);
  if (!row || row.connection_id !== input.connectionId) return undefined;
  const access = await projectScopeForConnection(database, {
    userId: input.userId,
    connectionId: row.connection_id,
    projectId: row.project_id,
    capability: "read",
  });
  if (!access || access.clientId !== row.client_id) return undefined;
  const receipt = JSON.parse(row.receipt_json);
  const viewPath =
    receipt.save_kind === "artifact" && receipt.artifact_id
      ? `/projects/${encodeURIComponent(row.project_id)}/artifacts/${encodeURIComponent(receipt.artifact_id)}`
      : `/projects/${encodeURIComponent(row.project_id)}/changes`;
  return {
    ...receipt,
    destination: { project_id: row.project_id, project_name: row.project_name },
    ...(input.publicUrl ? { view_url: new URL(viewPath, input.publicUrl).href } : {}),
  };
}

export async function getLatestSaveCheckpoint(
  database,
  input: { workspaceId: string; projectId: string; connectionId: string },
) {
  const row = await database
    .prepare(
      `SELECT saved_at, save_kind, label
       FROM (
         SELECT revision.saved_at AS saved_at, 'artifact' AS save_kind,
                revision.title AS label
         FROM artifact_versions revision
         WHERE revision.workspace_id = ? AND revision.project_id = ?
           AND revision.source_connection_id = ?
         UNION ALL
         SELECT accepted.accepted_at AS saved_at, 'project_information' AS save_kind,
                candidate.summary AS label
         FROM accepted_project_state accepted
         JOIN candidate_claims candidate
           ON candidate.workspace_id = accepted.workspace_id
          AND candidate.project_id = accepted.project_id
          AND candidate.id = accepted.candidate_id
         JOIN evidence_events evidence
           ON evidence.workspace_id = accepted.workspace_id
          AND evidence.project_id = accepted.project_id
          AND evidence.id = accepted.evidence_id
         WHERE accepted.workspace_id = ? AND accepted.project_id = ?
           AND evidence.connection_id = ?
       ) saved
       ORDER BY saved_at DESC, label
       LIMIT 1`,
    )
    .get(
      input.workspaceId,
      input.projectId,
      input.connectionId,
      input.workspaceId,
      input.projectId,
      input.connectionId,
    );
  return row || undefined;
}
