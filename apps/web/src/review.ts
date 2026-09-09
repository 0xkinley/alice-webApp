import {
  acceptCandidate,
  cancelCapturedUpdate,
  confirmCapturedUpdate,
  getCapturePreview,
  getReviewQueue,
  listReviewProjects,
  rejectCandidate,
  supersedeAcceptedState,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import express from "express";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { escapeHtml, readableLabel, readableText, renderReadableValue } from "./human-readable.ts";
import { hostLabel, localTimestamp, reviewStatusLabel } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";

// Trusted-state acceptance stays behind the human web control plane.

function fileSourceDetails(fileSource) {
  if (!fileSource) return "";
  return `<aside><h3>Untrusted file source</h3><p>This file is evidence only. Its claims do not become trusted project information unless you save the exact changes below.</p><dl><dt>File</dt><dd>${escapeHtml(fileSource.display_name)}</dd><dt>Extracted section</dt><dd>Characters ${escapeHtml(fileSource.start_character)}–${escapeHtml(fileSource.end_character)}</dd></dl></aside>`;
}

function reviewProjectIndex(projects) {
  const cards = projects
    .map(
      (project) =>
        `<article><h2><a href="/review?project_id=${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p><strong>${project.pending_count} need attention</strong> · ${project.accepted_count} saved · ${project.rejected_count} not saved</p>${project.latest_candidate_at ? `<p class="muted">Latest proposal: ${localTimestamp(project.latest_candidate_at)}</p>` : '<p class="muted">No proposals captured yet.</p>'}</article>`,
    )
    .join("");
  return `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Needs attention</p><h1>Review proposed changes</h1><p>Only your explicit decision can save project information. A connected AI tool can propose an update, but cannot save it for you.</p></div></header><section><div class="section-heading"><h2>Projects with review history</h2><p class="muted">Choose a project to inspect exact proposals.</p></div>${cards || '<div class="empty-state"><h2>No projects need review</h2><p>Create a project and use a connected AI tool to propose an update. Nothing is saved automatically.</p></div>'}</section></div>`;
}

function filterLink(projectId, filter, count, active) {
  const labels = {
    pending: "Needs attention",
    accepted: "Saved",
    rejected: "Not saved",
    all: "All",
  };
  return `<a${active ? ' aria-current="page"' : ""} href="/review?project_id=${encodeURIComponent(projectId)}&status=${filter}">${labels[filter]} (${count})</a>`;
}

function evidenceDetails(candidate) {
  const sourceNote = candidate.source_note
    ? `<p><strong>Source note:</strong> ${escapeHtml(readableText(candidate.source_note))}</p>`
    : "";
  const sourceContext = candidate.source_context
    ? `<details><summary>Supporting information</summary><p>${escapeHtml(readableText(candidate.source_context))}</p></details>`
    : "";
  return `<details><summary>Source and history</summary><p><strong>Summary:</strong> ${escapeHtml(readableText(candidate.capture_summary || "Not supplied"))}</p>${sourceNote}${fileSourceDetails(candidate.file_source)}${sourceContext}<dl><dt>Source</dt><dd>${escapeHtml(hostLabel(candidate.client_classification))}</dd><dt>Captured</dt><dd>${localTimestamp(candidate.evidence_created_at)}</dd></dl></details>`;
}

function candidateCard(candidate) {
  const accepted = candidate.accepted_state_id
    ? `<p class="muted">Saved as revision ${candidate.accepted_version}.</p>`
    : "";
  const reviewAudit = candidate.review_audit_id
    ? `<p class="muted">Decision recorded ${localTimestamp(candidate.reviewed_at)}.</p>`
    : "";
  const currentTrusted =
    candidate.status === "pending" && candidate.current_accepted_state_id
      ? `<aside><h3>Current project information</h3><div class="readable-value">${renderReadableValue(candidate.current_accepted_value_json)}</div><p>Saving this proposal creates a new revision. The current revision remains in the change log.</p></aside>`
      : "";
  const acceptAction = candidate.current_accepted_state_id
    ? `<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/supersede"><input type="hidden" name="superseded_accepted_state_id" value="${escapeHtml(candidate.current_accepted_state_id)}"><button type="submit">Replace saved version ${candidate.current_accepted_version}</button></form>`
    : `<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/accept"><button type="submit">Save to project</button></form>`;
  const actions =
    candidate.status === "pending"
      ? `<div class="actions">${acceptAction}<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/reject"><button type="submit">Not now</button></form></div>`
      : "";
  return `<article class="${escapeHtml(candidate.status)}"><h2>${escapeHtml(readableLabel(candidate.state_key))}</h2><div class="readable-value">${renderReadableValue(candidate.value_json)}</div><p>${escapeHtml(readableText(candidate.summary))}</p><p><a href="/review/captures/${encodeURIComponent(candidate.evidence_id)}">Review the exact save preview</a></p><p class="muted">Status: ${escapeHtml(reviewStatusLabel(candidate.status))}</p>${accepted}${reviewAudit}${currentTrusted}${evidenceDetails(candidate)}${actions}</article>`;
}

function capturePreviewPage(preview) {
  const candidateCards = preview.candidates
    .map((candidate) => {
      const current = candidate.current
        ? candidate.current.removed_at
          ? `<aside><h3>Will restore removed information as a new revision</h3><div class="readable-value">${renderReadableValue(candidate.current.value_json)}</div><p class="muted">The removed revision and its source remain in the change log.</p></aside>`
          : `<aside><h3>Will replace the current saved revision</h3><div class="readable-value">${renderReadableValue(candidate.current.value_json)}</div><p class="muted">The earlier revision and source remain in the change log.</p></aside>`
        : "";
      return `<article class="${escapeHtml(candidate.status)}"><h2>${escapeHtml(readableLabel(candidate.state_key))}</h2><div class="readable-value">${renderReadableValue(candidate.value_json)}</div><p>${escapeHtml(readableText(candidate.summary))}</p>${current}<p class="muted">Status: ${escapeHtml(reviewStatusLabel(candidate.status))}</p></article>`;
    })
    .join("");
  const sourceNote = preview.source_note
    ? `<p><strong>Source note:</strong> ${escapeHtml(readableText(preview.source_note))}</p>`
    : "";
  const sourceContext = preview.source_context
    ? `<details><summary>Supporting information</summary><p>${escapeHtml(readableText(preview.source_context))}</p></details>`
    : "";
  const pending = preview.candidates.every(({ status }) => status === "pending");
  const actions = pending
    ? `<div class="actions"><form method="post" action="/review/captures/${encodeURIComponent(preview.evidence_id)}/confirm"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><button type="submit" aria-label="Save every entry shown in this preview">✓ Save these entries</button></form><form method="post" action="/review/captures/${encodeURIComponent(preview.evidence_id)}/cancel"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><button type="submit" aria-label="Cancel this save preview">× Not now</button></form></div>`
    : `<p><strong>This preview has already been decided.</strong></p>`;
  return `<section><div class="section-heading"><div><p class="eyebrow">Exact Save preview</p><h2>Save these changes to ${escapeHtml(preview.project.name)}?</h2></div></div><p>Review every item below. Save accepts the complete proposal; Not now makes no change.</p><dl><dt>Project</dt><dd>${escapeHtml(preview.project.name)}</dd><dt>Proposed by</dt><dd>${escapeHtml(hostLabel(preview.client_classification))}</dd><dt>Captured</dt><dd>${localTimestamp(preview.captured_at)}</dd></dl><p class="notice"><strong>Summary:</strong> ${escapeHtml(readableText(preview.capture_summary || "Not supplied"))}</p>${sourceNote}${fileSourceDetails(preview.file_source)}${sourceContext}<div class="section-heading"><h2>Proposed changes</h2><p class="muted">${preview.candidates.length} item${preview.candidates.length === 1 ? "" : "s"}</p></div>${candidateCards}${actions}</section>`;
}

function paginationLinks(queue) {
  if (queue.pagination.page_count <= 1) return "";
  const base = `/review?project_id=${encodeURIComponent(queue.project.id)}&status=${queue.filter}`;
  const previous =
    queue.pagination.page > 1
      ? `<a href="${base}&page=${queue.pagination.page - 1}">Previous</a>`
      : "";
  const next =
    queue.pagination.page < queue.pagination.page_count
      ? `<a href="${base}&page=${queue.pagination.page + 1}">Next</a>`
      : "";
  return `<nav>${previous}<span>Page ${queue.pagination.page} of ${queue.pagination.page_count}</span>${next}</nav>`;
}

export function createReviewRouter({
  database,
  fileStore,
}: {
  database: any;
  fileStore?: PrivateFileStore | undefined;
}) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", async (request, response) => {
    const requestedProjectId = String(request.query.project_id || "");
    if (!requestedProjectId) {
      const projects = await listReviewProjects(database, request.aliceUser!.id);
      return response.type("html").send(
        renderAppPage("Review proposed changes", reviewProjectIndex(projects), {
          email: request.aliceUser!.email,
          activeSection: "projects",
        }),
      );
    }
    const status = String(request.query.status || "pending");
    if (!new Set(["all", "pending", "accepted", "rejected"]).has(status)) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Invalid review filter",
            '<h1>Invalid review filter</h1><p>No review decision was made.</p><p><a href="/review">Return to review</a></p>',
          ),
        );
    }
    const queue = await getReviewQueue(database, {
      userId: request.aliceUser!.id,
      projectId: requestedProjectId,
      status,
      page: Number.parseInt(String(request.query.page || "1"), 10),
    });
    if (!queue)
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Project not found</h1><p>The project may be unavailable or outside your access.</p><p><a href="/review">Return to review</a></p>',
            "neutral",
          ),
        );
    const cards = queue.candidates.map(candidateCard).join("");
    const shell = await getProjectShell(database, request.aliceUser!.id, queue.project.id);
    if (!shell) return response.status(404).end();
    const filters = ["pending", "accepted", "rejected", "all"]
      .map((filter) =>
        filterLink(
          queue.project.id,
          filter,
          filter === "all" ? queue.counts.total : queue.counts[filter],
          queue.filter === filter,
        ),
      )
      .join(" ");
    response
      .type("html")
      .send(
        renderAppPage(
          `${queue.project.name} review`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "changes", pendingCount: queue.counts.pending })}<section><div class="section-heading"><div><p class="eyebrow">Needs attention</p><h2>Review proposed changes</h2></div><a href="/review">All projects</a></div><p>Only your explicit action can save a proposed entry. Your decision remains traceable in the change log.</p><nav aria-label="Review filters">${filters}</nav><p class="muted">Showing ${queue.pagination.selected_total} ${queue.pagination.selected_total === 1 ? "proposal" : "proposals"} · ${escapeHtml(reviewStatusLabel(queue.filter))}.</p>${cards || `<div class="empty-state"><h2>No proposals in this view</h2><p>There is nothing to decide here.</p></div>`}${paginationLinks(queue)}</section></div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });

  router.get("/captures/:evidenceId", async (request, response) => {
    const preview = await getCapturePreview(database, {
      evidenceId: request.params.evidenceId,
      userId: request.aliceUser!.id,
    });
    if (!preview) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Save preview not found</h1><p>The preview may be unavailable or outside your access.</p><p><a href="/review">Return to review</a></p>',
            "neutral",
          ),
        );
    }
    const shell = await getProjectShell(database, request.aliceUser!.id, preview.project.id);
    if (!shell) return response.status(404).end();
    response
      .type("html")
      .send(
        renderAppPage(
          `Save to ${preview.project.name}`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "changes", pendingCount: preview.candidates.filter(({ status }) => status === "pending").length })}${capturePreviewPage(preview)}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });

  router.post("/captures/:evidenceId/confirm", async (request, response) => {
    const result = await confirmCapturedUpdate(database, {
      evidenceId: request.params.evidenceId,
      expectedPreviewVersion: String(request.body.preview_version || ""),
      userId: request.aliceUser!.id,
    });
    if (!result) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Save preview not found</h1><p>No project information was saved.</p><p><a href="/review">Return to review</a></p>',
            "neutral",
          ),
        );
    }
    if (result.conflict) {
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Preview changed",
            `<h1>This save preview changed.</h1><p>Nothing was saved or overwritten.</p><p><a href="/review/captures/${encodeURIComponent(request.params.evidenceId)}">Review the exact current preview before deciding.</a></p>`,
          ),
        );
    }
    response.redirect(
      303,
      `/review?project_id=${encodeURIComponent(result.projectId)}&status=accepted`,
    );
  });

  router.post("/captures/:evidenceId/cancel", async (request, response) => {
    const result = await cancelCapturedUpdate(database, {
      evidenceId: request.params.evidenceId,
      expectedPreviewVersion: String(request.body.preview_version || ""),
      userId: request.aliceUser!.id,
    });
    if (!result) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Save preview not found</h1><p>No proposal was cancelled.</p><p><a href="/review">Return to review</a></p>',
            "neutral",
          ),
        );
    }
    if (result.conflict) {
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Preview changed",
            `<h1>This save preview changed.</h1><p>Nothing was cancelled or overwritten.</p><p><a href="/review/captures/${encodeURIComponent(request.params.evidenceId)}">Review the exact current preview before deciding.</a></p>`,
          ),
        );
    }
    response.redirect(
      303,
      `/review?project_id=${encodeURIComponent(result.projectId)}&status=rejected`,
    );
  });

  router.post("/candidates/:candidateId/accept", async (request, response) => {
    const result = await acceptCandidate(database, {
      candidateId: request.params.candidateId,
      userId: request.aliceUser!.id,
    });
    if (!result)
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Not accepted",
            '<h1>Proposal is not pending or accessible.</h1><p>No project information changed.</p><p><a href="/review">Return to review</a></p>',
          ),
        );
    response.redirect(303, `/review?project_id=${encodeURIComponent(result.projectId)}`);
  });

  router.post("/candidates/:candidateId/reject", async (request, response) => {
    const result = await rejectCandidate(database, {
      candidateId: request.params.candidateId,
      userId: request.aliceUser!.id,
    });
    if (!result)
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Not rejected",
            '<h1>Candidate is not pending or accessible.</h1><p>No review state changed.</p><p><a href="/review">Return to review</a></p>',
          ),
        );
    response.redirect(303, `/review?project_id=${encodeURIComponent(result.projectId)}`);
  });

  router.post("/candidates/:candidateId/supersede", async (request, response) => {
    const result = await supersedeAcceptedState(database, {
      candidateId: request.params.candidateId,
      supersededAcceptedStateId: String(request.body.superseded_accepted_state_id || ""),
      userId: request.aliceUser!.id,
    });
    if (!result)
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Not superseded",
            '<h1>The proposal or current revision is not pending or accessible.</h1><p>No project information changed.</p><p><a href="/review">Return to review</a></p>',
          ),
        );
    response.redirect(303, `/review?project_id=${encodeURIComponent(result.projectId)}`);
  });

  return router;
}
