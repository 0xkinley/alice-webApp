import express from "express";
import {
  ContextAccessUserError,
  endContextAccess,
  getContextAccessView,
  grantContextAccess,
  updateContextAccessRole,
} from "@alice/domain";
import { renderPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";

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
        '<h1>Restricted context not found</h1><p>It may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
        "neutral",
      ),
    );
}

function actionError(response, error) {
  const message =
    error instanceof ContextAccessUserError
      ? error.message
      : "Context access could not be changed. Nothing was modified.";
  return response
    .status(400)
    .type("html")
    .send(
      renderStatusPage(
        "Access not changed",
        `<h1>Access not changed</h1><p>${escapeHtml(message)}</p><p>No context permission was changed.</p><p><a href="/">Return to your private workspace</a></p>`,
        "danger",
      ),
    );
}

function roleOptions(member, selected = "viewer") {
  const roles = member.project_role === "viewer" ? ["viewer"] : ["viewer", "editor", "manager"];
  return roles
    .map(
      (role) =>
        `<option value="${role}"${role === selected ? " selected" : ""}>${role.charAt(0).toUpperCase()}${role.slice(1)}</option>`,
    )
    .join("");
}

export function createContextAccessRouter({ database }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/:projectId/contexts/:contextId/access", async (request, response) => {
    const view = await getContextAccessView(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId: request.params.contextId,
    });
    if (!view) return notFound(response);
    const members = view.members
      .map((member) => {
        const creator = member.user_id === view.context.created_by_user_id;
        let controls: string;
        if (creator) {
          controls = "<p><strong>Manager</strong> · context creator</p>";
        } else if (member.grant_id) {
          controls = `<form method="post" action="/projects/${encodeURIComponent(view.project.id)}/contexts/${encodeURIComponent(view.context.id)}/access/${encodeURIComponent(member.grant_id)}/role"><label>Context role<select name="role">${roleOptions(member, member.context_role)}</select></label><button type="submit">Update access</button></form><form method="post" action="/projects/${encodeURIComponent(view.project.id)}/contexts/${encodeURIComponent(view.context.id)}/access/${encodeURIComponent(member.grant_id)}/end"><button type="submit">End context access</button></form>`;
        } else {
          controls = `<form method="post" action="/projects/${encodeURIComponent(view.project.id)}/contexts/${encodeURIComponent(view.context.id)}/access"><input type="hidden" name="membership_id" value="${escapeHtml(member.membership_id)}"><label>Context role<select name="role">${roleOptions(member)}</select></label><button type="submit">Grant context access</button></form>`;
        }
        return `<article><h2>${escapeHtml(member.email)}</h2><p>Project role: ${escapeHtml(member.project_role)}</p>${controls}</article>`;
      })
      .join("");
    response
      .type("html")
      .send(
        renderPage(
          `Access · ${view.context.name}`,
          `<nav><a href="/projects/${encodeURIComponent(view.project.id)}">Back to project</a></nav><h1>${escapeHtml(view.context.name)} access</h1><p><strong>${escapeHtml(view.project.name)}</strong></p><p>This context is restricted to explicitly selected members. Project Owners cannot read it unless they created it or receive a grant here.</p><h2>Project members</h2>${members}`,
        ),
      );
  });

  router.post("/:projectId/contexts/:contextId/access", async (request, response) => {
    try {
      const granted = await grantContextAccess(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        contextId: request.params.contextId,
        membershipId: String(request.body.membership_id || ""),
        role: request.body.role,
      });
      if (!granted) return notFound(response);
      response.redirect(
        303,
        `/projects/${encodeURIComponent(request.params.projectId)}/contexts/${encodeURIComponent(request.params.contextId)}/access`,
      );
    } catch (error) {
      return actionError(response, error);
    }
  });

  router.post("/:projectId/contexts/:contextId/access/:grantId/role", async (request, response) => {
    try {
      const updated = await updateContextAccessRole(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        contextId: request.params.contextId,
        grantId: request.params.grantId,
        role: request.body.role,
      });
      if (!updated) return notFound(response);
      response.redirect(
        303,
        `/projects/${encodeURIComponent(request.params.projectId)}/contexts/${encodeURIComponent(request.params.contextId)}/access`,
      );
    } catch (error) {
      return actionError(response, error);
    }
  });

  router.post("/:projectId/contexts/:contextId/access/:grantId/end", async (request, response) => {
    try {
      const ended = await endContextAccess(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        contextId: request.params.contextId,
        grantId: request.params.grantId,
      });
      if (!ended) return notFound(response);
      response.redirect(
        303,
        `/projects/${encodeURIComponent(request.params.projectId)}/contexts/${encodeURIComponent(request.params.contextId)}/access`,
      );
    } catch (error) {
      return actionError(response, error);
    }
  });

  return router;
}
