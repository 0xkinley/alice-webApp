import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForUser } from "./authorization.ts";

const PROJECT_INVITATION_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROJECT_INVITATION_PREFIX = "alice_project_invite_";

export type ProjectMembershipRole = "owner" | "editor" | "viewer";
export type ProjectInvitationRole = Exclude<ProjectMembershipRole, "owner">;

export class ProjectMembershipUserError extends Error {}

function normalizeEmail(value: unknown): string {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new ProjectMembershipUserError("Enter a valid recipient email address.");
  }
  return email;
}

function invitationRole(value: unknown): ProjectInvitationRole {
  if (value !== "editor" && value !== "viewer") {
    throw new ProjectMembershipUserError("Choose Editor or Viewer access.");
  }
  return value;
}

function invitationTtl(value: unknown): number {
  const ttl = value === undefined ? PROJECT_INVITATION_DEFAULT_TTL_SECONDS : Number(value);
  if (!Number.isInteger(ttl) || ttl < 3_600 || ttl > 30 * 24 * 60 * 60) {
    throw new ProjectMembershipUserError(
      "Invitation lifetime must be between one hour and 30 days.",
    );
  }
  return ttl;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInvitationToken(): string {
  return `${PROJECT_INVITATION_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function validInvitationToken(value: unknown): string | undefined {
  const token = String(value || "");
  if (!token.startsWith(PROJECT_INVITATION_PREFIX) || token.length > 160) return undefined;
  return token;
}

async function projectMembership(database, userId: string, projectId: string) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant || typeof projectId !== "string" || !projectId) return undefined;
  return await database
    .prepare(
      `SELECT project.id AS project_id, project.workspace_id, project.name, project.brief,
              membership.id AS membership_id, membership.role, membership.created_at,
              membership.updated_at
       FROM project_memberships membership
       JOIN projects project
         ON project.workspace_id = membership.workspace_id
        AND project.id = membership.project_id
       WHERE membership.project_id = ? AND membership.user_id = ?
         AND membership.ended_at IS NULL AND project.archived_at IS NULL`,
    )
    .get(projectId, tenant.userId);
}

async function ownerProject(database, userId: string, projectId: string) {
  const membership = await projectMembership(database, userId, projectId);
  return membership?.role === "owner" ? membership : undefined;
}

async function invitationForRecipient(database, userId: string, token: unknown, lock = false) {
  const tenant = await tenantScopeForUser(database, userId);
  const validToken = validInvitationToken(token);
  if (!tenant || !validToken) return undefined;
  return await database
    .prepare(
      `SELECT invitation.id, invitation.workspace_id, invitation.project_id,
              invitation.email, invitation.role, invitation.expires_at,
              invitation.created_at, invitation.created_by_user_id,
              project.name AS project_name,
              project.brief AS project_brief
       FROM project_invitations invitation
       JOIN projects project
         ON project.workspace_id = invitation.workspace_id
        AND project.id = invitation.project_id
       JOIN users recipient ON recipient.id = ?
       WHERE invitation.token_hash = ?
         AND lower(invitation.email) = lower(recipient.email)
         AND invitation.expires_at > ?
         AND invitation.accepted_at IS NULL
         AND invitation.declined_at IS NULL
         AND invitation.revoked_at IS NULL
         AND project.archived_at IS NULL
       ${lock ? "FOR UPDATE OF invitation" : ""}`,
    )
    .get(tenant.userId, hashToken(validToken), Math.floor(Date.now() / 1_000));
}

async function insertInvitation(
  database,
  input: {
    owner: any;
    actorUserId: string;
    email: string;
    role: ProjectInvitationRole;
    ttlSeconds: number;
  },
) {
  const invitationId = `project_invitation_${randomUUID()}`;
  const token = newInvitationToken();
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1_000) + input.ttlSeconds;
  await database
    .prepare(
      `INSERT INTO project_invitations
        (id, workspace_id, project_id, email, role, token_hash,
         created_by_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      invitationId,
      input.owner.workspace_id,
      input.owner.project_id,
      input.email,
      input.role,
      hashToken(token),
      input.actorUserId,
      expiresAt,
      createdAt,
    );
  await appendAuditEvent(database, {
    workspaceId: input.owner.workspace_id,
    projectId: input.owner.project_id,
    action: "project_invitation_issued",
    actorType: "human_user",
    actorId: input.actorUserId,
    correlationId: invitationId,
    metadata: { invitation_id: invitationId, role: input.role },
  });
  return {
    id: invitationId,
    project_id: input.owner.project_id,
    email: input.email,
    role: input.role,
    token,
    expires_at: expiresAt,
  };
}

export async function listSharedProjects(database, userId: string) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return [];
  return await database
    .prepare(
      `SELECT project.id, project.name, project.brief, membership.role,
              membership.created_at AS joined_at
       FROM project_memberships membership
       JOIN projects project
         ON project.workspace_id = membership.workspace_id
        AND project.id = membership.project_id
       WHERE membership.user_id = ? AND membership.ended_at IS NULL
         AND membership.role <> 'owner'
         AND project.archived_at IS NULL
       ORDER BY lower(project.name), project.id`,
    )
    .all(tenant.userId);
}

