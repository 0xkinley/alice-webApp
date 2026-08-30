import express from "express";
import {
  acceptProjectInvitation,
  createProjectInvitation,
  declineProjectInvitation,
  getProjectCollaborators,
  getProjectInvitationPreview,
  getProjectMembershipView,
  leaveProject,
  ProjectMembershipUserError,
  removeProjectMember,
  resendProjectInvitation,
  revokeProjectInvitation,
  transferProjectOwnership,
  updateProjectMemberRole,
} from "@alice/domain";
import { authenticatedUser, renderPage, requireAuthenticatedUser } from "./auth.ts";

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
    .send(renderPage("Not found", "<h1>Project or invitation not found</h1>"));
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
      renderPage(
        "Action not completed",
        `<h1>Action not completed</h1><p>${escapeHtml(message)}</p>`,
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

export function createProjectMembershipRouter({ database, publicUrl }) {
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
      const members = view.members
        .map((member) => {
          const isCurrentUser = member.user_id === request.aliceUser!.id;
          const controls =
            member.role === "owner"
              ? ""
              : `<form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/collaborators/${encodeURIComponent(member.id)}/role"><label>Project role<select name="role"><option value="editor"${member.role === "editor" ? " selected" : ""}>Editor</option><option value="viewer"${member.role === "viewer" ? " selected" : ""}>Viewer</option></select></label><button type="submit">Update role</button></form><form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/collaborators/${encodeURIComponent(member.id)}/transfer-ownership"><button type="submit">Transfer ownership to this member</button></form><form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/collaborators/${encodeURIComponent(member.id)}/remove"><button type="submit">Remove access</button></form>`;
          return `<article><h3>${escapeHtml(member.email)}${isCurrentUser ? " (you)" : ""}</h3><p>${escapeHtml(member.role)}</p>${controls}</article>`;
        })
        .join("");
      const invitations = view.invitations
        .map((invitation) => {
          const status = invitationStatus(invitation);
          const controls =
            status === "Pending" || status === "Expired"
              ? `<div class="actions">${status === "Pending" ? `<form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/invitations/${encodeURIComponent(invitation.id)}/revoke"><button type="submit">Revoke</button></form>` : ""}<form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/invitations/${encodeURIComponent(invitation.id)}/resend"><button type="submit">Create replacement link</button></form></div>`
              : "";
          return `<article><h3>${escapeHtml(invitation.email)}</h3><p>${escapeHtml(invitation.role)} · ${status}</p><p class="muted">Expires ${escapeHtml(new Date(Number(invitation.expires_at) * 1_000).toISOString())}</p>${controls}</article>`;
        })
        .join("");
      response
        .type("html")
        .send(
          renderPage(
            `Collaborators · ${view.project.name}`,
            `<nav><a href="/projects/${encodeURIComponent(view.project.project_id)}">Back to project</a></nav><h1>Collaborators</h1><p><strong>${escapeHtml(view.project.name)}</strong></p><p>Owners administer project access. Editors can change permitted contexts; Viewers can read permitted contexts. Context visibility is enforced separately and never broadens because of a project role.</p><h2>People with access</h2>${members}<h2>Invite a collaborator</h2><form method="post" action="/projects/${encodeURIComponent(view.project.project_id)}/invitations"><label>Email<input type="email" name="email" maxlength="254" required></label><label>Project role<select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label><button type="submit">Create private invitation link</button></form><p class="muted">alice. does not send email in this local foundation. Deliver the one-time link privately to the exact recipient.</p><h2>Invitation history</h2>${invitations || "<p>No project invitations yet.</p>"}<h2>Ownership safety</h2><p>Ownership transfer is atomic: the selected member becomes Owner before your role changes to Editor. Restricted and personal context visibility is not broadened by transfer.</p>`,
          ),
        );
    },
  );

  router.get(
    "/projects/:projectId/access",
    requireAuthenticatedUser(database),
    async (request, response) => {
      const membership = await getProjectMembershipView(
        database,
        request.aliceUser!.id,
        request.params.projectId,
      );
      if (!membership) return notFound(response);
      const ownerLinks =
        membership.role === "owner"
          ? ` · <a href="/projects/${encodeURIComponent(membership.project_id)}/collaborators">Manage collaborators</a>`
          : "";
      const leaveControl =
        membership.role === "owner"
          ? "<p>Transfer ownership before leaving this project.</p>"
          : `<form method="post" action="/projects/${encodeURIComponent(membership.project_id)}/leave"><button type="submit">Leave project</button></form>`;
      response
        .type("html")
        .send(
          renderPage(
            `Project access · ${membership.name}`,
            `<nav><a href="/">Projects</a></nav><h1>${escapeHtml(membership.name)}</h1><p>${escapeHtml(membership.brief)}</p><p><a href="/projects/${encodeURIComponent(membership.project_id)}">Open project</a>${ownerLinks}</p><article><h2>Your project access</h2><p>${escapeHtml(membership.role)}</p><p>Project membership does not reveal a restricted context. Context-level access is checked separately.</p>${leaveControl}</article>`,
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
            renderPage(
              "Project invitation created",
              `<nav><a href="/projects/${encodeURIComponent(invitation.project_id)}/collaborators">Back to collaborators</a></nav><h1>Private invitation link created</h1><p>Share this link only with <strong>${escapeHtml(invitation.email)}</strong>. It grants ${escapeHtml(invitation.role)} access after that exact alice. account accepts.</p><pre>${escapeHtml(link)}</pre><p>This is the only time alice. displays this token. Only its hash is stored.</p>`,
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
            renderPage(
              "Replacement invitation created",
              `<nav><a href="/projects/${encodeURIComponent(invitation.project_id)}/collaborators">Back to collaborators</a></nav><h1>Replacement invitation link</h1><p>The previous link is revoked. Share this new link only with <strong>${escapeHtml(invitation.email)}</strong>.</p><pre>${escapeHtml(invitationLink(publicUrl, invitation.token))}</pre><p>Only the new token hash is stored.</p>`,
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
          renderPage(
            `Project invitation · ${invitation.project_name}`,
            `<nav><a href="/">Projects</a></nav><h1>Project invitation</h1><article><h2>${escapeHtml(invitation.project_name)}</h2><p>${escapeHtml(invitation.project_brief)}</p><p>Role: <strong>${escapeHtml(invitation.role)}</strong></p></article><p>Accepting grants project membership to this signed-in email. It does not share your AI connections, and restricted contexts still require separate context access.</p><div class="actions"><form method="post" action="/project-invitations/${encodeURIComponent(request.params.token)}/accept"><button type="submit">Accept invitation</button></form><form method="post" action="/project-invitations/${encodeURIComponent(request.params.token)}/decline"><button type="submit">Decline</button></form></div>`,
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
