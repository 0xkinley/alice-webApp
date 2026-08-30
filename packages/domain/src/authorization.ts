export type TenantScope = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export type ConnectionScope = TenantScope &
  Readonly<{
    connectionId: string;
    clientId: string;
  }>;

export type ProjectRole = "owner" | "editor" | "viewer";
export type ContextRole = "manager" | "editor" | "viewer";
export type ProjectCapability = "read" | "write" | "manage";
export type ContextCapability = "read" | "write" | "manage";

export type ProjectScope = Readonly<{
  userId: string;
  userWorkspaceId: string;
  projectWorkspaceId: string;
  projectId: string;
  projectRole: ProjectRole;
  membershipId: string;
}>;

export type ProjectConnectionScope = ProjectScope &
  Readonly<{
    connectionId: string;
    clientId: string;
  }>;

export type ContextScope = ProjectScope &
  Readonly<{
    contextId: string;
    contextKind: "project_wide" | "work";
    visibility: "all_members" | "selected_members" | "personal";
    contextRole: ContextRole;
  }>;

function projectRoleAllows(role: ProjectRole, capability: ProjectCapability): boolean {
  if (capability === "read") return true;
  if (capability === "write") return role === "owner" || role === "editor";
  return role === "owner";
}

function contextRoleAllows(
  projectRole: ProjectRole,
  contextRole: ContextRole,
  capability: ContextCapability,
): boolean {
  if (capability === "read") return true;
  if (projectRole === "viewer") return false;
  if (capability === "write") return contextRole === "editor" || contextRole === "manager";
  return contextRole === "manager";
}

export async function tenantScopeForUser(database, userId): Promise<TenantScope | undefined> {
  if (typeof userId !== "string" || !userId) return undefined;
  const row = await database
    .prepare(
      `SELECT users.id AS user_id, workspaces.id AS workspace_id
       FROM users
       JOIN workspaces ON workspaces.user_id = users.id
       WHERE users.id = ?`,
    )
    .get(userId);
  if (!row) return undefined;
  return Object.freeze({ userId: row.user_id, workspaceId: row.workspace_id });
}

export async function tenantScopeForConnection(
  database,
  { userId, connectionId },
): Promise<ConnectionScope | undefined> {
  if (typeof connectionId !== "string" || !connectionId) return undefined;
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const row = await database
    .prepare(
      `SELECT id, client_id
       FROM integration_connections
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    )
    .get(connectionId, tenant.userId, tenant.workspaceId);
  if (!row) return undefined;
  return Object.freeze({
    ...tenant,
    connectionId: row.id,
    clientId: row.client_id,
  });
}

export async function projectScopeForUser(
  database,
  input: { userId: string; projectId: string; capability?: ProjectCapability },
): Promise<ProjectScope | undefined> {
  const tenant = await tenantScopeForUser(database, input.userId);
  if (!tenant || typeof input.projectId !== "string" || !input.projectId) return undefined;
  const row = await database
    .prepare(
      `SELECT membership.id AS membership_id, membership.role AS project_role,
              project.workspace_id AS project_workspace_id
       FROM project_memberships membership
       JOIN projects project
         ON project.workspace_id = membership.workspace_id
        AND project.id = membership.project_id
       WHERE membership.user_id = ? AND membership.project_id = ?
         AND membership.ended_at IS NULL`,
    )
    .get(tenant.userId, input.projectId);
  if (!row || !projectRoleAllows(row.project_role, input.capability || "read")) return undefined;
  return Object.freeze({
    userId: tenant.userId,
    userWorkspaceId: tenant.workspaceId,
    projectWorkspaceId: row.project_workspace_id,
    projectId: input.projectId,
    projectRole: row.project_role,
    membershipId: row.membership_id,
  });
}

export async function projectScopeForConnection(
  database,
  input: {
    userId: string;
    connectionId: string;
    projectId: string;
    capability?: ProjectCapability;
  },
): Promise<ProjectConnectionScope | undefined> {
  const connection = await tenantScopeForConnection(database, input);
  if (!connection) return undefined;
  const project = await projectScopeForUser(database, input);
  if (!project) return undefined;
  return Object.freeze({
    ...project,
    connectionId: connection.connectionId,
    clientId: connection.clientId,
  });
}

export async function contextScopeForUser(
  database,
  input: {
    userId: string;
    projectId: string;
    contextId: string;
    capability?: ContextCapability;
  },
): Promise<ContextScope | undefined> {
  const project = await projectScopeForUser(database, {
    ...input,
    capability: input.capability === "read" || !input.capability ? "read" : "write",
  });
  if (!project || typeof input.contextId !== "string" || !input.contextId) return undefined;
  const row = await database
    .prepare(
      `SELECT context.id, context.context_kind, context.visibility,
              context.created_by_user_id, context_grant.role AS granted_role
       FROM work_contexts context
       LEFT JOIN context_access_grants context_grant
         ON context_grant.workspace_id = context.workspace_id
        AND context_grant.project_id = context.project_id
        AND context_grant.context_id = context.id
        AND context_grant.user_id = ?
        AND context_grant.ended_at IS NULL
       WHERE context.workspace_id = ? AND context.project_id = ? AND context.id = ?
         AND context.archived_at IS NULL`,
    )
    .get(project.userId, project.projectWorkspaceId, project.projectId, input.contextId);
  if (!row) return undefined;

  let contextRole: ContextRole | undefined;
  if (row.context_kind === "project_wide" || row.visibility === "all_members") {
    contextRole =
      project.projectRole === "owner"
        ? "manager"
        : project.projectRole === "editor"
          ? "editor"
          : "viewer";
  } else if (row.visibility === "personal") {
    if (row.created_by_user_id === project.userId && project.projectRole !== "viewer") {
      contextRole = "manager";
    }
  } else if (row.created_by_user_id === project.userId && project.projectRole !== "viewer") {
    contextRole = "manager";
  } else if (row.granted_role) {
    contextRole = row.granted_role;
  }
  if (
    !contextRole ||
    !contextRoleAllows(project.projectRole, contextRole, input.capability || "read")
  ) {
    return undefined;
  }
  return Object.freeze({
    ...project,
    contextId: row.id,
    contextKind: row.context_kind,
    visibility: row.visibility,
    contextRole,
  });
}

export async function contextScopeForConnection(
  database,
  input: {
    userId: string;
    connectionId: string;
    projectId: string;
    contextId: string;
    capability?: ContextCapability;
  },
) {
  const connection = await tenantScopeForConnection(database, input);
  if (!connection) return undefined;
  const context = await contextScopeForUser(database, input);
  if (!context) return undefined;
  return Object.freeze({
    ...context,
    connectionId: connection.connectionId,
    clientId: connection.clientId,
  });
}
