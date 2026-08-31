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
  const exportControl = `<p><a href="/projects/${projectId}/export.json">Download permission-filtered JSON export</a></p><p class="muted">The export includes only contexts visible to your Owner account. It omits inaccessible restricted contexts without revealing their names or counts, object-storage locations, credentials, and signed URLs.</p>`;
  if (!view.project.archived_at) {
    return `<nav><a href="/projects/${projectId}">Back to project</a></nav><header class="hero"><p class="eyebrow">Project lifecycle</p><h1>${escapeHtml(view.project.name)}</h1><p><span class="badge">Status: active</span></p></header>${exportControl}<section><h2>Archive project</h2><p class="notice warning">Archiving is reversible. It hides the project from ordinary project, context, review, file, and AI-connection use; revokes pending invitations; and clears active AI-connection targets. It does not erase project data, history, file objects, security receipts, or backups.</p><form method="post" action="/projects/${projectId}/archive"><input type="hidden" name="expected_preview_version" value="${preview}"><button class="destructive" type="submit">Archive project</button></form></section>`;
  }
  if (view.deletion_request) {
    return `<nav><a href="/">Private workspace</a></nav><header class="hero"><p class="eyebrow">Project lifecycle</p><h1>${escapeHtml(view.project.name)}</h1><p><span class="badge">Status: archived; permanent-deletion request pending</span></p></header><p class="notice warning">Requested ${escapeHtml(view.deletion_request.requested_at)}. The cooling-off period ends ${escapeHtml(view.deletion_request.not_before)}.</p><p class="notice danger"><strong>The project has not been permanently deleted.</strong> Its PostgreSQL rows, file-object versions, security receipts, and provider backups remain present. A separately authorized operator workflow and verified retention policy are still required for erasure.</p>${exportControl}<form method="post" action="/projects/${projectId}/deletion-request/cancel"><input type="hidden" name="expected_preview_version" value="${preview}"><button type="submit">Cancel deletion request</button></form>`;
  }
  return `<nav><a href="/">Private workspace</a></nav><header class="hero"><p class="eyebrow">Project lifecycle</p><h1>${escapeHtml(view.project.name)}</h1><p><span class="badge">Status: archived</span></p></header><p class="notice">Archived data remains stored and available for this Owner lifecycle view and permission-filtered export. It is unavailable through ordinary project and AI-connection paths.</p>${exportControl}<section><h2>Restore project</h2><p>Restoring makes the project available through ordinary authorized paths again. Revoked invitations are not reactivated and cleared AI-connection targets are not restored.</p><form method="post" action="/projects/${projectId}/restore"><input type="hidden" name="expected_preview_version" value="${preview}"><button type="submit">Restore project</button></form></section><section><h2>Request permanent deletion</h2><p class="notice danger">This creates a cancellable request with a seven-day cooling-off period. It does not erase any data and does not promise a backup-deletion date. Permanent erasure remains unavailable until the privileged operator path and provider retention behavior are verified.</p><form method="post" action="/projects/${projectId}/deletion-request"><input type="hidden" name="expected_preview_version" value="${preview}"><label>Enter the exact project name<input name="confirmation" autocomplete="off" required></label><button class="destructive" type="submit">Request permanent deletion</button></form></section>`;
}

export function createProjectLifecycleRouter({ database }) {
  const router = express.Router();

  router.get(
    "/projects/:projectId/lifecycle",
    requireAuthenticatedUser(database),
    async (request, response) => {
      const view = await getProjectLifecycle(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
      });
      if (!view) return notFound(response);
      response.type("html").send(renderPage(`${view.project.name} lifecycle`, lifecyclePage(view)));
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

  const lifecycleAction = (operation) => async (request, response) => {
    try {
      const result = await operation(request);
      if (!result) return notFound(response);
      response.redirect(303, `/projects/${encodeURIComponent(request.params.projectId)}/lifecycle`);
    } catch (error) {
      return actionError(response, error);
    }
  };

  router.post(
    "/projects/:projectId/archive",
    requireAuthenticatedUser(database),
    lifecycleAction((request) =>
      archiveProject(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        expectedPreviewVersion: request.body.expected_preview_version,
      }),
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
