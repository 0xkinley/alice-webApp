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
import express from "express";
import { renderPage, requireAuthenticatedUser } from "./auth.ts";

// Trusted-state acceptance stays behind the human web control plane.

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderJson(valueJson) {
  try {
    return escapeHtml(JSON.stringify(JSON.parse(valueJson), null, 2));
  } catch {
    return escapeHtml(valueJson);
  }
}

function fileSourceDetails(fileSource) {
  if (!fileSource) return "";
  return `<aside><h3>Untrusted PDF evidence</h3><p>This source is evidence only. Its claims are not active alice.-verified state unless you confirm the exact entries below.</p><dl><dt>File</dt><dd>${escapeHtml(fileSource.display_name)}</dd><dt>File reference</dt><dd><code>${escapeHtml(fileSource.file_reference_id)}</code></dd><dt>Immutable version</dt><dd>${escapeHtml(fileSource.file_version)}</dd><dt>Content SHA-256</dt><dd><code>${escapeHtml(fileSource.content_sha256)}</code></dd><dt>Extraction</dt><dd>${escapeHtml(fileSource.extraction_version)} · ${escapeHtml(fileSource.method)} · characters ${escapeHtml(fileSource.start_character)}–${escapeHtml(fileSource.end_character)}</dd><dt>Excerpt SHA-256</dt><dd><code>${escapeHtml(fileSource.excerpt_sha256)}</code></dd></dl></aside>`;
}

function reviewProjectIndex(projects) {
  const cards = projects
    .map(
      (project) =>
        `<article><h2><a href="/review?project_id=${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p>${escapeHtml(project.brief)}</p><p><strong>${project.pending_count} pending</strong> · ${project.accepted_count} accepted · ${project.rejected_count} rejected</p>${project.latest_candidate_at ? `<p class="muted">Latest candidate: ${escapeHtml(project.latest_candidate_at)}</p>` : '<p class="muted">No candidates captured yet.</p>'}</article>`,
    )
    .join("");
  return `<nav><a href="/">Private workspace</a></nav><header class="hero"><p class="eyebrow">Needs attention</p><h1>Review proposed context before it is saved.</h1><p>Only an explicit authenticated decision can change trusted project state. A host tool call alone never activates a claim.</p></header><section><div class="section-heading"><h2>Projects with review history</h2><p class="muted">Choose a project to inspect exact proposals.</p></div>${cards || '<div class="empty-state"><h2>No projects need review</h2><p>Create a project and use a connected host to capture a proposal. Nothing is saved automatically.</p></div>'}</section>`;
}

function filterLink(projectId, filter, count, active) {
  return `<a${active ? ' aria-current="page"' : ""} href="/review?project_id=${encodeURIComponent(projectId)}&status=${filter}">${filter[0].toUpperCase()}${filter.slice(1)} (${count})</a>`;
}

function evidenceDetails(candidate) {
  const sourceNote = candidate.source_note
    ? `<p><strong>Source note:</strong> ${escapeHtml(candidate.source_note)}</p>`
    : "";
  const sourceContext = candidate.source_context
    ? `<details><summary>Explicitly saved source context</summary><pre>${escapeHtml(candidate.source_context)}</pre></details>`
    : "";
  return `<details><summary>Capture evidence and provenance</summary><p><strong>Capture summary:</strong> ${escapeHtml(candidate.capture_summary || "Not supplied")}</p>${sourceNote}${fileSourceDetails(candidate.file_source)}${sourceContext}<dl><dt>Evidence</dt><dd><code>${escapeHtml(candidate.evidence_id)}</code></dd><dt>Payload hash</dt><dd><code>${escapeHtml(candidate.payload_hash)}</code></dd><dt>Source client</dt><dd>${escapeHtml(candidate.client_classification)}</dd><dt>Tool</dt><dd>${escapeHtml(candidate.tool_name)}</dd><dt>Captured</dt><dd>${escapeHtml(candidate.evidence_created_at)}</dd></dl></details>`;
}

