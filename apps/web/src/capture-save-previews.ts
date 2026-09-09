import {
  CaptureSavePreviewUserError,
  commitCaptureSavePreview,
  getCaptureSavePreview,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import express from "express";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { escapeHtml, readableLabel, readableText, renderReadableValue } from "./human-readable.ts";
import { timestampLabel } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";

function previewPage(preview) {
  const claims = preview.payload.candidate_claims
    .map(
      (claim) =>
        `<article><h2>${escapeHtml(readableLabel(claim.state_key))}</h2><p>${escapeHtml(readableText(claim.summary))}</p><div class="readable-value">${renderReadableValue(claim.value)}</div>${
          claim.current_saved
            ? `<aside class="notice warning"><strong>Replaces the current saved revision</strong>${renderReadableValue(claim.current_saved.value)}</aside>`
            : '<p class="muted">Creates new project information.</p>'
        }</article>`,
    )
    .join("");
  const source = preview.payload.source_context || preview.payload.source_note;
  const action = preview.expired
    ? '<p class="notice warning"><strong>This Save preview expired.</strong> Ask the host for a new exact preview. Nothing was saved.</p>'
    : `<form method="post" action="/save-previews/${encodeURIComponent(preview.preview_id)}"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><button type="submit">Save</button></form>`;
  return `<section><div class="section-heading"><div><p class="eyebrow">Exact Save preview</p><h2>Save this to ${escapeHtml(preview.destination.project_name)}?</h2></div></div><p>Only your authenticated Save action can accept this project information. Closing this page does nothing.</p><dl><dt>Project</dt><dd>${escapeHtml(preview.destination.project_name)}</dd><dt>Expires</dt><dd>${escapeHtml(timestampLabel(preview.expires_at))}</dd></dl><h3>${escapeHtml(readableText(preview.payload.summary))}</h3>${claims}${source ? `<details><summary>Supporting information</summary><p>${escapeHtml(readableText(source))}</p></details>` : ""}${action}<p class="muted">Before Save, this is short-lived preview state only. There is no proposed or saved project information.</p></section>`;
}

export function createCaptureSavePreviewsRouter({
  database,
  fileStore,
  publicUrl,
}: {
  database: unknown;
  fileStore?: PrivateFileStore | undefined;
  publicUrl: string;
}) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/:previewId", async (request, response) => {
    const preview = await getCaptureSavePreview(database, {
      previewId: request.params.previewId,
      userId: request.aliceUser!.id,
    });
    if (!preview) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Save preview not found",
            '<h1>Save preview not found</h1><p>It may be unavailable, expired, or belong to another alice. account or project. Nothing was saved.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    const shell = await getProjectShell(
      database,
      request.aliceUser!.id,
      preview.destination.project_id,
    );
    if (!shell) return response.status(404).end();
    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        renderAppPage(
          `Save to ${preview.destination.project_name}`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "changes" })}${previewPage(preview)}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });

  router.post("/:previewId", async (request, response) => {
    try {
      const result = await commitCaptureSavePreview(database, {
        previewId: request.params.previewId,
        previewVersion: String(request.body.preview_version || ""),
        userId: request.aliceUser!.id,
        authority: "web_session",
        publicUrl,
      });
      if (!result) {
        return response
          .status(404)
          .type("html")
          .send(
            renderStatusPage(
              "Save preview not found",
              '<h1>Save preview not found</h1><p>Nothing was saved.</p><p><a href="/">Return to your private workspace</a></p>',
              "neutral",
            ),
          );
      }
      response.redirect(303, `/projects/${encodeURIComponent(result.project_id)}/changes`);
    } catch (error) {
      if (!(error instanceof CaptureSavePreviewUserError)) throw error;
      response
        .status(409)
        .type("html")
        .set("Cache-Control", "no-store")
        .send(
          renderStatusPage(
            "Save not completed",
            `<h1>Save not completed</h1><p>${escapeHtml(error.message)}</p><p>No project information was saved by this request.</p><p><a href="/">Return to your private workspace</a></p>`,
            "danger",
          ),
        );
    }
  });

  return router;
}