export async function getProjectMembershipView(database, userId: string, projectId: string) {
  return await projectMembership(database, userId, projectId);
}

export async function getProjectCollaborators(database, userId: string, projectId: string) {
  const owner = await ownerProject(database, userId, projectId);
  if (!owner) return undefined;
  const members = await database
    .prepare(
      `SELECT membership.id, membership.user_id, users.email, membership.role,
              membership.created_at, membership.updated_at
       FROM project_memberships membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.workspace_id = ? AND membership.project_id = ?
         AND membership.ended_at IS NULL
       ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                lower(users.email), membership.id`,
    )
    .all(owner.workspace_id, owner.project_id);
  const invitations = await database
    .prepare(
      `SELECT id, email, role, expires_at, created_at, accepted_at, declined_at, revoked_at
       FROM project_invitations
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(owner.workspace_id, owner.project_id);
  return { project: owner, members, invitations };
}

export async function createProjectInvitation(
  database,
  input: {
    userId: string;
    projectId: string;
    email: unknown;
    role: unknown;
    ttlSeconds?: unknown;
  },
) {
  const email = normalizeEmail(input.email);
  const role = invitationRole(input.role);
  const ttlSeconds = invitationTtl(input.ttlSeconds);
  try {
    return await database.transaction(async () => {
      const owner = await ownerProject(database, input.userId, input.projectId);
      if (!owner) return undefined;
      await database
        .prepare("SELECT id FROM projects WHERE workspace_id = ? AND id = ? FOR UPDATE")
        .get(owner.workspace_id, owner.project_id);
      const activeMember = await database
        .prepare(
          `SELECT membership.id
           FROM project_memberships membership
           JOIN users ON users.id = membership.user_id
           WHERE membership.project_id = ? AND membership.ended_at IS NULL
             AND lower(users.email) = lower(?)`,
        )
        .get(owner.project_id, email);
      if (activeMember) {
        throw new ProjectMembershipUserError("This person already has project access.");
      }
      return await insertInvitation(database, {
        owner,
        actorUserId: input.userId,
        email,
        role,
        ttlSeconds,
      });
    });
  } catch (error) {
    if (error instanceof ProjectMembershipUserError) throw error;
    if (
      (typeof error === "object" && error && "code" in error && error.code === "23505") ||
      String(error).includes("UNIQUE constraint failed: project_invitations")
    ) {
      throw new ProjectMembershipUserError("A pending invitation already exists for this email.");
    }
    throw error;
  }
}

export async function getProjectInvitationPreview(database, userId: string, token: unknown) {
  return await invitationForRecipient(database, userId, token);
}

export async function acceptProjectInvitation(database, userId: string, token: unknown) {
  return await database.transaction(async () => {
    const invitation = await invitationForRecipient(database, userId, token, true);
    if (!invitation) return undefined;
    const now = new Date().toISOString();
    const membershipId = `membership_${randomUUID()}`;
    await database
      .prepare(
        `INSERT INTO project_memberships
          (id, workspace_id, project_id, user_id, role, created_by_user_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        membershipId,
        invitation.workspace_id,
        invitation.project_id,
        userId,
        invitation.role,
        invitation.created_by_user_id || userId,
        now,
        now,
      );
    const accepted = await database
      .prepare(
        `UPDATE project_invitations
         SET accepted_by_user_id = ?, accepted_at = ?
         WHERE id = ? AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
      )
      .run(userId, now, invitation.id);
    if (accepted.changes !== 1) {
      throw new ProjectMembershipUserError("This invitation is no longer available.");
    }
    await appendAuditEvent(database, {
      workspaceId: invitation.workspace_id,
      projectId: invitation.project_id,
      action: "project_invitation_accepted",
      actorType: "human_user",
      actorId: userId,
      correlationId: invitation.id,
      metadata: {
        invitation_id: invitation.id,
        membership_id: membershipId,
        role: invitation.role,
      },
    });
    return {
      project_id: invitation.project_id,
      membership_id: membershipId,
      role: invitation.role,
    };
  });
}

export async function declineProjectInvitation(database, userId: string, token: unknown) {
  return await database.transaction(async () => {
    const invitation = await invitationForRecipient(database, userId, token, true);
    if (!invitation) return undefined;
    const now = new Date().toISOString();
    const declined = await database
      .prepare(
        `UPDATE project_invitations
         SET declined_by_user_id = ?, declined_at = ?
         WHERE id = ? AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
      )
      .run(userId, now, invitation.id);
    if (declined.changes !== 1) return undefined;
    await appendAuditEvent(database, {
      workspaceId: invitation.workspace_id,
      projectId: invitation.project_id,
      action: "project_invitation_declined",
      actorType: "human_user",
      actorId: userId,
      correlationId: invitation.id,
      metadata: { invitation_id: invitation.id },
    });
    return { project_id: invitation.project_id };
  });
}

