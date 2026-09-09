import express from "express";
import {
  ContextAccessUserError,
  endContextAccess,
  getContextAccessView,
  grantContextAccess,
  updateContextAccessRole,
} from "@alice/domain";
import { renderStatusPage, requireAuthenticatedUser } from "./auth.ts";

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
    response.redirect(303, `/projects/${encodeURIComponent(view.project.id)}/access`);
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
