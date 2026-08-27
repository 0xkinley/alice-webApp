export type TenantScope = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export type ConnectionScope = TenantScope &
  Readonly<{
    connectionId: string;
    clientId: string;
  }>;

export function tenantScopeForUser(database, userId): TenantScope | undefined {
  if (typeof userId !== "string" || !userId) return undefined;
  const row = database
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

export function tenantScopeForConnection(
  database,
  { userId, connectionId },
): ConnectionScope | undefined {
  if (typeof connectionId !== "string" || !connectionId) return undefined;
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const row = database
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
