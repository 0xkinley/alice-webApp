import { randomUUID } from "node:crypto";
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

function acceptCandidate(database, candidateId, userId) {
  const { workspace_id: workspaceId } = database
    .prepare("SELECT id AS workspace_id FROM workspaces WHERE user_id = ?")
    .get(userId);
  const candidate = database
    .prepare(
      `SELECT * FROM candidate_claims
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .get(candidateId, workspaceId);
  if (!candidate) return undefined;

  const acceptedAt = new Date().toISOString();
  const acceptedStateId = `accepted_${randomUUID()}`;
  const auditId = `audit_${randomUUID()}`;
  database.exec("BEGIN IMMEDIATE");
  try {
    const { version } = database
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM accepted_project_state WHERE project_id = ? AND state_key = ?`,
      )
      .get(candidate.project_id, candidate.state_key);
    database
      .prepare(
        `INSERT INTO accepted_project_state
          (id, workspace_id, project_id, candidate_id, evidence_id, state_key,
           value_json, version, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        acceptedStateId,
        workspaceId,
        candidate.project_id,
        candidate.id,
        candidate.evidence_id,
        candidate.state_key,
        candidate.value_json,
        version,
        acceptedAt,
      );
    database
      .prepare("UPDATE candidate_claims SET status = 'accepted' WHERE id = ?")
      .run(candidate.id);
    database
      .prepare(
        `INSERT INTO audit_events
          (id, workspace_id, project_id, action, actor_type, actor_id,
           correlation_id, safe_metadata_json, created_at)
         VALUES (?, ?, ?, 'candidate_accepted', 'human_reviewer', ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        workspaceId,
        candidate.project_id,
        userId,
        `review_${randomUUID()}`,
        JSON.stringify({
          accepted_state_id: acceptedStateId,
          candidate_id: candidate.id,
          evidence_id: candidate.evidence_id,
          state_key: candidate.state_key,
          version,
        }),
        acceptedAt,
      );
    database.exec("COMMIT");
    return { acceptedStateId, projectId: candidate.project_id };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createReviewRouter({ database }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", (request, response) => {
    const workspaceId = request.aliceUser!.workspace_id;
    const requestedProjectId = String(request.query.project_id || "");
    const project = database
      .prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?")
      .get(requestedProjectId, workspaceId);
    if (!project)
      return response
        .status(404)
        .type("html")
        .send(renderPage("Not found", "<h1>Project not found</h1>"));
    const candidates = database
      .prepare(
        `SELECT candidate.*, evidence.client_classification, evidence.created_at AS evidence_created_at
         FROM candidate_claims candidate
         JOIN evidence_events evidence ON evidence.id = candidate.evidence_id
         WHERE candidate.project_id = ? AND candidate.workspace_id = ?
         ORDER BY candidate.created_at, candidate.id`,
      )
      .all(project.id, workspaceId);
    const cards = candidates
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
          `${project.name} review`,
          `<h1>${escapeHtml(project.name)} review</h1><p>Only this explicit human action can change trusted state.</p>${cards || "<p>No candidates yet.</p>"}`,
        ),
      );
  });

  router.post("/candidates/:candidateId/accept", (request, response) => {
    const result = acceptCandidate(database, request.params.candidateId, request.aliceUser!.id);
    if (!result)
      return response
        .status(409)
        .type("html")
        .send(renderPage("Not accepted", "<h1>Candidate is not pending or accessible.</h1>"));
    response.redirect(303, `/review?project_id=${encodeURIComponent(result.projectId)}`);
  });

  return router;
}
