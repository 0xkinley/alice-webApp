import express from "express";
import {
  archiveProject,
  cancelProjectDeletion,
  exportProjectData,
  getProjectLifecycle,
  ProjectLifecycleUserError,
  requestProjectDeletion,
  restoreProject,
} from "@alice/domain";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { timestampLabel } from "./product-copy.ts";

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
        '<h1>Project not found</h1><p>The project may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
        "neutral",
      ),
    );
}

function actionError(response, error) {
  const message =
    error instanceof ProjectLifecycleUserError
      ? error.message
      : "The lifecycle action could not be completed. Nothing was changed.";
  return response
    .status(error instanceof ProjectLifecycleUserError ? 409 : 400)
    .type("html")
    .send(
      renderStatusPage(
        "Action not completed",
        `<h1>Action not completed</h1><p>${escapeHtml(message)}</p><p>No lifecycle state was changed.</p><p><a href="/">Return to your private workspace</a></p>`,
        "danger",
      ),
    );
}

function lifecyclePage(view) {
  const projectId = encodeURIComponent(view.project.id);
  const preview = escapeHtml(view.preview_version);
  const exportControl = `<p><a href="/projects/${projectId}/export.json">Download project data</a></p><p class="muted">The export includes the project information visible to your account. It omits storage locations, credentials, and signed URLs.</p>`;
  if (view.deletion_request) {
    return `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Archived project</p><h1>${escapeHtml(view.project.name)}</h1><p>Permanent-deletion request pending</p></div></header><section><p class="notice warning">Requested ${escapeHtml(timestampLabel(view.deletion_request.requested_at))}. The cooling-off period ends ${escapeHtml(timestampLabel(view.deletion_request.not_before))}.</p><p class="notice danger"><strong>The project has not been permanently deleted.</strong> Its project information, file versions, security receipts, and provider backups remain present. A separately authorized operator workflow and verified retention policy are still required for erasure.</p>${exportControl}<form method="post" action="/projects/${projectId}/deletion-request/cancel"><input type="hidden" name="expected_preview_version" value="${preview}"><button type="submit">Cancel deletion request</button></form></section></div>`;
  }
  return `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Archived project</p><h1>${escapeHtml(view.project.name)}</h1><p>This project is retained until you restore it or complete the separate deletion process.</p></div></header><section><p class="notice">The archived project remains available here for restore or export. It is unavailable through ordinary project and AI-connection paths.</p>${exportControl}</section><section><h2>Restore project</h2><p>Restoring makes the project available through ordinary authorized paths again. Revoked invitations and cleared AI-connection targets are not restored.</p><form method="post" action="/projects/${projectId}/restore"><input type="hidden" name="expected_preview_version" value="${preview}"><button type="submit">Restore project</button></form></section><section><h2>Request permanent deletion</h2><p class="notice danger">This creates a cancellable request with a seven-day cooling-off period. It does not erase any data or promise a backup-deletion date.</p><form method="post" action="/projects/${projectId}/deletion-request"><input type="hidden" name="expected_preview_version" value="${preview}"><label>Enter the exact project name<input name="confirmation" autocomplete="off" required></label><button class="destructive" type="submit">Request permanent deletion</button></form></section></div>`;
}

export function createProjectLifecycleRouter({ database }) {
  const router = express.Router();

  router.get(
    ["/projects/:projectId/archive", "/projects/:projectId/lifecycle"],
    requireAuthenticatedUser(database),
    async (request, response) => {
      const view = await getProjectLifecycle(database, {
        userId: request.aliceUser!.id,
        projectId: String(request.params.projectId),
      });
      if (!view) return notFound(response);
      if (!view.project.archived_at) {
        return response.redirect(303, `/projects/${encodeURIComponent(view.project.id)}`);
      }
      response.type("html").send(
        renderAppPage(`${view.project.name} archive`, lifecyclePage(view), {
          email: request.aliceUser!.email,
          activeSection: "archived",
        }),
      );
    },
  );

  router.get(
    "/projects/:projectId/export.json",
    requireAuthenticatedUser(database),
    async (request, response) => {
      const exported = await exportProjectData(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
      });
      if (!exported) return notFound(response);
      const safeId = String(exported.project.id).replaceAll(/[^a-zA-Z0-9_-]/g, "_");
      response
        .status(200)
        .set({
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="alice-project-${safeId}.json"`,
        })
        .type("application/json")
        .send(`${JSON.stringify(exported, null, 2)}\n`);
    },
  );

  const lifecycleAction =
    (
      operation,
      resultLocation = (request) =>
        `/projects/${encodeURIComponent(request.params.projectId)}/archive`,
    ) =>
    async (request, response) => {
      try {
        const result = await operation(request);
        if (!result) return notFound(response);
        response.redirect(303, resultLocation(request));
      } catch (error) {
        return actionError(response, error);
      }
    };

  router.post(
    "/projects/:projectId/archive",
    requireAuthenticatedUser(database),
    lifecycleAction(
      (request) =>
        archiveProject(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          expectedPreviewVersion: request.body.expected_preview_version,
        }),
      () => "/archived",
    ),
  );
  router.post(
    "/projects/:projectId/restore",
    requireAuthenticatedUser(database),
    lifecycleAction((request) =>
      restoreProject(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        expectedPreviewVersion: request.body.expected_preview_version,
      }),
    ),
  );
  router.post(
    "/projects/:projectId/deletion-request",
    requireAuthenticatedUser(database),
    lifecycleAction((request) =>
      requestProjectDeletion(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        expectedPreviewVersion: request.body.expected_preview_version,
        confirmation: request.body.confirmation,
      }),
    ),
  );
  router.post(
    "/projects/:projectId/deletion-request/cancel",
    requireAuthenticatedUser(database),
    lifecycleAction((request) =>
      cancelProjectDeletion(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        expectedPreviewVersion: request.body.expected_preview_version,
      }),
    ),
  );

  return router;
}
