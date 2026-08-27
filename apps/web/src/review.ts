import { acceptCandidate, getReviewQueue } from "@alice/domain";
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

export function createReviewRouter({ database }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", (request, response) => {
    const requestedProjectId = String(request.query.project_id || "");
    const queue = getReviewQueue(database, {
      userId: request.aliceUser!.id,
      projectId: requestedProjectId,
    });
    if (!queue)
      return response
        .status(404)
        .type("html")
        .send(renderPage("Not found", "<h1>Project not found</h1>"));
    const cards = queue.candidates
      .map(
        (candidate) =>
          `<article class="${candidate.status === "accepted" ? "accepted" : ""}"><h2>${escapeHtml(candidate.state_key)}</h2><p><code>${escapeHtml(candidate.value_json)}</code></p><p>${escapeHtml(candidate.summary)}</p><p class="muted">Status: ${escapeHtml(candidate.status)} · Source: ${escapeHtml(candidate.client_classification)} · Evidence: ${escapeHtml(candidate.evidence_id)}</p>${
            candidate.status === "pending"
              ? `<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/accept"><button type="submit">Accept into trusted state</button></form>`
              : ""
          }</article>`,
      )
      .join("");
    response
      .type("html")
      .send(
        renderPage(
          `${queue.project.name} review`,
          `<h1>${escapeHtml(queue.project.name)} review</h1><p>Only this explicit human action can change trusted state.</p>${cards || "<p>No candidates yet.</p>"}`,
        ),
      );
  });

  router.post("/candidates/:candidateId/accept", (request, response) => {
    const result = acceptCandidate(database, {
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

  return router;
}
