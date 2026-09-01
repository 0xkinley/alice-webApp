import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { contextScopeForUser, type ContextRole } from "./authorization.ts";

export class ContextAccessUserError extends Error {}

function contextRole(value: unknown): ContextRole {
  if (value !== "viewer" && value !== "editor" && value !== "manager") {
    throw new ContextAccessUserError("Choose Viewer, Editor, or Manager context access.");
  }
  return value;
}

async function selectedContextManager(
  database,
  userId: string,
  projectId: string,
  contextId: string,
) {
  const access = await contextScopeForUser(database, {
    userId,
    projectId,
    contextId,
    capability: "manage",
  });
  if (!access || access.visibility !== "selected_members" || access.contextKind !== "work") {
    return undefined;
  }
  return access;
}

async function appendAccessHistory(database, input) {
  await database
    .prepare(
      `INSERT INTO context_history_events
        (id, workspace_id, project_id, context_id, action, actor_user_id,
         safe_metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `context_event_${randomUUID()}`,
      input.workspaceId,
      input.projectId,
      input.contextId,
      input.action,
      input.actorUserId,
      JSON.stringify(input.metadata),
      input.createdAt,
    );
}

export async function getContextAccessView(
  database,
  input: { userId: string; projectId: string; contextId: string },
) {
  const access = await selectedContextManager(
    database,
    input.userId,
    input.projectId,
    input.contextId,
  );
  if (!access) return undefined;
  const context = await database
    .prepare(
      `SELECT context.id, context.name, context.description, context.visibility,
              context.created_by_user_id, project.name AS project_name
       FROM work_contexts context
       JOIN projects project
         ON project.workspace_id = context.workspace_id AND project.id = context.project_id
       WHERE context.workspace_id = ? AND context.project_id = ? AND context.id = ?
         AND context.archived_at IS NULL`,
    )
    .get(access.projectWorkspaceId, input.projectId, input.contextId);
  if (!context) return undefined;
  const members = await database
    .prepare(
      `SELECT membership.id AS membership_id, membership.user_id,
              membership.role AS project_role, users.email,
              context_grant.id AS grant_id, context_grant.role AS context_role,
              context_grant.created_at AS granted_at,
              context_grant.updated_at AS grant_updated_at
       FROM project_memberships membership
       JOIN users ON users.id = membership.user_id
       LEFT JOIN context_access_grants context_grant
         ON context_grant.workspace_id = membership.workspace_id
        AND context_grant.project_id = membership.project_id
        AND context_grant.context_id = ?
        AND context_grant.membership_id = membership.id
        AND context_grant.user_id = membership.user_id
        AND context_grant.ended_at IS NULL
       WHERE membership.workspace_id = ? AND membership.project_id = ?
         AND membership.ended_at IS NULL
       ORDER BY CASE WHEN membership.user_id = ? THEN 0 ELSE 1 END,
                lower(users.email), membership.id`,
    )
    .all(input.contextId, access.projectWorkspaceId, input.projectId, context.created_by_user_id);
  return { project: { id: input.projectId, name: context.project_name }, context, members };
}

export async function grantContextAccess(
  database,
  input: {
    userId: string;
    projectId: string;
    contextId: string;
    membershipId: string;
    role: unknown;
  },
) {
  const role = contextRole(input.role);
  return await database.transaction(async () => {
    const access = await selectedContextManager(
      database,
      input.userId,
      input.projectId,
      input.contextId,
    );
    if (!access) return undefined;
    const target = await database
      .prepare(
        `SELECT membership.id, membership.user_id, membership.role,
                context.created_by_user_id
         FROM project_memberships membership
         JOIN work_contexts context
           ON context.workspace_id = membership.workspace_id
          AND context.project_id = membership.project_id
          AND context.id = ?
         WHERE membership.id = ? AND membership.workspace_id = ?
           AND membership.project_id = ? AND membership.ended_at IS NULL
         FOR UPDATE OF membership`,
      )
      .get(input.contextId, input.membershipId, access.projectWorkspaceId, input.projectId);
    if (!target) return undefined;
    if (target.user_id === target.created_by_user_id) {
      throw new ContextAccessUserError("The context creator already has Manager access.");
    }
    if (target.role === "viewer" && role !== "viewer") {
      throw new ContextAccessUserError("A project Viewer can only receive Viewer context access.");
    }
    const existing = await database
      .prepare(
        `SELECT id FROM context_access_grants
         WHERE workspace_id = ? AND project_id = ? AND context_id = ?
           AND user_id = ? AND ended_at IS NULL`,
      )
      .get(access.projectWorkspaceId, input.projectId, input.contextId, target.user_id);
    if (existing) {
      throw new ContextAccessUserError("This member already has context access.");
    }
    const grantId = `context_grant_${randomUUID()}`;
    const now = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO context_access_grants
          (id, workspace_id, project_id, context_id, membership_id, user_id, role,
           granted_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grantId,
        access.projectWorkspaceId,
        input.projectId,
        input.contextId,
        target.id,
        target.user_id,
        role,
        input.userId,
        now,
        now,
      );
    await appendAccessHistory(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: input.projectId,
      contextId: input.contextId,
      action: "context_access_granted",
      actorUserId: input.userId,
      metadata: { grant_id: grantId, membership_id: target.id, role },
      createdAt: now,
    });
    await appendAuditEvent(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: input.projectId,
      action: "context_access_granted",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: grantId,
      metadata: {
        context_id: input.contextId,
        grant_id: grantId,
        membership_id: target.id,
        role,
      },
    });
    return { id: grantId, membership_id: target.id, user_id: target.user_id, role };
  });
}

export async function updateContextAccessRole(
  database,
  input: {
    userId: string;
    projectId: string;
    contextId: string;
    grantId: string;
    role: unknown;
  },
) {
  const role = contextRole(input.role);
  return await database.transaction(async () => {
    const access = await selectedContextManager(
      database,
      input.userId,
      input.projectId,
      input.contextId,
    );
    if (!access) return undefined;
    const grant = await database
      .prepare(
        `SELECT context_grant.id, context_grant.membership_id, context_grant.user_id,
                context_grant.role, membership.role AS project_role
         FROM context_access_grants context_grant
         JOIN project_memberships membership
           ON membership.workspace_id = context_grant.workspace_id
          AND membership.project_id = context_grant.project_id
          AND membership.id = context_grant.membership_id
          AND membership.user_id = context_grant.user_id
         WHERE context_grant.id = ? AND context_grant.workspace_id = ?
           AND context_grant.project_id = ? AND context_grant.context_id = ?
           AND context_grant.ended_at IS NULL AND membership.ended_at IS NULL
         FOR UPDATE OF context_grant`,
      )
      .get(input.grantId, access.projectWorkspaceId, input.projectId, input.contextId);
    if (!grant) return undefined;
    if (grant.project_role === "viewer" && role !== "viewer") {
      throw new ContextAccessUserError("A project Viewer can only receive Viewer context access.");
    }
    if (grant.role === role) return { id: grant.id, role, changed: false };
    const now = new Date().toISOString();
    await database
      .prepare(
        `UPDATE context_access_grants SET role = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND project_id = ? AND context_id = ?`,
      )
      .run(role, now, grant.id, access.projectWorkspaceId, input.projectId, input.contextId);
    await appendAccessHistory(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: input.projectId,
      contextId: input.contextId,
      action: "context_access_role_changed",
      actorUserId: input.userId,
      metadata: { grant_id: grant.id, prior_role: grant.role, role },
      createdAt: now,
    });
    await appendAuditEvent(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: input.projectId,
      action: "context_access_role_changed",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: grant.id,
      metadata: {
        context_id: input.contextId,
        grant_id: grant.id,
        prior_role: grant.role,
        role,
      },
    });
    return { id: grant.id, role, changed: true };
  });
}

export async function endContextAccess(
  database,
  input: { userId: string; projectId: string; contextId: string; grantId: string },
) {
  return await database.transaction(async () => {
    const access = await selectedContextManager(
      database,
      input.userId,
      input.projectId,
      input.contextId,
    );
    if (!access) return undefined;
    const grant = await database
      .prepare(
        `SELECT id, membership_id, user_id, role FROM context_access_grants
         WHERE id = ? AND workspace_id = ? AND project_id = ? AND context_id = ?
           AND ended_at IS NULL
         FOR UPDATE`,
      )
      .get(input.grantId, access.projectWorkspaceId, input.projectId, input.contextId);
    if (!grant) return undefined;
    const now = new Date().toISOString();
    await database
      .prepare(
        `UPDATE context_access_grants
         SET ended_at = ?, ended_by_user_id = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND project_id = ? AND context_id = ?`,
      )
      .run(
        now,
        input.userId,
        now,
        grant.id,
        access.projectWorkspaceId,
        input.projectId,
        input.contextId,
      );
    await appendAccessHistory(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: input.projectId,
      contextId: input.contextId,
      action: "context_access_ended",
      actorUserId: input.userId,
      metadata: { grant_id: grant.id, membership_id: grant.membership_id, role: grant.role },
      createdAt: now,
    });
    await appendAuditEvent(database, {
      workspaceId: access.projectWorkspaceId,
      projectId: input.projectId,
      action: "context_access_ended",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: grant.id,
      metadata: {
        context_id: input.contextId,
        grant_id: grant.id,
        membership_id: grant.membership_id,
        role: grant.role,
      },
    });
    return { id: grant.id, user_id: grant.user_id };
  });
}
