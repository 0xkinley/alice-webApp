import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { contextScopeForUser } from "./authorization.ts";

export type AliceProvider = "chatgpt" | "claude";

export async function getContextProviderAvailability(
  database,
  input: { userId: string; projectId: string; contextId: string },
) {
  const context = await contextScopeForUser(database, input);
  if (!context) return undefined;
  const rows = await database
    .prepare(
      `SELECT provider, enabled, version, updated_at
       FROM context_provider_authorizations
       WHERE workspace_id = ? AND project_id = ? AND context_id = ? AND user_id = ?
       ORDER BY provider`,
    )
    .all(context.projectWorkspaceId, input.projectId, input.contextId, input.userId);
  const byProvider = new Map<string, any>(rows.map((row) => [row.provider, row]));
  return {
    chatgpt: Boolean(byProvider.get("chatgpt")?.enabled),
    claude: Boolean(byProvider.get("claude")?.enabled),
    versions: {
      chatgpt: byProvider.get("chatgpt")?.version || null,
      claude: byProvider.get("claude")?.version || null,
    },
  };
}

export async function setContextProviderAvailability(
  database,
  input: {
    userId: string;
    projectId: string;
    contextId: string;
    chatgpt: boolean;
    claude: boolean;
    expectedVersions?: { chatgpt?: string | null; claude?: string | null };
  },
) {
  const context = await contextScopeForUser(database, { ...input, capability: "read" });
  if (!context) return undefined;
  return database.transaction(async () => {
    const current = await getContextProviderAvailability(database, input);
    if (!current) return undefined;
    for (const provider of ["chatgpt", "claude"] as const) {
      if (
        input.expectedVersions &&
        Object.hasOwn(input.expectedVersions, provider) &&
        input.expectedVersions[provider] !== current.versions[provider]
      ) {
        return { conflict: true as const };
      }
    }
    const changedAt = new Date().toISOString();
    const versions: Record<AliceProvider, string> = {
      chatgpt: `provider_auth_version_${randomUUID()}`,
      claude: `provider_auth_version_${randomUUID()}`,
    };
    for (const provider of ["chatgpt", "claude"] as const) {
      await database
        .prepare(
          `INSERT INTO context_provider_authorizations
           (id, workspace_id, project_id, context_id, user_id, provider, enabled,
            version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, project_id, context_id, user_id, provider)
           DO UPDATE SET enabled = excluded.enabled, version = excluded.version,
                         updated_at = excluded.updated_at`,
        )
        .run(
          `provider_auth_${randomUUID()}`,
          context.projectWorkspaceId,
          input.projectId,
          input.contextId,
          input.userId,
          provider,
          input[provider] ? 1 : 0,
          versions[provider],
          changedAt,
          changedAt,
        );
    }
    await appendAuditEvent(database, {
      workspaceId: context.projectWorkspaceId,
      projectId: input.projectId,
      action: "context_provider_availability_changed",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: `provider_auth_${randomUUID()}`,
      metadata: {
        context_id: input.contextId,
        chatgpt: input.chatgpt,
        claude: input.claude,
      },
    });
    return {
      conflict: false as const,
      chatgpt: input.chatgpt,
      claude: input.claude,
      versions,
      updated_at: changedAt,
    };
  });
}
