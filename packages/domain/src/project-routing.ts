import {
  contextScopeForConnection,
  contextScopeForUser,
  projectScopeForConnection,
  projectScopeForUser,
  type ContextCapability,
} from "./authorization.ts";
import { listProjects } from "./project-context.ts";

export type ProjectReferenceResolution =
  | Readonly<{
      status: "ok";
      projectId: string;
      projectName: string;
    }>
  | Readonly<{
      status: "project_required";
      projectNames: string[];
    }>
  | Readonly<{
      status: "project_ambiguous" | "project_conflict" | "project_unavailable";
      projectNames: readonly string[];
    }>;

/** Resolve an exact project name or legacy identifier only within this connection's access. */
export async function resolveProjectReferenceForConnection(
  database,
  input: {
    userId: string;
    connectionId: string;
    projectReference?: string;
    projectName?: string;
    capability?: ContextCapability;
  },
): Promise<ProjectReferenceResolution> {
  const catalog = await listProjects(database, input.userId);
  const accessible: any[] = [];
  for (const project of catalog) {
    const access = await projectScopeForConnection(database, {
      userId: input.userId,
      connectionId: input.connectionId,
      projectId: project.id,
      capability: input.capability === "read" || !input.capability ? "read" : "write",
    });
    if (access) accessible.push(project);
  }

  const references = [input.projectReference, input.projectName].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (references.length === 0) {
    if (accessible.length === 1) {
      return Object.freeze({
        status: "ok",
        projectId: accessible[0].id,
        projectName: accessible[0].name,
      });
    }
    return Object.freeze({
      status: "project_required",
      projectNames: accessible.map(({ name }) => name),
    });
  }

  const resolveOne = (reference: string) =>
    accessible.filter(({ id, name }) => id === reference || name === reference);
  const firstReference = references[0];
  if (!firstReference) {
    return Object.freeze({ status: "project_unavailable", projectNames: [] });
  }
  const first = resolveOne(firstReference);
  if (first.length === 0) {
    return Object.freeze({ status: "project_unavailable", projectNames: [] });
  }
  if (first.length > 1) {
    return Object.freeze({ status: "project_ambiguous", projectNames: [] });
  }
  if (references.length === 2) {
    const secondReference = references[1];
    if (!secondReference) {
      return Object.freeze({ status: "project_unavailable", projectNames: [] });
    }
    const second = resolveOne(secondReference);
    if (second.length !== 1) {
      return Object.freeze({
        status: second.length > 1 ? "project_ambiguous" : "project_unavailable",
        projectNames: [],
      });
    }
    if (second[0].id !== first[0].id) {
      return Object.freeze({ status: "project_conflict", projectNames: [] });
    }
  }
  return Object.freeze({
    status: "ok",
    projectId: first[0].id,
    projectName: first[0].name,
  });
}

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
