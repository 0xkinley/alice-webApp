import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import {
  contextScopeForConnection,
  contextScopeForUser,
  tenantScopeForConnection,
  tenantScopeForUser,
} from "./authorization.ts";
import { listWorkContexts } from "./work-contexts.ts";

export async function listSelectableProjectContexts(database, userId) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return [];
  const projects = await database
    .prepare(
      `SELECT project.id, project.name,
              project.created_at, project.updated_at
       FROM projects project
       JOIN project_memberships membership
         ON membership.workspace_id = project.workspace_id
        AND membership.project_id = project.id
       WHERE membership.user_id = ? AND membership.ended_at IS NULL
         AND project.archived_at IS NULL
       ORDER BY project.name, project.id`,
    )
    .all(tenant.userId);
  const selectable: any[] = [];
  for (const project of projects) {
    const contexts = ((await listWorkContexts(database, userId, project.id)) || [])
      .filter(({ context_kind: kind }) => kind === "work")
      .map((context) => ({
        id: context.id,
        name: context.name,
        description: context.description,
        visibility: context.visibility,
        created_at: context.created_at,
        updated_at: context.updated_at,
      }));
    selectable.push({ ...project, contexts });
  }
  return selectable;
}

export async function listSelectableProjectContextsForConnection(
  database,
  { userId, connectionId },
) {
  const projects = await listSelectableProjectContexts(database, userId);
  const selectable: any[] = [];
  for (const project of projects) {
    const contexts: any[] = [];
    for (const context of project.contexts) {
      const access = await contextScopeForConnection(database, {
        userId,
        connectionId,
        projectId: project.id,
        contextId: context.id,
      });
      if (access) contexts.push(context);
    }
    if (contexts.length > 0) selectable.push({ ...project, contexts });
  }
  return selectable;
}

export async function activeTargetForConnection(database, { userId, connectionId }) {
  const connection = await tenantScopeForConnection(database, { userId, connectionId });
  if (!connection) return undefined;
  const target = await database
    .prepare(
      `SELECT target.connection_id, target.surface, target.selection_version,
              target.selected_at, target.updated_at,
              project.id AS project_id, project.name AS project_name,
              context.id AS context_id, context.name AS context_name,
              context.description AS context_description, context.visibility
       FROM active_connection_targets target
       JOIN projects project
         ON project.workspace_id = target.project_workspace_id AND project.id = target.project_id
       JOIN work_contexts context
         ON context.workspace_id = target.project_workspace_id
        AND context.project_id = target.project_id
        AND context.id = target.context_id
        AND context.context_kind = 'work'
        AND context.archived_at IS NULL
       WHERE target.connection_id = ? AND target.user_id = ? AND target.workspace_id = ?`,
    )
    .get(connection.connectionId, connection.userId, connection.workspaceId);
  if (
    !target ||
    !(await contextScopeForConnection(database, {
      userId,
      connectionId,
      projectId: target.project_id,
      contextId: target.context_id,
    }))
  ) {
    return undefined;
  }
  return target;
}

function expectedVersion(expectedVersions, connectionId) {
  if (
    !expectedVersions ||
    typeof expectedVersions !== "object" ||
    !Object.hasOwn(expectedVersions, connectionId)
  ) {
    return undefined;
  }
  const value = expectedVersions[connectionId];
  return value === null ? null : String(value);
}

export async function setActiveConnectionTarget(
  database,
  { userId, connectionId, projectId, contextId, applyToAll = false, expectedVersions },
) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;

  return database.transaction(
    async () => {
      const connections = applyToAll
        ? await database
            .prepare(
              `SELECT id, client_classification
               FROM integration_connections
               WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL
               ORDER BY id FOR UPDATE`,
            )
            .all(tenant.userId, tenant.workspaceId)
        : await database
            .prepare(
              `SELECT id, client_classification
               FROM integration_connections
               WHERE id = ? AND user_id = ? AND workspace_id = ? AND revoked_at IS NULL
               FOR UPDATE`,
            )
            .all(connectionId, tenant.userId, tenant.workspaceId);
      if (!connections.some(({ id }) => id === connectionId)) return undefined;
      const context = await contextScopeForUser(database, { userId, projectId, contextId });
      if (!context || context.contextKind !== "work") return undefined;
      for (const connection of connections) {
        if (
          !(await contextScopeForConnection(database, {
            userId,
            connectionId: connection.id,
            projectId,
            contextId,
          }))
        ) {
          return undefined;
        }
      }
      const current = await database
        .prepare(
          `SELECT connection_id, selection_version FROM active_connection_targets
           WHERE user_id = ? AND workspace_id = ?`,
        )
        .all(tenant.userId, tenant.workspaceId);
      const currentByConnection = new Map(
        current.map((target) => [target.connection_id, target.selection_version]),
      );
      for (const connection of connections) {
        const expected = expectedVersion(expectedVersions, connection.id);
        const actual = currentByConnection.get(connection.id) || null;
        if (expected === undefined || expected !== actual) {
          return { conflict: true, connection_id: connection.id };
        }
      }

      const changedAt = new Date().toISOString();
      const selectionVersion = `target_version_${randomUUID()}`;
      for (const connection of connections) {
        await database
          .prepare(
            `INSERT INTO active_connection_targets
              (connection_id, user_id, workspace_id, project_workspace_id,
               project_id, context_id, surface,
               selection_version, selected_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (connection_id) DO UPDATE SET
               project_workspace_id = excluded.project_workspace_id,
               project_id = excluded.project_id,
               context_id = excluded.context_id,
               surface = excluded.surface,
               selection_version = excluded.selection_version,
               updated_at = excluded.updated_at`,
          )
          .run(
            connection.id,
            tenant.userId,
            tenant.workspaceId,
            context.projectWorkspaceId,
            projectId,
            contextId,
            connection.client_classification,
            selectionVersion,
            changedAt,
            changedAt,
          );
        await database
          .prepare(
            `INSERT INTO context_history_events
              (id, workspace_id, project_id, context_id, action, actor_user_id,
               safe_metadata_json, created_at)
             VALUES (?, ?, ?, ?, 'active_target_selected', ?, ?, ?)`,
          )
          .run(
            `context_event_${randomUUID()}`,
            context.projectWorkspaceId,
            projectId,
            contextId,
            tenant.userId,
            JSON.stringify({
              connection_id: connection.id,
              surface: connection.client_classification,
            }),
            changedAt,
          );
      }
      await appendAuditEvent(database, {
        workspaceId: context.projectWorkspaceId,
        projectId,
        action: "active_context_target_selected",
        actorType: "human_user",
        actorId: tenant.userId,
        correlationId: `target_${randomUUID()}`,
        metadata: {
          connection_ids: connections.map(({ id }) => id),
          context_id: contextId,
          apply_to_all: Boolean(applyToAll),
        },
      });
      return {
        conflict: false,
        connection_ids: connections.map(({ id }) => id),
        project_id: projectId,
        context_id: contextId,
        selection_version: selectionVersion,
        updated_at: changedAt,
      };
    },
    { isolation: "READ COMMITTED" },
  );
}
