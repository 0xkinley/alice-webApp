import {
  ArtifactSaveUserError,
  commitArtifactSavePreview,
  getArtifactSavePreview,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import express from "express";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { escapeHtml, readableLabel, readableText, renderReadableValue } from "./human-readable.ts";
import { hostLabel, localTimestamp } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";

function list(title: string, items: unknown[]) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<section><h3>${escapeHtml(title)}</h3><ul>${items
    .map((item) => `<li>${escapeHtml(readableText(item))}</li>`)
    .join("")}</ul></section>`;
}

function decisionRecords(items: unknown[]) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<section><h3>Structured decision records</h3><dl>${items
    .map(
      (item: any) =>
        `<dt>${escapeHtml(item.decision_key)}</dt><dd><div class="readable-value">${renderReadableValue(item.value)}</div></dd>`,
    )
    .join("")}</dl></section>`;
}

function previewPage(preview) {
  const artifact = preview.artifact;
  const handoff = artifact.handoff;
  const rejected =
    handoff.rejected_directions.length === 0
      ? ""
      : `<section><h3>Rejected directions</h3><ul>${handoff.rejected_directions
          .map(
            (item) =>
              `<li><strong>${escapeHtml(readableText(item.direction))}</strong><br>${escapeHtml(readableText(item.reason))}</li>`,
          )
          .join("")}</ul></section>`;
  const action = preview.expired
    ? '<p class="notice warning"><strong>This Save preview expired.</strong> Ask the AI platform for a new exact preview. Nothing was saved.</p>'
    : preview.can_save
      ? `<form method="post" action="/artifact-save-previews/${encodeURIComponent(preview.preview_id)}"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><button type="submit">Save</button></form>`
      : '<p class="notice danger"><strong>Save blocked.</strong> Ask the AI platform to correct the artifact title and create a new exact Alice preview.</p>';
  const identity = artifact.identity;
  const identitySummary = `<section class="${identity.conflict ? "notice danger" : "notice"}"><h3>Artifact identity and Alice version</h3><dl>${identity.existing_artifact ? `<dt>Existing artifact</dt><dd>${escapeHtml(identity.existing_artifact)}</dd><dt>Authoritative current Alice version</dt><dd>${identity.authoritative_current_alice_version}</dd>` : ""}<dt>Proposed next Alice version</dt><dd>${identity.proposed_next_alice_version}</dd><dt>Proposed title</dt><dd>${escapeHtml(identity.proposed_title)}</dd><dt>Identity/title conflict</dt><dd>${identity.conflict ? `Yes — ${escapeHtml(identity.conflict_reason)}` : "None detected"}</dd></dl></section>`;
  return `<section><div class="section-heading"><div><p class="eyebrow">Artifact Save preview</p><h2>${preview.save_kind === "new_version" ? `Save Alice version ${artifact.version} of ${escapeHtml(artifact.title)}?` : `Save ${escapeHtml(artifact.title)}?`}</h2></div></div><p>Only your authenticated Save action creates this artifact version. Closing this page does nothing.</p>${identitySummary}<dl><dt>Project</dt><dd>${escapeHtml(preview.destination.project_name)}</dd><dt>Source</dt><dd>${escapeHtml(hostLabel(preview.source_host))}</dd><dt>Prepared</dt><dd>${localTimestamp(preview.created_at)}</dd><dt>Type</dt><dd>${escapeHtml(readableLabel(artifact.artifact_type))}</dd><dt>Category</dt><dd>${escapeHtml(readableLabel(artifact.category))}</dd><dt>Tags</dt><dd>${artifact.tags.length ? artifact.tags.map((tag) => escapeHtml(readableLabel(tag))).join(" · ") : "None"}</dd></dl><section><h3>Full artifact</h3><div class="artifact-body">${escapeHtml(artifact.content)}</div></section><section><h3>Goal</h3><p>${escapeHtml(readableText(handoff.goal))}</p>${handoff.summary ? `<p>${escapeHtml(readableText(handoff.summary))}</p>` : ""}</section>${list("Decisions", handoff.decisions)}${decisionRecords(handoff.decision_records)}${list("Constraints", handoff.constraints)}${rejected}${list("Open questions", handoff.open_questions)}${list("Next steps", handoff.next_steps)}${list("Relevant context", handoff.relevant_context)}${action}<p class="muted">Before Save, this is short-lived preview state only.</p></section>`;
}

export function createArtifactSavePreviewsRouter({
  database,
  fileStore,
}: {
  database: unknown;
  fileStore?: PrivateFileStore | undefined;
}) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/:previewId", async (request, response) => {
    const preview = await getArtifactSavePreview(database, {
      previewId: request.params.previewId,
      userId: request.aliceUser!.id,
    });
    if (!preview) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Artifact Save preview not found",
            '<h1>Artifact Save preview not found</h1><p>It may be unavailable, expired, or outside your access. Nothing was saved.</p><p><a href="/">Return to your private workspace</a></p>',
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
          `Save ${preview.artifact.title}`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "changes" })}${previewPage(preview)}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });

  router.post("/:previewId", async (request, response) => {
    try {
      const result = await commitArtifactSavePreview(database, {
        previewId: request.params.previewId,
        previewVersion: String(request.body.preview_version || ""),
        userId: request.aliceUser!.id,
        authority: "web_session",
      });
      if (!result) {
        return response
          .status(404)
          .type("html")
          .send(
            renderStatusPage(
              "Artifact Save preview not found",
              '<h1>Artifact Save preview not found</h1><p>Nothing was saved.</p><p><a href="/">Return to your private workspace</a></p>',
              "neutral",
            ),
          );
      }
      response.redirect(303, `/projects/${encodeURIComponent(result.project_id)}/changes`);
    } catch (error) {
      if (!(error instanceof ArtifactSaveUserError)) throw error;
      response
        .status(409)
        .type("html")
        .set("Cache-Control", "no-store")
        .send(
          renderStatusPage(
            "Artifact not saved",
            `<h1>Artifact not saved</h1><p>${escapeHtml(error.message)}</p><p>No artifact version was saved by this request.</p><p><a href="/">Return to your private workspace</a></p>`,
            "danger",
          ),
        );
    }
  });

  return router;
}
