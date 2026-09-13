import express from "express";
import {
  acceptProjectInvitation,
  createProjectInvitation,
  declineProjectInvitation,
  getProjectCollaborators,
  getProjectInvitationPreview,
  getProjectAccessOverview,
  leaveProject,
  ProjectMembershipUserError,
  removeProjectMember,
  resendProjectInvitation,
  revokeProjectInvitation,
  transferProjectOwnership,
  updateProjectMemberRole,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import {
  authenticatedUser,
  renderAppPage,
  renderPage,
  renderStatusPage,
  requireAuthenticatedUser,
} from "./auth.ts";
import { hostLabel, localTimestamp, roleLabel } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function notFound(response) {
  return response
    .status(404)
    .type("html")
    .send(
      renderStatusPage(
        "Not found",
        '<h1>Project or invitation not found</h1><p>It may be unavailable, expired, or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
        "neutral",
      ),
    );
}

function actionError(response, error) {
  const message =
    error instanceof ProjectMembershipUserError
      ? error.message
      : "The action could not be completed. Nothing was changed.";
  return response
    .status(400)
    .type("html")
    .send(
      renderStatusPage(
        "Action not completed",
        `<h1>Action not completed</h1><p>${escapeHtml(message)}</p><p>Project access was not changed.</p><p><a href="/">Return to your private workspace</a></p>`,
        "danger",
      ),
    );
}

function invitationStatus(invitation) {
  if (invitation.accepted_at) return "Accepted";
  if (invitation.declined_at) return "Declined";
  if (invitation.revoked_at) return "Revoked";
  if (Number(invitation.expires_at) <= Math.floor(Date.now() / 1_000)) return "Expired";
  return "Pending";
}

function invitationLink(publicUrl, token) {
  return new URL(`/project-invitations/${encodeURIComponent(token)}`, publicUrl).href;
}

function requireInvitationRecipient(database) {
  return async (request, response, next) => {
    const user = await authenticatedUser(database, request);
    if (!user) {
      return response
        .status(401)
        .type("html")
        .send(
          renderPage(
            "Sign in before opening this invitation",
            '<h1>Sign in first</h1><p>For safety, alice. will not copy this invitation credential into a sign-in redirect. Sign in, then reopen the original private invitation link.</p><p><a href="/auth/login">Sign in to alice.</a></p>',
          ),
        );
    }
    request.aliceUser = user;
    next();
  };
}

export function createProjectMembershipRouter({
  database,
  publicUrl,
  fileStore,
}: {
  database: any;
  publicUrl: string;
  fileStore?: PrivateFileStore | undefined;
}) {
  const router = express.Router();

  router.get(
    "/projects/:projectId/collaborators",
    requireAuthenticatedUser(database),
    async (request, response) => {
      const view = await getProjectCollaborators(
        database,
        request.aliceUser!.id,
        request.params.projectId,
      );
      if (!view) return notFound(response);
      const shell = await getProjectShell(
        database,
        request.aliceUser!.id,
        request.params.projectId,
      );
      if (!shell) return notFound(response);
      const members = view.members
        .map((member) => {
          const isCurrentUser = member.user_id === request.aliceUser!.id;
          const controls =
            member.role === "owner"
              ? ""
              : `<form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/collaborators/${encodeURIComponent(member.id)}/role"><label>Project role<select name="role"><option value="editor"${member.role === "editor" ? " selected" : ""}>Editor</option><option value="viewer"${member.role === "viewer" ? " selected" : ""}>Viewer</option></select></label><button type="submit">Update role</button></form><form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/collaborators/${encodeURIComponent(member.id)}/transfer-ownership"><button type="submit">Transfer ownership to this member</button></form><form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/collaborators/${encodeURIComponent(member.id)}/remove"><button type="submit">Remove access</button></form>`;
          return `<article><h3>${escapeHtml(member.email)}${isCurrentUser ? " (you)" : ""}</h3><p>${escapeHtml(roleLabel(member.role))}</p>${controls}</article>`;
        })
        .join("");
      const invitations = view.invitations
        .map((invitation) => {
          const status = invitationStatus(invitation);
          const controls =
            status === "Pending" || status === "Expired"
              ? `<div class="actions">${status === "Pending" ? `<form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/invitations/${encodeURIComponent(invitation.id)}/revoke"><button type="submit">Revoke</button></form>` : ""}<form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/invitations/${encodeURIComponent(invitation.id)}/resend"><button type="submit">Create replacement link</button></form></div>`
              : "";
          return `<article><h3>${escapeHtml(invitation.email)}</h3><p>${escapeHtml(roleLabel(invitation.role))} · ${status}</p><p class="muted">Expires ${localTimestamp(new Date(Number(invitation.expires_at) * 1_000))}</p>${controls}</article>`;
        })
        .join("");
      response
        .type("html")
        .send(
          renderAppPage(
            `Collaborators · ${view.project.name}`,
            `<div class="project-home">${renderProjectShell({ shell, fileStore })}<section><div class="section-heading"><div><p class="eyebrow">Project settings</p><h2>Collaborators</h2></div></div><p>Owners manage who can open and work in this project. Editors can add and update project information; Viewers can read it.</p><h3>People with access</h3>${members}<h3>Invite a collaborator</h3><form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/invitations"><label>Email<input type="email" name="email" maxlength="254" required></label><label>Project role<select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label><button type="submit">Create private invitation link</button></form><p class="muted">alice. does not send email in this local foundation. Deliver the one-time link privately to the exact recipient.</p><h3>Invitation history</h3>${invitations || "<p>No project invitations yet.</p>"}<h3>Ownership safety</h3><p>Ownership transfer is atomic: the selected member becomes Owner before your role changes to Editor.</p></section></div>`,
            { email: request.aliceUser!.email, activeSection: "projects" },
          ),
        );
    },
  );

  router.get(
    "/projects/:projectId/access",
    requireAuthenticatedUser(database),
    async (request, response) => {
      const view = await getProjectAccessOverview(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
      });
      if (!view) return notFound(response);
      const membership = view.project;
      const shell = await getProjectShell(database, request.aliceUser!.id, membership.id);
      if (!shell) return notFound(response);
      const ownerLinks =
        membership.current_user_role === "owner"
          ? ` · <a href="/projects/${encodeURIComponent(membership.id)}/collaborators">Manage collaborators</a>`
          : "";
      const leaveControl =
        membership.current_user_role === "owner"
          ? "<p>Transfer ownership before leaving this project.</p>"
          : `<form method="post" action="/projects/${encodeURIComponent(membership.id)}/leave"><button type="submit">Leave project</button></form>`;
      const members = view.members
        .map(
          (member) =>
            `<li>${escapeHtml(member.email)}${member.user_id === request.aliceUser!.id ? " (you)" : ""} · ${escapeHtml(roleLabel(member.role))}</li>`,
        )
        .join("");
      const connections = view.connections
        .map((connection) => {
          const projectStatus = connection.targets_this_project
            ? "Active for this project"
            : "Not active for this project";
          return `<article><h3>${escapeHtml(connection.client_name)}</h3><p>Connected · ${escapeHtml(hostLabel(connection.client_classification))}</p><p><strong>${projectStatus}</strong></p><p class="muted">Last used ${localTimestamp(connection.last_used_at)}</p></article>`;
        })
        .join("");
      const events = view.security_events
        .map(
          (event) =>
            `<li><strong>${escapeHtml(event.label)}</strong> · ${escapeHtml(event.actor_label)} · <span class="muted">${localTimestamp(event.created_at)}</span></li>`,
        )
        .join("");
      response
        .type("html")
        .send(
          renderAppPage(
            `Project access · ${membership.name}`,
            `<div class="project-home">${renderProjectShell({ shell, fileStore })}<section><div class="section-heading"><div><p class="eyebrow">Project settings</p><h2>Your access</h2></div></div><p>You have <strong>${escapeHtml(roleLabel(membership.current_user_role))}</strong> access to this project${ownerLinks}.</p><h3>People with project access</h3><ul>${members}</ul>${leaveControl}</section><section><h2>Your AI connections</h2><p>${escapeHtml(view.privacy.connection_scope)} Collaborators never inherit your credentials or permissions.</p>${connections || "<p>No active AI connection is attached to your account.</p>"}<p><a href="/connections">Review or revoke AI connections</a></p></section><section><h2>Recent security activity</h2><p>Security history shows the action, who performed it, and when it happened. Stored technical metadata is not displayed.</p><ul>${events || "<li>No relevant security action has been recorded.</li>"}</ul></section></div>`,
            { email: request.aliceUser!.email, activeSection: "projects" },
          ),
        );
    },
  );

  router.post(
    "/projects/:projectId/invitations",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const invitation = await createProjectInvitation(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          email: request.body.email,
          role: request.body.role,
        });
        if (!invitation) return notFound(response);
        const link = invitationLink(publicUrl, invitation.token);
        response
          .type("html")
          .send(
            renderAppPage(
              "Project invitation created",
              `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Collaborator invitation</p><h1>Private invitation link created</h1><p>Share this link only with <strong>${escapeHtml(invitation.email)}</strong>. It grants ${escapeHtml(roleLabel(invitation.role))} access after that exact alice. account accepts.</p></div></header><section><pre>${escapeHtml(link)}</pre><p>This is the only time alice. displays this token. Only its hash is stored.</p><p><a href="/projects/${encodeURIComponent(invitation.project_id)}/collaborators">Back to collaborators</a></p></section></div>`,
              { email: request.aliceUser!.email, activeSection: "projects" },
            ),
          );
      } catch (error) {
        return actionError(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/invitations/:invitationId/revoke",
    requireAuthenticatedUser(database),
    async (request, response) => {
      const revoked = await revokeProjectInvitation(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        invitationId: request.params.invitationId,
      });
      if (!revoked) return notFound(response);
      response.redirect(
        303,
        `/projects/${encodeURIComponent(request.params.projectId)}/collaborators`,
      );
    },
  );

  router.post(
    "/projects/:projectId/invitations/:invitationId/resend",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const invitation = await resendProjectInvitation(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          invitationId: request.params.invitationId,
        });
        if (!invitation) return notFound(response);
        response
          .type("html")
          .send(
            renderAppPage(
              "Replacement invitation created",
              `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Collaborator invitation</p><h1>Replacement invitation link</h1><p>The previous link is revoked. Share this new link only with <strong>${escapeHtml(invitation.email)}</strong>.</p></div></header><section><pre>${escapeHtml(invitationLink(publicUrl, invitation.token))}</pre><p>Only the new token hash is stored.</p><p><a href="/projects/${encodeURIComponent(invitation.project_id)}/collaborators">Back to collaborators</a></p></section></div>`,
              { email: request.aliceUser!.email, activeSection: "projects" },
            ),
          );
      } catch (error) {
        return actionError(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/collaborators/:membershipId/role",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const updated = await updateProjectMemberRole(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          membershipId: request.params.membershipId,
          role: request.body.role,
        });
        if (!updated) return notFound(response);
        response.redirect(
          303,
          `/projects/${encodeURIComponent(request.params.projectId)}/collaborators`,
        );
      } catch (error) {
        return actionError(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/collaborators/:membershipId/transfer-ownership",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const transferred = await transferProjectOwnership(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          membershipId: request.params.membershipId,
        });
        if (!transferred) return notFound(response);
        response.redirect(303, `/projects/${encodeURIComponent(request.params.projectId)}/access`);
      } catch (error) {
        return actionError(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/collaborators/:membershipId/remove",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const removed = await removeProjectMember(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          membershipId: request.params.membershipId,
        });
        if (!removed) return notFound(response);
        response.redirect(
          303,
          `/projects/${encodeURIComponent(request.params.projectId)}/collaborators`,
        );
      } catch (error) {
        return actionError(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/leave",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const left = await leaveProject(database, request.aliceUser!.id, request.params.projectId);
        if (!left) return notFound(response);
        response.redirect(303, "/");
      } catch (error) {
        return actionError(response, error);
      }
    },
  );

  router.get(
    "/project-invitations/:token",
    requireInvitationRecipient(database),
    async (request, response) => {
      const invitation = await getProjectInvitationPreview(
        database,
        request.aliceUser!.id,
        request.params.token,
      );
      if (!invitation) return notFound(response);
      response
        .type("html")
        .send(
          renderAppPage(
            `Project invitation · ${invitation.project_name}`,
            `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Project invitation</p><h1>${escapeHtml(invitation.project_name)}</h1><p>You were invited as a <strong>${escapeHtml(roleLabel(invitation.role))}</strong>.</p></div></header><section><p>Accepting gives this signed-in account access to the project. It never shares your personal AI connections.</p><div class="actions"><form method="post" action="/project-invitations/${encodeURIComponent(request.params.token)}/accept"><button type="submit">Accept invitation</button></form><form method="post" action="/project-invitations/${encodeURIComponent(request.params.token)}/decline"><button type="submit">Decline</button></form></div></section></div>`,
            { email: request.aliceUser!.email, activeSection: "shared" },
          ),
        );
    },
  );

  router.post(
    "/project-invitations/:token/accept",
    requireInvitationRecipient(database),
    async (request, response) => {
      try {
        const accepted = await acceptProjectInvitation(
          database,
          request.aliceUser!.id,
          request.params.token,
        );
        if (!accepted) return notFound(response);
        response.redirect(303, `/projects/${encodeURIComponent(accepted.project_id)}/access`);
      } catch (error) {
        return actionError(response, error);
      }
    },
  );

  router.post(
    "/project-invitations/:token/decline",
    requireInvitationRecipient(database),
    async (request, response) => {
      const declined = await declineProjectInvitation(
        database,
        request.aliceUser!.id,
        request.params.token,
      );
      if (!declined) return notFound(response);
      response.redirect(303, "/");
    },
  );

  return router;
}