function candidateCard(candidate) {
  const accepted = candidate.accepted_state_id
    ? `<p class="muted">Accepted state: <code>${escapeHtml(candidate.accepted_state_id)}</code> · Version ${candidate.accepted_version}</p>`
    : "";
  const reviewAudit = candidate.review_audit_id
    ? `<p class="muted">Human decision audit: <code>${escapeHtml(candidate.review_audit_id)}</code> · ${escapeHtml(candidate.reviewed_at)}</p>`
    : "";
  const currentTrusted =
    candidate.status === "pending" && candidate.current_accepted_state_id
      ? `<aside><h3>Current trusted state</h3><p>Version ${candidate.current_accepted_version} · <code>${escapeHtml(candidate.current_accepted_state_id)}</code></p><pre>${renderJson(candidate.current_accepted_value_json)}</pre><p>Accepting this candidate requires an explicit supersession action; the current version will remain immutable history.</p></aside>`
      : "";
  const acceptAction = candidate.current_accepted_state_id
    ? `<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/supersede"><input type="hidden" name="superseded_accepted_state_id" value="${escapeHtml(candidate.current_accepted_state_id)}"><button type="submit">Supersede trusted version ${candidate.current_accepted_version}</button></form>`
    : `<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/accept"><button type="submit">Accept into trusted state</button></form>`;
  const actions =
    candidate.status === "pending"
      ? `<div class="actions">${acceptAction}<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/reject"><button type="submit">Reject candidate</button></form></div>`
      : "";
  return `<article class="${escapeHtml(candidate.status)}"><h2>${escapeHtml(candidate.state_key)}</h2><pre>${renderJson(candidate.value_json)}</pre><p>${escapeHtml(candidate.summary)}</p><p><a href="/review/captures/${encodeURIComponent(candidate.evidence_id)}">Review the exact save preview</a></p><p class="muted">Status: ${escapeHtml(candidate.status)} · Candidate: <code>${escapeHtml(candidate.id)}</code></p>${accepted}${reviewAudit}${currentTrusted}${evidenceDetails(candidate)}${actions}</article>`;
}

