import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { contextScopeForUser, tenantScopeForUser } from "./authorization.ts";

export async function listIntegrationConnections(database, userId) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return [];
  const connections = await database
    .prepare(
      `SELECT connection.id, connection.client_classification, connection.granted_scopes,
              connection.first_connected_at, connection.last_used_at, connection.revoked_at,
              client.client_name, target.project_id, target.context_id,
              target.selection_version AS target_version,
              project.name AS project_name, context.name AS context_name
       FROM integration_connections connection
       JOIN oauth_clients client ON client.client_id = connection.client_id
       LEFT JOIN active_connection_targets target ON target.connection_id = connection.id
       LEFT JOIN projects project
         ON project.workspace_id = target.project_workspace_id AND project.id = target.project_id
       LEFT JOIN work_contexts context
         ON context.workspace_id = target.project_workspace_id
        AND context.project_id = target.project_id AND context.id = target.context_id
       WHERE connection.user_id = ? AND connection.workspace_id = ?
       ORDER BY connection.revoked_at IS NOT NULL, connection.last_used_at DESC, connection.id`,
    )
    .all(tenant.userId, tenant.workspaceId);
  const visible: any[] = [];
  for (const connection of connections) {
    if (
      connection.project_id &&
      !(await contextScopeForUser(database, {
        userId,
        projectId: connection.project_id,
        contextId: connection.context_id,
      }))
    ) {
      visible.push({
        ...connection,
        project_id: null,
        context_id: null,
        target_version: null,
        project_name: null,
        context_name: null,
      });
    } else {
      visible.push(connection);
    }
  }
  return visible;
}

export async function revokeIntegrationConnection(database, { userId, connectionId }) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant || typeof connectionId !== "string" || !connectionId) return undefined;
  return database.transaction(async () => {
    const connection = await database
      .prepare(
        `SELECT id, client_classification, revoked_at
         FROM integration_connections
         WHERE id = ? AND user_id = ? AND workspace_id = ?
         FOR UPDATE`,
      )
      .get(connectionId, tenant.userId, tenant.workspaceId);
    if (!connection) return undefined;
    if (connection.revoked_at) {
      return { id: connection.id, revoked_at: connection.revoked_at, changed: false };
    }

    const revokedAt = new Date().toISOString();
    await database
      .prepare("UPDATE integration_connections SET revoked_at = ? WHERE id = ?")
      .run(revokedAt, connection.id);
    await database
      .prepare(
        "UPDATE oauth_access_tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL",
      )
      .run(revokedAt, connection.id);
    await database
      .prepare(
        "UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL",
      )
      .run(revokedAt, connection.id);
    await appendAuditEvent(database, {
      workspaceId: tenant.workspaceId,
      action: "integration_connection_revoked",
      actorType: "human_user",
      actorId: tenant.userId,
      correlationId: `connection_${randomUUID()}`,
      metadata: {
        connection_id: connection.id,
        client_classification: connection.client_classification,
      },
    });
    return { id: connection.id, revoked_at: revokedAt, changed: true };
  });
}