export async function revokeProjectInvitation(
  database,
  input: { userId: string; projectId: string; invitationId: string },
) {
  return await database.transaction(async () => {
    const owner = await ownerProject(database, input.userId, input.projectId);
    if (!owner) return undefined;
    const now = new Date().toISOString();
    const revoked = await database
      .prepare(
        `UPDATE project_invitations
         SET revoked_by_user_id = ?, revoked_at = ?
         WHERE id = ? AND workspace_id = ? AND project_id = ?
           AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
      )
      .run(input.userId, now, input.invitationId, owner.workspace_id, owner.project_id);
    if (revoked.changes !== 1) return undefined;
    await appendAuditEvent(database, {
      workspaceId: owner.workspace_id,
      projectId: owner.project_id,
      action: "project_invitation_revoked",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: input.invitationId,
      metadata: { invitation_id: input.invitationId },
    });
    return { id: input.invitationId };
  });
}

export async function resendProjectInvitation(
  database,
  input: { userId: string; projectId: string; invitationId: string; ttlSeconds?: unknown },
) {
  const ttlSeconds = invitationTtl(input.ttlSeconds);
  return await database.transaction(async () => {
    const owner = await ownerProject(database, input.userId, input.projectId);
    if (!owner) return undefined;
    const invitation = await database
      .prepare(
        `SELECT id, email, role FROM project_invitations
         WHERE id = ? AND workspace_id = ? AND project_id = ?
           AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL
         FOR UPDATE`,
      )
      .get(input.invitationId, owner.workspace_id, owner.project_id);
    if (!invitation) return undefined;
    const now = new Date().toISOString();
    await database
      .prepare(
        `UPDATE project_invitations SET revoked_by_user_id = ?, revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(input.userId, now, invitation.id);
    await appendAuditEvent(database, {
      workspaceId: owner.workspace_id,
      projectId: owner.project_id,
      action: "project_invitation_replaced",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: invitation.id,
      metadata: { invitation_id: invitation.id },
    });
    return await insertInvitation(database, {
      owner,
      actorUserId: input.userId,
      email: invitation.email,
      role: invitation.role,
      ttlSeconds,
    });
  });
}

export async function updateProjectMemberRole(
  database,
  input: { userId: string; projectId: string; membershipId: string; role: unknown },
) {
  const role = invitationRole(input.role);
  return await database.transaction(async () => {
    const owner = await ownerProject(database, input.userId, input.projectId);
    if (!owner) return undefined;
    const target = await database
      .prepare(
        `SELECT id, user_id, role FROM project_memberships
         WHERE id = ? AND workspace_id = ? AND project_id = ? AND ended_at IS NULL
         FOR UPDATE`,
      )
      .get(input.membershipId, owner.workspace_id, owner.project_id);
    if (!target || target.role === "owner") return undefined;
    if (role === "viewer") {
      const incompatibleGrant = await database
        .prepare(
          `SELECT id FROM context_access_grants
           WHERE membership_id = ? AND ended_at IS NULL AND role <> 'viewer'
           LIMIT 1`,
        )
        .get(target.id);
      if (incompatibleGrant) {
        throw new ProjectMembershipUserError(
          "Reduce this member's restricted-context access to Viewer before changing their project role.",
        );
      }
    }
    const now = new Date().toISOString();
    await database
      .prepare("UPDATE project_memberships SET role = ?, updated_at = ? WHERE id = ?")
      .run(role, now, target.id);
    await appendAuditEvent(database, {
      workspaceId: owner.workspace_id,
      projectId: owner.project_id,
      action: "project_membership_role_changed",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: target.id,
      metadata: { membership_id: target.id, prior_role: target.role, role },
    });
    return { id: target.id, role };
  });
}

async function assertSafeMemberDeparture(database, target) {
  const personalContext = await database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND created_by_user_id = ?
         AND visibility = 'personal' AND archived_at IS NULL
       LIMIT 1`,
    )
    .get(target.workspace_id, target.project_id, target.user_id);
  if (personalContext) {
    throw new ProjectMembershipUserError(
      "This member still owns a personal context. Archive or dispose of it before ending membership.",
    );
  }
  const unmanagedSelectedContext = await database
    .prepare(
      `SELECT context.id
       FROM work_contexts context
       WHERE context.workspace_id = ? AND context.project_id = ?
         AND context.created_by_user_id = ?
         AND context.visibility = 'selected_members' AND context.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM context_access_grants context_grant
           JOIN project_memberships membership
             ON membership.workspace_id = context_grant.workspace_id
            AND membership.project_id = context_grant.project_id
            AND membership.id = context_grant.membership_id
            AND membership.user_id = context_grant.user_id
           WHERE context_grant.workspace_id = context.workspace_id
             AND context_grant.project_id = context.project_id
             AND context_grant.context_id = context.id
             AND context_grant.user_id <> ?
             AND context_grant.role = 'manager'
             AND context_grant.ended_at IS NULL
             AND membership.ended_at IS NULL
         )
       LIMIT 1`,
    )
    .get(target.workspace_id, target.project_id, target.user_id, target.user_id);
  if (unmanagedSelectedContext) {
    throw new ProjectMembershipUserError(
      "Give another member Manager access to this member's restricted contexts before ending membership.",
    );
  }
}

async function endMembershipContextGrants(database, target, actorUserId: string, endedAt: string) {
  const grants = await database
    .prepare(
      `SELECT id, context_id, role FROM context_access_grants
       WHERE membership_id = ? AND ended_at IS NULL
       ORDER BY id FOR UPDATE`,
    )
    .all(target.id);
  for (const grant of grants) {
    await database
      .prepare(
        `UPDATE context_access_grants
         SET ended_at = ?, ended_by_user_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(endedAt, actorUserId, endedAt, grant.id);
    await database
      .prepare(
        `INSERT INTO context_history_events
          (id, workspace_id, project_id, context_id, action, actor_user_id,
           safe_metadata_json, created_at)
         VALUES (?, ?, ?, ?, 'context_access_ended', ?, ?, ?)`,
      )
      .run(
        `context_event_${randomUUID()}`,
        target.workspace_id,
        target.project_id,
        grant.context_id,
        actorUserId,
        JSON.stringify({
          grant_id: grant.id,
          membership_id: target.id,
          role: grant.role,
          membership_ended: true,
        }),
        endedAt,
      );
  }
  return grants;
}

