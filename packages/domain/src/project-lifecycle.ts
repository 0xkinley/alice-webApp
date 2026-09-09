import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";

const DELETION_COOLING_OFF_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export class ProjectLifecycleUserError extends Error {}

function previewVersion(project, request) {
  return `project_lifecycle_${createHash("sha256")
    .update(
      JSON.stringify({
        project_id: project.id,
        updated_at: project.updated_at,
        archived_at: project.archived_at,
        deletion_request_id: request?.id || null,
        deletion_requested_at: request?.requested_at || null,
        deletion_cancelled_at: request?.cancelled_at || null,
      }),
    )
    .digest("hex")}`;
}

function parseJson(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

async function ownerLifecycle(database, userId: string, projectId: string, lock = false) {
  if (typeof userId !== "string" || !userId || typeof projectId !== "string" || !projectId) {
    return undefined;
  }
  const project = await database
    .prepare(
      `SELECT project.id, project.workspace_id, project.name,
              project.created_at, project.updated_at, project.archived_at,
              project.archived_by_user_id, membership.id AS membership_id
       FROM projects project
       JOIN project_memberships membership
         ON membership.workspace_id = project.workspace_id
        AND membership.project_id = project.id
        AND membership.user_id = ?
        AND membership.role = 'owner'
        AND membership.ended_at IS NULL
       WHERE project.id = ?
       ${lock ? "FOR UPDATE OF project" : ""}`,
    )
    .get(userId, projectId);
  if (!project) return undefined;
  const deletionRequest = await database
    .prepare(
      `SELECT id, requested_by_user_id, requested_at, not_before,
              cancelled_by_user_id, cancelled_at
       FROM project_deletion_requests
       WHERE workspace_id = ? AND project_id = ? AND cancelled_at IS NULL
       ORDER BY requested_at DESC, id DESC LIMIT 1
       ${lock ? "FOR UPDATE" : ""}`,
    )
    .get(project.workspace_id, project.id);
  return {
    project,
    deletion_request: deletionRequest || null,
    preview_version: previewVersion(project, deletionRequest),
  };
}

export async function listArchivedProjects(database, userId: string) {
  if (typeof userId !== "string" || !userId) return [];
  return await database
    .prepare(
      `SELECT project.id, project.name, project.archived_at,
              project.updated_at
       FROM projects project
       JOIN project_memberships membership
         ON membership.workspace_id = project.workspace_id
        AND membership.project_id = project.id
        AND membership.user_id = ?
        AND membership.role = 'owner'
        AND membership.ended_at IS NULL
       WHERE project.archived_at IS NOT NULL
       ORDER BY project.archived_at DESC, project.id`,
    )
    .all(userId);
}

export async function getProjectLifecycle(database, input: { userId: string; projectId: string }) {
  return await ownerLifecycle(database, input.userId, input.projectId);
}

function assertPreview(view, expectedPreviewVersion: unknown) {
  if (String(expectedPreviewVersion || "") !== view.preview_version) {
    throw new ProjectLifecycleUserError(
      "The project lifecycle changed in another session. Reload before continuing.",
    );
  }
}

export async function archiveProject(
  database,
  input: { userId: string; projectId: string; expectedPreviewVersion: unknown },
) {
  return await database.transaction(async () => {
    const view = await ownerLifecycle(database, input.userId, input.projectId, true);
    if (!view) return undefined;
    assertPreview(view, input.expectedPreviewVersion);
    if (view.project.archived_at) {
      throw new ProjectLifecycleUserError("This project is already archived.");
    }
    const archivedAt = new Date().toISOString();
    await database
      .prepare(
        `UPDATE projects
         SET archived_at = ?, archived_by_user_id = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      )
      .run(archivedAt, input.userId, archivedAt, view.project.workspace_id, view.project.id);
    const revokedInvitations = await database
      .prepare(
        `UPDATE project_invitations
         SET revoked_by_user_id = ?, revoked_at = ?
         WHERE workspace_id = ? AND project_id = ?
           AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
      )
      .run(input.userId, archivedAt, view.project.workspace_id, view.project.id);
    const clearedTargets = await database
      .prepare(
        `DELETE FROM active_connection_targets
         WHERE project_workspace_id = ? AND project_id = ?`,
      )
      .run(view.project.workspace_id, view.project.id);
    await appendAuditEvent(database, {
      workspaceId: view.project.workspace_id,
      projectId: view.project.id,
      action: "project_archived",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: `project_archive_${randomUUID()}`,
      metadata: {
        revoked_invitation_count: revokedInvitations.changes,
        cleared_target_count: clearedTargets.changes,
      },
    });
    return { project_id: view.project.id, archived_at: archivedAt };
  });
}

export async function restoreProject(
  database,
  input: { userId: string; projectId: string; expectedPreviewVersion: unknown },
) {
  return await database.transaction(async () => {
    const view = await ownerLifecycle(database, input.userId, input.projectId, true);
    if (!view) return undefined;
    assertPreview(view, input.expectedPreviewVersion);
    if (!view.project.archived_at) {
      throw new ProjectLifecycleUserError("This project is already active.");
    }
    if (view.deletion_request) {
      throw new ProjectLifecycleUserError(
        "Cancel the permanent-deletion request before restoring this project.",
      );
    }
    const restoredAt = new Date().toISOString();
    await database
      .prepare(
        `UPDATE projects
         SET archived_at = NULL, archived_by_user_id = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND archived_at IS NOT NULL`,
      )
      .run(restoredAt, view.project.workspace_id, view.project.id);
    await appendAuditEvent(database, {
      workspaceId: view.project.workspace_id,
      projectId: view.project.id,
      action: "project_restored",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: `project_restore_${randomUUID()}`,
      metadata: {},
    });
    return { project_id: view.project.id, restored_at: restoredAt };
  });
}

export async function requestProjectDeletion(
  database,
  input: {
    userId: string;
    projectId: string;
    expectedPreviewVersion: unknown;
    confirmation: unknown;
  },
) {
  return await database.transaction(async () => {
    const view = await ownerLifecycle(database, input.userId, input.projectId, true);
    if (!view) return undefined;
    assertPreview(view, input.expectedPreviewVersion);
    if (!view.project.archived_at) {
      throw new ProjectLifecycleUserError("Archive this project before requesting deletion.");
    }
    if (view.deletion_request) {
      throw new ProjectLifecycleUserError("A permanent-deletion request is already pending.");
    }
    if (String(input.confirmation || "") !== view.project.name) {
      throw new ProjectLifecycleUserError("Enter the exact project name to request deletion.");
    }
    const requestedAt = new Date();
    const notBefore = new Date(requestedAt.getTime() + DELETION_COOLING_OFF_MILLISECONDS);
    const requestId = `project_deletion_${randomUUID()}`;
    await database
      .prepare(
        `INSERT INTO project_deletion_requests
          (id, workspace_id, project_id, requested_by_user_id, requested_at, not_before)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        view.project.workspace_id,
        view.project.id,
        input.userId,
        requestedAt.toISOString(),
        notBefore.toISOString(),
      );
    await appendAuditEvent(database, {
      workspaceId: view.project.workspace_id,
      projectId: view.project.id,
      action: "project_deletion_requested",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: requestId,
      metadata: { deletion_request_id: requestId, not_before: notBefore.toISOString() },
    });
    return {
      id: requestId,
      project_id: view.project.id,
      requested_at: requestedAt.toISOString(),
      not_before: notBefore.toISOString(),
    };
  });
}

export async function cancelProjectDeletion(
  database,
  input: { userId: string; projectId: string; expectedPreviewVersion: unknown },
) {
  return await database.transaction(async () => {
    const view = await ownerLifecycle(database, input.userId, input.projectId, true);
    if (!view) return undefined;
    assertPreview(view, input.expectedPreviewVersion);
    if (!view.deletion_request) {
      throw new ProjectLifecycleUserError("No permanent-deletion request is pending.");
    }
    const cancelledAt = new Date().toISOString();
    await database
      .prepare(
        `UPDATE project_deletion_requests
         SET cancelled_by_user_id = ?, cancelled_at = ?
         WHERE id = ? AND workspace_id = ? AND project_id = ? AND cancelled_at IS NULL`,
      )
      .run(
        input.userId,
        cancelledAt,
        view.deletion_request.id,
        view.project.workspace_id,
        view.project.id,
      );
    await appendAuditEvent(database, {
      workspaceId: view.project.workspace_id,
      projectId: view.project.id,
      action: "project_deletion_cancelled",
      actorType: "human_user",
      actorId: input.userId,
      correlationId: view.deletion_request.id,
      metadata: { deletion_request_id: view.deletion_request.id },
    });
    return { id: view.deletion_request.id, project_id: view.project.id, cancelled_at: cancelledAt };
  });
}

async function exportableContexts(database, view, userId: string) {
  return await database
    .prepare(
      `SELECT context.id, context.name, context.description, context.context_kind,
              context.visibility, context.created_by_user_id,
              context.created_at, context.updated_at, context.archived_at,
              context_grant.role AS granted_role
       FROM work_contexts context
       LEFT JOIN context_access_grants context_grant
         ON context_grant.workspace_id = context.workspace_id
        AND context_grant.project_id = context.project_id
        AND context_grant.context_id = context.id
        AND context_grant.user_id = ?
        AND context_grant.ended_at IS NULL
       WHERE context.workspace_id = ? AND context.project_id = ?
         AND context.archived_at IS NULL
         AND (
           context.context_kind = 'project_wide'
           OR context.visibility = 'all_members'
           OR context.created_by_user_id = ?
           OR (context.visibility = 'selected_members' AND context_grant.id IS NOT NULL)
         )
       ORDER BY context.context_kind, lower(context.name), context.id`,
    )
    .all(userId, view.project.workspace_id, view.project.id, userId);
}

async function exportContext(database, project, context) {
  const history = await database
    .prepare(
      `SELECT action, actor_user_id, safe_metadata_json, created_at
       FROM context_history_events
       WHERE workspace_id = ? AND project_id = ? AND context_id = ?
       ORDER BY created_at, id`,
    )
    .all(project.workspace_id, project.id, context.id);
  const candidates = await database
    .prepare(
      `SELECT candidate.id, candidate.evidence_id, candidate.state_key,
              candidate.value_json, candidate.summary, candidate.status, candidate.created_at
       FROM candidate_claims candidate
       JOIN candidate_context_targets target
         ON target.workspace_id = candidate.workspace_id
        AND target.project_id = candidate.project_id
        AND target.candidate_id = candidate.id
        AND target.context_id = ?
       WHERE candidate.workspace_id = ? AND candidate.project_id = ?
       ORDER BY candidate.created_at, candidate.id`,
    )
    .all(context.id, project.workspace_id, project.id);
  const evidenceIds = [...new Set(candidates.map(({ evidence_id: evidenceId }) => evidenceId))];
  const evidence: any[] = [];
  for (const evidenceId of evidenceIds) {
    const row = await database
      .prepare(
        `SELECT id, actor_type, client_classification,
                tool_name, payload_hash, created_at
         FROM evidence_events
         WHERE workspace_id = ? AND project_id = ? AND id = ?`,
      )
      .get(project.workspace_id, project.id, evidenceId);
    if (row) evidence.push(row);
  }
  const accepted = await database
    .prepare(
      `SELECT accepted.id, accepted.candidate_id, accepted.evidence_id,
              accepted.state_key, accepted.value_json, accepted.version, accepted.accepted_at,
              candidate.summary, exclusion.reason AS removal_reason,
              exclusion.removed_by_user_id, exclusion.removed_at
       FROM accepted_project_state accepted
       JOIN accepted_context_entries entry
         ON entry.workspace_id = accepted.workspace_id
        AND entry.project_id = accepted.project_id
        AND entry.accepted_state_id = accepted.id
        AND entry.context_id = ?
       JOIN candidate_claims candidate
         ON candidate.workspace_id = accepted.workspace_id
        AND candidate.project_id = accepted.project_id
        AND candidate.id = accepted.candidate_id
       LEFT JOIN context_entry_exclusions exclusion
         ON exclusion.workspace_id = accepted.workspace_id
        AND exclusion.project_id = accepted.project_id
        AND exclusion.accepted_state_id = accepted.id
       WHERE accepted.workspace_id = ? AND accepted.project_id = ?
       ORDER BY accepted.state_key, accepted.version, accepted.id`,
    )
    .all(context.id, project.workspace_id, project.id);
  const files = await database
    .prepare(
      `SELECT reference.id, reference.logical_file_id, reference.version,
              reference.display_name, reference.source_host, reference.uploader_user_id,
              reference.access_scope, reference.referenced_at,
              object.id AS file_object_id, object.content_sha256, object.byte_size,
              object.verified_media_type, object.scan_provider, object.scan_status,
              object.scan_updated_at, object.created_at AS object_created_at,
              exclusion.reason AS removal_reason, exclusion.removed_by_user_id,
              exclusion.removed_at
       FROM file_context_references reference
       JOIN file_objects object
         ON object.workspace_id = reference.workspace_id
        AND object.id = reference.file_object_id
       LEFT JOIN file_reference_exclusions exclusion
         ON exclusion.workspace_id = reference.workspace_id
        AND exclusion.project_id = reference.project_id
        AND exclusion.context_id = reference.context_id
        AND exclusion.file_reference_id = reference.id
       WHERE reference.workspace_id = ? AND reference.project_id = ?
         AND reference.context_id = ?
       ORDER BY reference.logical_file_id, reference.version, reference.id`,
    )
    .all(project.workspace_id, project.id, context.id);
  return {
    ...context,
    history: history.map((event) => ({
      action: event.action,
      actor_user_id: event.actor_user_id,
      safe_metadata: parseJson(event.safe_metadata_json),
      created_at: event.created_at,
    })),
    evidence,
    candidates: candidates.map(({ value_json: valueJson, ...candidate }) => ({
      ...candidate,
      value: parseJson(valueJson),
    })),
    accepted_state: accepted.map(({ value_json: valueJson, ...entry }) => ({
      ...entry,
      value: parseJson(valueJson),
    })),
    files,
  };
}

export async function exportProjectData(database, input: { userId: string; projectId: string }) {
  const view = await ownerLifecycle(database, input.userId, input.projectId);
  if (!view) return undefined;
  const contexts = await exportableContexts(database, view, input.userId);
  const exportedContexts: any[] = [];
  for (const context of contexts) {
    exportedContexts.push(await exportContext(database, view.project, context));
  }
  const members = await database
    .prepare(
      `SELECT membership.user_id, users.email, membership.role,
              membership.created_at, membership.updated_at, membership.ended_at
       FROM project_memberships membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.workspace_id = ? AND membership.project_id = ?
       ORDER BY membership.created_at, membership.id`,
    )
    .all(view.project.workspace_id, view.project.id);
  const invitations = await database
    .prepare(
      `SELECT email, role, expires_at, created_at, accepted_at, declined_at, revoked_at
       FROM project_invitations
       WHERE workspace_id = ? AND project_id = ?
       ORDER BY created_at, id`,
    )
    .all(view.project.workspace_id, view.project.id);
  const lifecycleEvents = await database
    .prepare(
      `SELECT action, actor_type, actor_id, created_at
       FROM audit_events
       WHERE workspace_id = ? AND project_id = ?
         AND action IN (
           'project_created', 'project_invitation_issued', 'project_invitation_accepted',
           'project_invitation_declined', 'project_invitation_revoked',
           'project_invitation_replaced', 'project_membership_role_changed',
           'project_member_removed', 'project_ownership_transferred', 'project_member_left',
           'project_archived', 'project_restored', 'project_deletion_requested',
           'project_deletion_cancelled'
         )
       ORDER BY created_at, id`,
    )
    .all(view.project.workspace_id, view.project.id);
  return {
    format: "alice.project-export",
    version: 1,
    exported_at: new Date().toISOString(),
    scope:
      "Owner export containing only contexts currently visible to the exporting owner. Inaccessible restricted contexts are omitted without names or counts.",
    project: Object.fromEntries(
      Object.entries(view.project).filter(([key]) => key !== "membership_id"),
    ),
    deletion_request: view.deletion_request,
    members,
    invitations,
    lifecycle_events: lifecycleEvents,
    contexts: exportedContexts,
  };
}
