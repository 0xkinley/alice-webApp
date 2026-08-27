import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";

const REVIEW_SESSION_TTL_SECONDS = 60 * 60;

// Trusted-state acceptance stays behind the human web control plane.

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name, value]) => name && value)
      .map(([name, ...value]) => [name, decodeURIComponent(value.join("="))]),
  );
}

function renderPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>
body{font:16px system-ui;max-width:58rem;margin:3rem auto;padding:0 1rem;color:#171717}article{border:1px solid #ddd;border-radius:.7rem;padding:1rem;margin:1rem 0}code{overflow-wrap:anywhere}button,input{font:inherit;padding:.6rem}.muted{color:#666}.accepted{border-color:#9ccca9;background:#f3fff5}</style></head><body>${body}</body></html>`;
}

function setSession(database, response, publicUrl) {
  const token = `alice_review_${randomBytes(32).toString("base64url")}`;
  const now = Math.floor(Date.now() / 1000);
  database
    .prepare(
      "INSERT INTO review_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(sha256(token), "spike-user", now + REVIEW_SESSION_TTL_SECONDS, new Date().toISOString());
  const secure = new URL(publicUrl).protocol === "https:" ? "; Secure" : "";
  response.set(
    "Set-Cookie",
    `alice_review=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/review; Max-Age=${REVIEW_SESSION_TTL_SECONDS}${secure}`,
  );
}

function authenticatedReviewer(database, request) {
  const token = parseCookies(request.get("cookie")).alice_review;
  if (!token) return undefined;
  return database
    .prepare("SELECT user_id FROM review_sessions WHERE token_hash = ? AND expires_at > ?")
    .get(sha256(token), Math.floor(Date.now() / 1000));
}

function acceptCandidate(database, candidateId, userId) {
  const workspaceId = `workspace_${userId}`;
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

export function createReviewRouter({ database, passphrase, publicUrl }) {
  const router = express.Router();

  router.get("/login", (request, response) => {
    const next = String(request.query.next || "/review");
    response.type("html").send(
      renderPage(
        "alice. review sign in",
        `<h1>alice. spike review</h1><p>Sign in to review pending host-submitted candidates.</p><form method="post" action="/review/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Spike passphrase <input name="passphrase" type="password" required></label> <button type="submit">Sign in</button></form>`,
      ),
    );
  });

  router.post("/login", (request, response) => {
    if (!constantTimeEqual(request.body.passphrase || "", passphrase)) {
      return response.status(403).type("html").send(renderPage("Denied", "<h1>Authorization denied</h1>"));
    }
    setSession(database, response, publicUrl);
    const next = String(request.body.next || "/review");
    response.redirect(303, next.startsWith("/review") ? next : "/review");
  });

  router.use((request, response, next) => {
    const reviewer = authenticatedReviewer(database, request);
    if (!reviewer) {
      return response.redirect(303, `/review/login?next=${encodeURIComponent(request.originalUrl)}`);
    }
    request.reviewer = reviewer;
    next();
  });

  router.get("/", (request, response) => {
    const workspaceId = `workspace_${request.reviewer.user_id}`;
    const requestedProjectId = String(request.query.project_id || "project_switchboard_launch");
    const project = database
      .prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?")
      .get(requestedProjectId, workspaceId);
    if (!project) return response.status(404).type("html").send(renderPage("Not found", "<h1>Project not found</h1>"));
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
        (candidate) => `<article class="${candidate.status === "accepted" ? "accepted" : ""}"><h2>${escapeHtml(candidate.state_key)}</h2><p><code>${escapeHtml(candidate.value_json)}</code></p><p>${escapeHtml(candidate.summary)}</p><p class="muted">Status: ${escapeHtml(candidate.status)} · Source: ${escapeHtml(candidate.client_classification)} · Evidence: ${escapeHtml(candidate.evidence_id)}</p>${
          candidate.status === "pending"
            ? `<form method="post" action="/review/candidates/${encodeURIComponent(candidate.id)}/accept"><button type="submit">Accept into trusted state</button></form>`
            : ""
        }</article>`,
      )
      .join("");
    response.type("html").send(
      renderPage(
        `${project.name} review`,
        `<h1>${escapeHtml(project.name)} review</h1><p>Only this explicit human action can change trusted state.</p>${cards || "<p>No candidates yet.</p>"}`,
      ),
    );
  });

  router.post("/candidates/:candidateId/accept", (request, response) => {
    const result = acceptCandidate(database, request.params.candidateId, request.reviewer.user_id);
    if (!result) return response.status(409).type("html").send(renderPage("Not accepted", "<h1>Candidate is not pending or accessible.</h1>"));
    response.redirect(303, `/review?project_id=${encodeURIComponent(result.projectId)}`);
  });

  return router;
}