export async function removeProjectMember(
  database,
  input: { userId: string; projectId: string; membershipId: string },
) {
  return await database.transaction(async () => {
    const owner = await ownerProject(database, input.userId, input.projectId);
    if (!owner) return undefined;
    const target = await database
      .prepare(
        `SELECT id, workspace_id, project_id, user_id, role FROM project_memberships
         WHERE id = ? AND workspace_id = ? AND project_id = ? AND ended_at IS NULL
         FOR UPDATE`,
      )
      .get(input.membershipId, owner.workspace_id, owner.project_id);
    if (!target || target.role === "owner") return undefined;
    await assertSafeMemberDeparture(database, target);
    const now = new Date().toISOString();
    const endedGrants = await endMembershipContextGrants(database, target, input.userId, now);
    await database
      .prepare(
        `UPDATE project_memberships
         SET ended_at = ?, ended_by_user_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, input.userId, now, target.id);
    await appendAuditEvent(database, {
      workspaceId: owner.workspace_id,
      projectId: owner.project_id,
      action: "project_member_removed",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: target.id,
      metadata: {
        membership_id: target.id,
        role: target.role,
        ended_context_grant_ids: endedGrants.map(({ id }) => id),
      },
    });
    return { id: target.id };
  });
}

export async function transferProjectOwnership(
  database,
  input: { userId: string; projectId: string; membershipId: string },
) {
  return await database.transaction(async () => {
    const owner = await ownerProject(database, input.userId, input.projectId);
    if (!owner) return undefined;
    await database
      .prepare("SELECT id FROM projects WHERE workspace_id = ? AND id = ? FOR UPDATE")
      .get(owner.workspace_id, owner.project_id);
    const target = await database
      .prepare(
        `SELECT id, user_id, role FROM project_memberships
         WHERE id = ? AND workspace_id = ? AND project_id = ? AND ended_at IS NULL
         FOR UPDATE`,
      )
      .get(input.membershipId, owner.workspace_id, owner.project_id);
    if (!target || target.id === owner.membership_id || target.role === "owner") return undefined;
    const now = new Date().toISOString();
    await database
      .prepare("UPDATE project_memberships SET role = 'owner', updated_at = ? WHERE id = ?")
      .run(now, target.id);
    await database
      .prepare("UPDATE project_memberships SET role = 'editor', updated_at = ? WHERE id = ?")
      .run(now, owner.membership_id);
    await appendAuditEvent(database, {
      workspaceId: owner.workspace_id,
      projectId: owner.project_id,
      action: "project_ownership_transferred",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: target.id,
      metadata: {
        prior_owner_membership_id: owner.membership_id,
        owner_membership_id: target.id,
        prior_target_role: target.role,
      },
    });
    return {
      project_id: owner.project_id,
      prior_owner_membership_id: owner.membership_id,
      owner_membership_id: target.id,
    };
  });
}

export async function leaveProject(database, userId: string, projectId: string) {
  return await database.transaction(async () => {
    const target = await projectMembership(database, userId, projectId);
    if (!target) return undefined;
    const locked = await database
      .prepare(
        `SELECT id, workspace_id, project_id, user_id, role FROM project_memberships
         WHERE id = ? AND ended_at IS NULL FOR UPDATE`,
      )
      .get(target.membership_id);
    if (!locked) return undefined;
    if (locked.role === "owner") {
      throw new ProjectMembershipUserError(
        "Transfer project ownership before leaving this project.",
      );
    }
    await assertSafeMemberDeparture(database, locked);
    const now = new Date().toISOString();
    const endedGrants = await endMembershipContextGrants(database, locked, userId, now);
    await database
      .prepare(
        `UPDATE project_memberships
         SET ended_at = ?, ended_by_user_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, userId, now, locked.id);
    await appendAuditEvent(database, {
      workspaceId: locked.workspace_id,
      projectId: locked.project_id,
      action: "project_member_left",
      actorType: "human_user",
      actorId: userId,
      correlationId: locked.id,
      metadata: {
        membership_id: locked.id,
        role: locked.role,
        ended_context_grant_ids: endedGrants.map(({ id }) => id),
      },
    });
    return { id: locked.id, project_id: locked.project_id };
  });
}
