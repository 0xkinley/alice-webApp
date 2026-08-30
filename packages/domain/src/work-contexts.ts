import { randomUUID } from "node:crypto";
import { createWorkContextSchema } from "@alice/schemas";
import { appendAuditEvent } from "./audit.ts";
import {
  contextScopeForUser,
  projectScopeForUser,
  type ProjectCapability,
} from "./authorization.ts";

function normalizedTerms(value) {
  return [
    ...new Set(
      String(value)
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ].sort();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function similarityScore(input, context) {
  const inputName = input.name.normalize("NFKC").toLocaleLowerCase("en-US");
  const contextName = context.name.normalize("NFKC").toLocaleLowerCase("en-US");
  if (inputName === contextName) return 1_000;
  const inputTerms = new Set(normalizedTerms(`${input.name} ${input.description}`));
  const contextNameTerms = new Set(normalizedTerms(context.name));
  const contextDescriptionTerms = new Set(normalizedTerms(context.description));
  return [...inputTerms].reduce(
    (score, term) =>
      score + (contextNameTerms.has(term) ? 8 : 0) + (contextDescriptionTerms.has(term) ? 3 : 0),
    0,
  );
}

async function projectForUser(database, userId, projectId, capability: ProjectCapability = "read") {
  return await projectScopeForUser(database, { userId, projectId, capability });
}

async function appendContextHistory(
  database,
  { workspaceId, projectId, contextId, action, actorUserId, metadata = {} },
) {
  await database
    .prepare(
      `INSERT INTO context_history_events
        (id, workspace_id, project_id, context_id, action, actor_user_id,
         safe_metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `context_event_${randomUUID()}`,
      workspaceId,
      projectId,
      contextId,
      action,
      actorUserId,
      JSON.stringify(metadata),
      new Date().toISOString(),
    );
}

export async function provisionInitialWorkContexts(
  database,
  { userId, workspaceId, projectId, createdAt },
) {
  const contexts = [
    {
      id: `context_${randomUUID()}`,
      name: "Project-wide",
      description: "Active context shared across every work context in this project.",
      context_kind: "project_wide",
    },
    {
      id: `context_${randomUUID()}`,
      name: "General",
      description: "Default work context for uncategorized project work.",
      context_kind: "work",
    },
  ];
  for (const context of contexts) {
    await database
      .prepare(
        `INSERT INTO work_contexts
          (id, workspace_id, project_id, name, description, context_kind, visibility,
           created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'all_members', ?, ?, ?)`,
      )
      .run(
        context.id,
        workspaceId,
        projectId,
        context.name,
        context.description,
        context.context_kind,
        userId,
        createdAt,
        createdAt,
      );
    await appendContextHistory(database, {
      workspaceId,
      projectId,
      contextId: context.id,
      action: "context_created",
      actorUserId: userId,
      metadata: { context_id: context.id, context_kind: context.context_kind },
    });
  }
  return contexts;
}

export async function listWorkContexts(database, userId, projectId) {
  const access = await projectForUser(database, userId, projectId);
  if (!access) return undefined;
  const contexts = await database
    .prepare(
      `SELECT id, name, description, context_kind, visibility, created_by_user_id,
              created_at, updated_at, archived_at
       FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL
       ORDER BY context_kind, name, id`,
    )
    .all(access.projectWorkspaceId, projectId);
  const permitted: any[] = [];
  for (const context of contexts) {
    const contextAccess = await contextScopeForUser(database, {
      userId,
      projectId,
      contextId: context.id,
    });
    if (contextAccess) {
      permitted.push({
        ...context,
        context_role: contextAccess.contextRole,
        project_role: contextAccess.projectRole,
        can_write: contextAccess.projectRole !== "viewer" && contextAccess.contextRole !== "viewer",
        can_manage: contextAccess.contextRole === "manager",
      });
    }
  }
  return permitted;
}

export async function suggestSimilarWorkContexts(database, { userId, projectId, input }) {
  if (!(await projectForUser(database, userId, projectId, "write"))) return undefined;
  const parsed = createWorkContextSchema.parse(input);
  const contexts = await listWorkContexts(database, userId, projectId);
  if (!contexts) return undefined;
  return contexts
    .filter(({ context_kind: kind }) => kind === "work")
    .map((context) => ({ ...context, similarity_score: similarityScore(parsed, context) }))
    .filter(({ similarity_score: score }) => score > 0)
    .sort(
      (left, right) =>
        right.similarity_score - left.similarity_score ||
        compareText(left.name, right.name) ||
        compareText(left.id, right.id),
    );
}

export async function createWorkContext(database, { userId, projectId, input }) {
  const access = await projectForUser(database, userId, projectId, "write");
  if (!access) return undefined;
  const parsed = createWorkContextSchema.parse(input);
  const contextId = `context_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  try {
    await database.transaction(async () => {
      await database
        .prepare(
          `INSERT INTO work_contexts
            (id, workspace_id, project_id, name, description, context_kind, visibility,
             created_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'work', ?, ?, ?, ?)`,
        )
        .run(
          contextId,
          access.projectWorkspaceId,
          projectId,
          parsed.name,
          parsed.description,
          parsed.visibility,
          userId,
          createdAt,
          createdAt,
        );
      await appendContextHistory(database, {
        workspaceId: access.projectWorkspaceId,
        projectId,
        contextId,
        action: "context_created",
        actorUserId: userId,
        metadata: {
          context_id: contextId,
          context_kind: "work",
          visibility: parsed.visibility,
        },
      });
      await appendAuditEvent(database, {
        workspaceId: access.projectWorkspaceId,
        projectId,
        action: "work_context_created",
        actorType: "human_user",
        actorId: userId,
        correlationId: `context_${randomUUID()}`,
        metadata: { context_id: contextId },
      });
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      throw new Error("A work context with this name already exists in the project.", {
        cause: error,
      });
    }
    throw error;
  }
  return {
    id: contextId,
    project_id: projectId,
    name: parsed.name,
    description: parsed.description,
    context_kind: "work",
    visibility: parsed.visibility,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export async function getWorkContextHistory(database, { userId, projectId, contextId }) {
  const access = await contextScopeForUser(database, { userId, projectId, contextId });
  if (!access) return undefined;
  const context = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE id = ? AND workspace_id = ? AND project_id = ?`,
    )
    .get(contextId, access.projectWorkspaceId, projectId);
  if (!context) return undefined;
  return await database
    .prepare(
      `SELECT id, action, actor_user_id, safe_metadata_json, created_at
       FROM context_history_events
       WHERE workspace_id = ? AND project_id = ? AND context_id = ?
       ORDER BY created_at, id`,
    )
    .all(access.projectWorkspaceId, projectId, contextId);
}
