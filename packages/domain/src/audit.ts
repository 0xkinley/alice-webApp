import { randomUUID } from "node:crypto";

type AuditEvent = {
  workspaceId: string;
  projectId?: string | null;
  action: string;
  actorType: string;
  actorId: string;
  correlationId: string;
  metadata?: unknown;
};

export async function appendAuditEvent(database, event: AuditEvent) {
  const {
    workspaceId,
    projectId = null,
    action,
    actorType,
    actorId,
    correlationId,
    metadata = {},
  } = event;
  const id = `audit_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO audit_events
        (id, workspace_id, project_id, action, actor_type, actor_id,
         correlation_id, safe_metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      projectId,
      action,
      actorType,
      actorId,
      correlationId,
      JSON.stringify(metadata),
      createdAt,
    );
  return { id, created_at: createdAt };
}
