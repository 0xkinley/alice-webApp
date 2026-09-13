import { randomUUID } from "node:crypto";
import {
  contextScopeForUser,
  projectScopeForUser,
  tenantScopeForConnection,
  tenantScopeForUser,
} from "./authorization.ts";

export type ContextReadRequestMode = "active_target" | "explicit_fallback";
export type ContextReadFailureCode =
  "no_active_target" | "not_accessible" | "budget_error" | "internal_error";

async function connectionMetadata(database, userId: string, connectionId: string) {
  const connection = await tenantScopeForConnection(database, { userId, connectionId });
  if (!connection) return undefined;
  const metadata = await database
    .prepare(
      `SELECT connection.client_id, client.client_name, connection.client_classification
       FROM integration_connections connection
       JOIN oauth_clients client ON client.client_id = connection.client_id
       WHERE connection.id = ? AND connection.user_id = ?
         AND connection.workspace_id = ? AND connection.revoked_at IS NULL`,
    )
    .get(connection.connectionId, connection.userId, connection.workspaceId);
  return metadata ? { ...connection, ...metadata } : undefined;
}

export async function recordContextReadSuccess(
  database,
  input: {
    userId: string;
    connectionId: string;
    projectId: string;
    contextId: string;
    requestedVia: ContextReadRequestMode;
    packageVersion: string;
    packageUtf8Bytes: number;
  },
) {
  const connection = await connectionMetadata(database, input.userId, input.connectionId);
  const context = await contextScopeForUser(database, {
    userId: input.userId,
    projectId: input.projectId,
    contextId: input.contextId,
  });
  if (!connection || !context) return undefined;
  const event = {
    id: `context_read_${randomUUID()}`,
    created_at: new Date().toISOString(),
  };
  await database
    .prepare(
      `INSERT INTO context_read_events
        (id, user_id, connection_workspace_id, connection_id, client_id, client_name,
         client_classification, requested_via, status, project_workspace_id,
         project_id, context_id, package_version, package_utf8_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      connection.userId,
      connection.workspaceId,
      connection.connectionId,
      connection.client_id,
      connection.client_name,
      connection.client_classification,
      input.requestedVia,
      context.projectWorkspaceId,
      input.projectId,
      input.contextId,
      input.packageVersion,
      input.packageUtf8Bytes,
      event.created_at,
    );
  return event;
}

export async function recordContextReadFailure(
  database,
  input: {
    userId: string;
    connectionId: string;
    requestedVia: ContextReadRequestMode;
    failureCode: ContextReadFailureCode;
    projectId?: string;
    contextId?: string;
  },
) {
  const connection = await connectionMetadata(database, input.userId, input.connectionId);
  if (!connection) return undefined;
  const context =
    input.projectId && input.contextId
      ? await contextScopeForUser(database, {
          userId: input.userId,
          projectId: input.projectId,
          contextId: input.contextId,
        })
      : undefined;
  const event = {
    id: `context_read_${randomUUID()}`,
    created_at: new Date().toISOString(),
  };
  await database
    .prepare(
      `INSERT INTO context_read_events
        (id, user_id, connection_workspace_id, connection_id, client_id, client_name,
         client_classification, requested_via, status, failure_code,
         project_workspace_id, project_id, context_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      connection.userId,
      connection.workspaceId,
      connection.connectionId,
      connection.client_id,
      connection.client_name,
      connection.client_classification,
      input.requestedVia,
      input.failureCode,
      context?.projectWorkspaceId || null,
      context?.projectId || null,
      context?.contextId || null,
      event.created_at,
    );
  return event;
}

export async function listContextReadEvents(
  database,
  input: { userId: string; projectId?: string; limit?: number },
) {
  const tenant = await tenantScopeForUser(database, input.userId);
  if (!tenant) return [];
  let projectAccess;
  if (input.projectId) {
    projectAccess = await projectScopeForUser(database, {
      userId: input.userId,
      projectId: input.projectId,
    });
    if (!projectAccess) return [];
  }
  const limit = Math.min(100, Math.max(1, Number(input.limit || 25)));
  const projectFilter = input.projectId
    ? "AND event.project_workspace_id = ? AND event.project_id = ?"
    : "";
  const parameters: unknown[] = [tenant.userId, tenant.workspaceId];
  if (input.projectId) {
    parameters.push(projectAccess.projectWorkspaceId, input.projectId);
  }
  parameters.push(limit * 3);
  const rows = await database
    .prepare(
      `SELECT event.id, event.connection_id, event.client_id, event.client_name,
              event.client_classification, event.requested_via, event.status,
              event.failure_code, event.project_id, event.context_id,
              event.package_version, event.package_utf8_bytes, event.created_at,
              project.name AS project_name, context.name AS context_name
       FROM context_read_events event
       LEFT JOIN projects project
         ON project.workspace_id = event.project_workspace_id
        AND project.id = event.project_id
       LEFT JOIN work_contexts context
         ON context.workspace_id = event.project_workspace_id
        AND context.project_id = event.project_id
        AND context.id = event.context_id
       WHERE event.user_id = ? AND event.connection_workspace_id = ?
         ${projectFilter}
       ORDER BY event.created_at DESC, event.id DESC
       LIMIT ?`,
    )
    .all(...parameters);
  const visible: any[] = [];
  for (const row of rows) {
    if (
      row.project_id &&
      !(await contextScopeForUser(database, {
        userId: input.userId,
        projectId: row.project_id,
        contextId: row.context_id,
      }))
    ) {
      continue;
    }
    visible.push(row);
    if (visible.length === limit) break;
  }
  return visible;
}
