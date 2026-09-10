import {
  contextScopeForConnection,
  contextScopeForUser,
  projectScopeForConnection,
  projectScopeForUser,
  type ContextCapability,
} from "./authorization.ts";

async function mappedDefault(database, workspaceId: string, projectId: string) {
  return await database
    .prepare(
      `SELECT context.id, context.name, context.description, context.context_kind,
              context.visibility, context.created_at, context.updated_at
       FROM project_default_contexts mapping
       JOIN work_contexts context
         ON context.workspace_id = mapping.workspace_id
        AND context.project_id = mapping.project_id
        AND context.id = mapping.context_id
       WHERE mapping.workspace_id = ? AND mapping.project_id = ?
         AND context.archived_at IS NULL`,
    )
    .get(workspaceId, projectId);
}

function routedContext(project, context, access) {
  return Object.freeze({
    ...access,
    projectName: project.name,
    contextName: context.name,
    contextDescription: context.description,
    createdAt: context.created_at,
    updatedAt: context.updated_at,
    routingVersion: "project_default_v1",
  });
}

/** Resolve the immutable hidden destination for project-level human actions. */
export async function projectDefaultContextForUser(
  database,
  input: {
    userId: string;
    projectId: string;
    capability?: ContextCapability;
  },
) {
  const project = await projectScopeForUser(database, {
    ...input,
    capability: input.capability === "read" || !input.capability ? "read" : "write",
  });
  if (!project) return undefined;
  const context = await mappedDefault(database, project.projectWorkspaceId, project.projectId);
  if (!context) return undefined;
  const access = await contextScopeForUser(database, { ...input, contextId: context.id });
  if (!access) return undefined;
  const projectRow = await database
    .prepare("SELECT name FROM projects WHERE workspace_id = ? AND id = ?")
    .get(project.projectWorkspaceId, project.projectId);
  if (!projectRow) return undefined;
  return routedContext(projectRow, context, access);
}

/** Resolve the same hidden destination after reauthorizing the exact MCP connection. */
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
  const context = await mappedDefault(database, project.projectWorkspaceId, project.projectId);
  if (!context) return undefined;
  const access = await contextScopeForConnection(database, { ...input, contextId: context.id });
  if (!access) return undefined;
  const projectRow = await database
    .prepare("SELECT name FROM projects WHERE workspace_id = ? AND id = ?")
    .get(project.projectWorkspaceId, project.projectId);
  if (!projectRow) return undefined;
  return routedContext(projectRow, context, access);
}