function capturePreviewPage(preview) {
  const candidateCards = preview.candidates
    .map((candidate) => {
      const current = candidate.current
        ? candidate.current.removed_at
          ? `<aside><h3>Will restore removed key as a new saved version</h3><pre>${renderJson(candidate.current.value_json)}</pre><p class="muted">Removed version ${candidate.current.version} and its provenance remain in History.</p></aside>`
          : `<aside><h3>Will replace saved version ${candidate.current.version}</h3><pre>${renderJson(candidate.current.value_json)}</pre><p class="muted">The earlier version and provenance remain in History.</p></aside>`
        : "";
      return `<article class="${escapeHtml(candidate.status)}"><h2>${escapeHtml(candidate.state_key)}</h2><pre>${renderJson(candidate.value_json)}</pre><p>${escapeHtml(candidate.summary)}</p>${current}<p class="muted">Status: ${escapeHtml(candidate.status)}</p></article>`;
    })
    .join("");
  const sourceNote = preview.source_note
    ? `<p><strong>Source note:</strong> ${escapeHtml(preview.source_note)}</p>`
    : "";
  const sourceContext = preview.source_context
    ? `<details><summary>Source material included in this save</summary><pre>${escapeHtml(preview.source_context)}</pre></details>`
    : "";
  const pending = preview.candidates.every(({ status }) => status === "pending");
  const actions = pending
    ? `<div class="actions"><form method="post" action="/review/captures/${encodeURIComponent(preview.evidence_id)}/confirm"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><button type="submit" aria-label="Save every entry shown in this preview">✓ Save these entries</button></form><form method="post" action="/review/captures/${encodeURIComponent(preview.evidence_id)}/cancel"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><button type="submit" aria-label="Cancel this save preview">× Not now</button></form></div>`
    : `<p><strong>This preview has already been decided.</strong></p>`;
  return `<nav><a href="/review?project_id=${encodeURIComponent(preview.project.id)}">Needs attention</a><a href="/projects/${encodeURIComponent(preview.project.id)}">Project</a></nav><header class="hero"><p class="eyebrow">Exact save preview</p><h1>Save to ${escapeHtml(preview.project.name)} / ${escapeHtml(preview.context.name)}?</h1><p>Check the exact entries below. Only the ✓ action saves them as active context. × performs no activation.</p></header><dl><dt>Destination project</dt><dd>${escapeHtml(preview.project.name)}</dd><dt>Work context</dt><dd>${escapeHtml(preview.context.name)}</dd><dt>Access</dt><dd>${escapeHtml(preview.context.visibility)}</dd><dt>Proposed by</dt><dd>${escapeHtml(preview.client_classification)}</dd><dt>Captured</dt><dd>${escapeHtml(preview.captured_at)}</dd></dl><p class="notice"><strong>Save summary:</strong> ${escapeHtml(preview.capture_summary || "Not supplied")}</p>${sourceNote}${fileSourceDetails(preview.file_source)}${sourceContext}<section><div class="section-heading"><h2>Exact proposed entries</h2><p class="muted">${preview.candidates.length} item${preview.candidates.length === 1 ? "" : "s"}</p></div>${candidateCards}</section>${actions}<details><summary>Evidence receipt</summary><dl><dt>Evidence</dt><dd><code>${escapeHtml(preview.evidence_id)}</code></dd><dt>Payload hash</dt><dd><code>${escapeHtml(preview.payload_hash)}</code></dd></dl></details>`;
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

export function createReviewRouter({ database }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", async (request, response) => {
    const requestedProjectId = String(request.query.project_id || "");
    if (!requestedProjectId) {
      const projects = await listReviewProjects(database, request.aliceUser!.id);
      return response
        .type("html")
        .send(renderPage("Candidate review queue", reviewProjectIndex(projects)));
    }
    const status = String(request.query.status || "pending");
    if (!new Set(["all", "pending", "accepted", "rejected"]).has(status)) {
      return response
        .status(400)
        .type("html")
        .send(renderPage("Invalid review filter", "<h1>Invalid review filter</h1>"));
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
        .send(renderPage("Not found", "<h1>Project not found</h1>"));
    const cards = queue.candidates.map(candidateCard).join("");
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
        renderPage(
          `${queue.project.name} review`,
          `<nav><a href="/review">All review queues</a><a href="/projects/${encodeURIComponent(queue.project.id)}">Project</a></nav><header class="hero"><p class="eyebrow">Needs attention</p><h1>${escapeHtml(queue.project.name)} review</h1><p>Only an explicit action on a pending candidate can change trusted state. Your decision remains traceable in project history.</p></header><nav aria-label="Review filters">${filters}</nav><p class="muted">Showing ${queue.pagination.selected_total} ${escapeHtml(queue.filter)} candidate(s).</p>${cards || `<div class="empty-state"><h2>No ${escapeHtml(queue.filter)} candidates</h2><p>There is nothing to decide in this view.</p></div>`}${paginationLinks(queue)}`,
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
        .send(renderPage("Not found", "<h1>Save preview not found</h1>"));
    }
    response
      .type("html")
      .send(renderPage(`Save to ${preview.project.name}`, capturePreviewPage(preview)));
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
        .send(renderPage("Not found", "<h1>Save preview not found</h1>"));
    }
    if (result.conflict) {
      return response
        .status(409)
        .type("html")
        .send(
          renderPage(
            "Preview changed",
            `<h1>This save preview changed.</h1><p><a href="/review/captures/${encodeURIComponent(request.params.evidenceId)}">Review the exact current preview before deciding.</a></p>`,
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
        .send(renderPage("Not found", "<h1>Save preview not found</h1>"));
    }
    if (result.conflict) {
      return response
        .status(409)
        .type("html")
        .send(
          renderPage(
            "Preview changed",
            `<h1>This save preview changed.</h1><p><a href="/review/captures/${encodeURIComponent(request.params.evidenceId)}">Review the exact current preview before deciding.</a></p>`,
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
        .send(renderPage("Not accepted", "<h1>Candidate is not pending or accessible.</h1>"));
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
        .send(renderPage("Not rejected", "<h1>Candidate is not pending or accessible.</h1>"));
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
          renderPage(
            "Not superseded",
            "<h1>Candidate or current trusted version is not pending or accessible.</h1>",
          ),
        );
    response.redirect(303, `/review?project_id=${encodeURIComponent(result.projectId)}`);
  });

  return router;
}
