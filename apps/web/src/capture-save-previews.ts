import {
  CaptureSavePreviewUserError,
  commitCaptureSavePreview,
  getCaptureSavePreview,
} from "@alice/domain";
import express from "express";
import { renderPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { accessLabel, timestampLabel } from "./product-copy.ts";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function valueText(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function previewPage(preview) {
  const claims = preview.payload.candidate_claims
    .map(
      (claim) =>
        `<article><h2>${escapeHtml(claim.summary)}</h2><p><code>${escapeHtml(claim.state_key)}</code></p><pre>${escapeHtml(valueText(claim.value))}</pre>${
          claim.current_saved
            ? `<p class="notice warning">Replaces saved version ${escapeHtml(claim.current_saved.version)}: ${escapeHtml(valueText(claim.current_saved.value))}</p>`
            : '<p class="muted">Creates a new saved value.</p>'
        }</article>`,
    )
    .join("");
  const source = preview.payload.source_context || preview.payload.source_note;
  const action = preview.expired
    ? '<p class="notice warning"><strong>This Save preview expired.</strong> Ask the host for a new exact preview. Nothing was saved.</p>'
    : `<form method="post" action="/save-previews/${encodeURIComponent(preview.preview_id)}"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><button type="submit">Save</button></form>`;
  return renderPage(
    "Exact alice. Save preview",
    `<nav><a href="/">Private workspace</a></nav><header class="hero"><p class="eyebrow">Exact Save preview</p><h1>Save this to alice.?</h1><p>Only your authenticated Save action can create accepted context. Closing this page does nothing.</p></header><section><h2>Destination</h2><dl><dt>Project</dt><dd>${escapeHtml(preview.destination.project_name)}</dd><dt>Work context</dt><dd>${escapeHtml(preview.destination.context_name)}</dd><dt>Access</dt><dd>${escapeHtml(accessLabel(preview.destination.access))}</dd><dt>Expires</dt><dd>${escapeHtml(timestampLabel(preview.expires_at))}</dd></dl></section><section><h2>${escapeHtml(preview.payload.summary)}</h2>${claims}${source ? `<details><summary>Source material included in this save</summary><pre>${escapeHtml(source)}</pre></details>` : ""}</section>${action}<p class="muted">Before Save, this is short-lived preview state only. There is no candidate, Needs attention item, or accepted state.</p>`,
  );
}

export function createCaptureSavePreviewsRouter({ database, publicUrl }) {
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
            '<h1>Save preview not found</h1><p>It may be unavailable, expired, or belong to another alice. account or context. Nothing was saved.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    response.set("Cache-Control", "no-store").type("html").send(previewPage(preview));
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
      response
        .type("html")
        .set("Cache-Control", "no-store")
        .send(
          renderStatusPage(
            "Saved to alice.",
            `<h1>Saved</h1><p>${result.accepted.length} exact ${result.accepted.length === 1 ? "entry is" : "entries are"} now accepted in the reviewed work context.</p><p><a class="button" href="/projects/${encodeURIComponent(result.project_id)}/saved-context?context_id=${encodeURIComponent(result.context_id)}">View saved context</a></p>`,
            "success",
          ),
        );
    } catch (error) {
      if (!(error instanceof CaptureSavePreviewUserError)) throw error;
      response
        .status(409)
        .type("html")
        .set("Cache-Control", "no-store")
        .send(
          renderStatusPage(
            "Save not completed",
            `<h1>Save not completed</h1><p>${escapeHtml(error.message)}</p><p>No new accepted context was created by this request.</p><p><a href="/">Return to your private workspace</a></p>`,
            "danger",
          ),
        );
    }
  });

  return router;
}
