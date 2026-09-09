import {
  contextScopeForConnection,
  projectScopeForConnection,
  type ContextCapability,
} from "./authorization.ts";

/**
 * Resolve the internal destination used for project-level MCP operations.
 *
 * Work-context records remain an implementation detail during the private
 * alpha. Newer projects use their General work record; older projects fall
 * back to another accessible work record and finally the project-wide record.
 * The returned context is always re-authorized for the authenticated user and
 * connection, so this compatibility layer never broadens project membership or
 * legacy context access.
 */
export async function projectDestinationForConnection(
  database,
  input: {
    userId: string;
    connectionId: string;
    projectId: string;
    capability?: ContextCapability;
  },
) {
  const project = await projectScopeForConnection(database, {
    ...input,
    capability: input.capability === "read" || !input.capability ? "read" : "write",
  });
  if (!project) return undefined;

  const contexts = await database
    .prepare(
      `SELECT id, name, description, context_kind, visibility, created_at, updated_at
       FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL
       ORDER BY
         CASE
           WHEN context_kind = 'work' AND lower(name) = 'general' THEN 0
           WHEN context_kind = 'work' THEN 1
           ELSE 2
         END,
         created_at,
         id`,
    )
    .all(project.projectWorkspaceId, project.projectId);

  for (const context of contexts) {
    const access = await contextScopeForConnection(database, {
      ...input,
      contextId: context.id,
    });
    if (!access) continue;
    const projectRow = await database
      .prepare("SELECT name FROM projects WHERE workspace_id = ? AND id = ?")
      .get(project.projectWorkspaceId, project.projectId);
    if (!projectRow) return undefined;
    return Object.freeze({
      ...access,
      projectName: projectRow.name,
      contextName: context.name,
      contextDescription: context.description,
      createdAt: context.created_at,
      updatedAt: context.updated_at,
      routingVersion: "project_explicit_v1",
    });
  }
  return undefined;
}
