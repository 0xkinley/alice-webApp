import { projectScopeForUser } from "./authorization.ts";
import { listIntegrationConnections } from "./connections.ts";
import { listWorkContexts } from "./work-contexts.ts";

const PROJECT_SECURITY_ACTIONS = new Map([
  ["project_created", "Project created"],
  ["project_invitation_issued", "Project invitation issued"],
  ["project_invitation_accepted", "Project invitation accepted"],
  ["project_invitation_declined", "Project invitation declined"],
  ["project_invitation_revoked", "Project invitation revoked"],
  ["project_invitation_replaced", "Project invitation replaced"],
  ["project_membership_role_changed", "Project role changed"],
  ["project_member_removed", "Project access removed"],
  ["project_ownership_transferred", "Project ownership transferred"],
  ["project_member_left", "Project member left"],
  ["project_archived", "Project archived"],
  ["project_restored", "Project restored"],
  ["project_deletion_requested", "Project deletion requested"],
  ["project_deletion_cancelled", "Project deletion request cancelled"],
  ["work_context_created", "Work context created"],
  ["context_access_granted", "Context access granted"],
  ["context_access_role_changed", "Context role changed"],
  ["context_access_ended", "Context access ended"],
  ["active_context_target_selected", "AI connection target changed"],
  ["saved_context_removed", "Saved context removed"],
  ["file_reference_linked", "File added to context"],
  ["file_reference_removed", "File reference removed"],
]);

const CONTEXT_SECURITY_ACTIONS = new Set([
  "work_context_created",
  "context_access_granted",
  "context_access_role_changed",
  "context_access_ended",
  "active_context_target_selected",
  "saved_context_removed",
  "file_reference_linked",
  "file_reference_removed",
]);

function safeMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function derivedContextRole(projectRole: string) {
  return projectRole === "owner" ? "manager" : projectRole === "editor" ? "editor" : "viewer";
}

export async function getProjectAccessOverview(
  database,
  input: { userId: string; projectId: string },
) {
  const access = await projectScopeForUser(database, input);
  if (!access) return undefined;

  const project = await database
    .prepare(
      `SELECT id, name, brief
       FROM projects
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(access.projectWorkspaceId, input.projectId);
  if (!project) return undefined;

  const members = await database
    .prepare(
      `SELECT membership.id, membership.user_id, membership.role,
              membership.created_at, membership.updated_at, users.email
       FROM project_memberships membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.workspace_id = ? AND membership.project_id = ?
         AND membership.ended_at IS NULL
       ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                lower(users.email), membership.id`,
    )
    .all(access.projectWorkspaceId, input.projectId);
  const memberByUserId = new Map<string, any>(
    members.map((member) => [member.user_id, member] as [string, any]),
  );

  const visibleContexts = (await listWorkContexts(database, input.userId, input.projectId)) || [];
  const grants = await database
    .prepare(
      `SELECT user_id, context_id, role
       FROM context_access_grants
       WHERE workspace_id = ? AND project_id = ? AND ended_at IS NULL
       ORDER BY context_id, user_id`,
    )
    .all(access.projectWorkspaceId, input.projectId);
  const grantsByContext = new Map<string, any[]>();
  for (const grant of grants) {
    const contextGrants = grantsByContext.get(grant.context_id) || [];
    contextGrants.push(grant);
    grantsByContext.set(grant.context_id, contextGrants);
  }

  const contexts = visibleContexts.map((context) => {
    let permittedMembers;
    if (context.context_kind === "project_wide" || context.visibility === "all_members") {
      permittedMembers = members.map((member) => ({
        user_id: member.user_id,
        email: member.email,
        project_role: member.role,
        context_role: derivedContextRole(member.role),
      }));
    } else {
      const roles = new Map<string, string>();
      const creator = memberByUserId.get(context.created_by_user_id);
      if (creator && creator.role !== "viewer") {
        roles.set(context.created_by_user_id, "manager");
      }
      if (context.visibility === "selected_members") {
        for (const grant of grantsByContext.get(context.id) || []) {
          if (memberByUserId.has(grant.user_id)) roles.set(grant.user_id, grant.role);
        }
      }
      permittedMembers = [...roles]
        .map(([userId, contextRole]) => {
          const member = memberByUserId.get(userId);
          return {
            user_id: member.user_id,
            email: member.email,
            project_role: member.role,
            context_role: contextRole,
          };
        })
        .sort(
          (left, right) =>
            left.email.localeCompare(right.email) || left.user_id.localeCompare(right.user_id),
        );
    }
    return {
      id: context.id,
      name: context.name,
      context_kind: context.context_kind,
      visibility: context.visibility,
      current_user_role: context.context_role,
      can_manage: context.can_manage,
      members: permittedMembers,
    };
  });
  const visibleContextById = new Map(contexts.map((context) => [context.id, context]));

  const connections = (await listIntegrationConnections(database, input.userId))
    .filter(({ revoked_at: revokedAt }) => !revokedAt)
    .map((connection) => ({
      client_name: connection.client_name,
      client_classification: connection.client_classification,
      last_used_at: connection.last_used_at,
      project_name: connection.project_name,
      context_name: connection.context_name,
      targets_this_project: connection.project_id === input.projectId,
    }));

  const auditRows = await database
    .prepare(
      `SELECT audit.action, audit.actor_type, audit.actor_id,
              audit.safe_metadata_json, audit.created_at, users.email AS actor_email
       FROM audit_events audit
       LEFT JOIN users ON users.id = audit.actor_id
       WHERE audit.workspace_id = ? AND audit.project_id = ?
       ORDER BY audit.created_at DESC, audit.id DESC
       LIMIT 100`,
    )
    .all(access.projectWorkspaceId, input.projectId);
  const securityEvents: any[] = [];
  for (const event of auditRows) {
    const label = PROJECT_SECURITY_ACTIONS.get(event.action);
    if (!label) continue;
    const metadata = safeMetadata(event.safe_metadata_json);
    const contextId = typeof metadata.context_id === "string" ? metadata.context_id : undefined;
    const context = contextId ? visibleContextById.get(contextId) : undefined;
    if (CONTEXT_SECURITY_ACTIONS.has(event.action) && !context) continue;
    if (event.action === "active_context_target_selected" && event.actor_id !== input.userId) {
      continue;
    }
    securityEvents.push({
      action: event.action,
      label,
      actor_type: event.actor_type,
      actor_label:
        event.actor_id === input.userId || memberByUserId.has(event.actor_id)
          ? event.actor_email || "Project member"
          : event.actor_type === "mcp_host"
            ? "AI host"
            : "Former or invited user",
      context_name: context?.name || null,
      created_at: event.created_at,
    });
    if (securityEvents.length === 25) break;
  }

  return {
    project: { ...project, current_user_role: access.projectRole },
    members,
    contexts,
    connections,
    security_events: securityEvents,
    privacy: {
      connection_scope: "Only your own AI connections are shown.",
      history_scope:
        "Security history uses bounded action labels, actor identity, context name, and time; stored event metadata is not displayed.",
    },
  };
}
