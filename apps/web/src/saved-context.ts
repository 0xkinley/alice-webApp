import { getSavedContextView } from "@alice/domain";
import express from "express";
import { renderPage, requireAuthenticatedUser } from "./auth.ts";

const VIEWS = new Set(["saved", "attention", "removed", "history"]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function contextLinks(view) {
  return view.contexts
    .map(
      (context) =>
        `<a${context.id === view.context.id ? ' aria-current="page"' : ""} href="/projects/${encodeURIComponent(view.project.id)}/saved-context?context_id=${encodeURIComponent(context.id)}">${escapeHtml(context.name)}</a>`,
    )
    .join(" ");
}

function viewLinks(view, selected) {
  const labels = {
    saved: ["Saved context", view.saved.length],
    attention: ["Needs attention", view.needs_attention.length],
    removed: ["Removed", view.removed.length],
    history: ["History", view.history.length],
  };
  return Object.entries(labels)
    .map(
      ([key, [label, count]]) =>
        `<a${key === selected ? ' aria-current="page"' : ""} href="/projects/${encodeURIComponent(view.project.id)}/saved-context?context_id=${encodeURIComponent(view.context.id)}&view=${key}">${label} (${count})</a>`,
    )
    .join(" ");
}

function provenance(entry) {
  return `<details><summary>Source and history</summary><dl><dt>Source host</dt><dd>${escapeHtml(entry.client_classification)}</dd><dt>Saved</dt><dd>${escapeHtml(entry.accepted_at)}</dd><dt>Version</dt><dd>${entry.version}</dd><dt>Evidence receipt</dt><dd><code>${escapeHtml(entry.evidence_id)}</code></dd><dt>Payload hash</dt><dd><code>${escapeHtml(entry.payload_hash)}</code></dd></dl></details>`;
}

function savedCards(view) {
  if (view.saved.length === 0) return "<p>Nothing is saved in this context yet.</p>";
  return view.saved
    .map(
      (entry) =>
        `<article><h2>${escapeHtml(entry.state_key)}</h2><pre>${renderJson(entry.value)}</pre><p>${escapeHtml(entry.summary)}</p>${provenance(entry)}</article>`,
    )
    .join("");
}

function attentionCards(view) {
  if (view.needs_attention.length === 0) return "<p>Nothing needs your attention.</p>";
  return view.needs_attention
    .map(
      (entry) =>
        `<article><h2>${escapeHtml(entry.state_key)}</h2><pre>${renderJson(entry.value)}</pre><p>${escapeHtml(entry.summary)}</p><p class="muted">${escapeHtml(entry.capture_summary || "Proposed save")} · ${escapeHtml(entry.client_classification)}</p><p><a href="/review/captures/${encodeURIComponent(entry.evidence_id)}">Check the exact save preview</a></p></article>`,
    )
    .join("");
}

function historyCards(view) {
  if (view.history.length === 0) return "<p>No context history yet.</p>";
  const labels = { accepted: "Saved", pending: "Needs attention", rejected: "Not saved" };
  return view.history
    .map(
      (entry) =>
        `<article><h2>${escapeHtml(entry.state_key)}</h2><p><strong>${labels[entry.status] || escapeHtml(entry.status)}</strong> · ${escapeHtml(entry.accepted_at || entry.created_at)}</p><pre>${renderJson(entry.value)}</pre><p>${escapeHtml(entry.summary)}</p><details><summary>Provenance</summary><dl><dt>Evidence receipt</dt><dd><code>${escapeHtml(entry.evidence_id)}</code></dd><dt>Payload hash</dt><dd><code>${escapeHtml(entry.payload_hash)}</code></dd>${entry.version ? `<dt>Saved version</dt><dd>${entry.version}</dd>` : ""}</dl></details></article>`,
    )
    .join("");
}

export function createSavedContextRouter({ database }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/:projectId/saved-context", async (request, response) => {
    const selected = String(request.query.view || "saved");
    if (!VIEWS.has(selected)) {
      return response
        .status(400)
        .type("html")
        .send(renderPage("Invalid view", "<h1>Invalid saved-context view</h1>"));
    }
    const view = await getSavedContextView(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId: request.query.context_id ? String(request.query.context_id) : undefined,
    });
    if (!view) {
      return response
        .status(404)
        .type("html")
        .send(renderPage("Not found", "<h1>Project or context not found</h1>"));
    }

    const content =
      selected === "saved"
        ? savedCards(view)
        : selected === "attention"
          ? attentionCards(view)
          : selected === "removed"
            ? "<p>Nothing has been removed from this context.</p>"
            : historyCards(view);
    response
      .type("html")
      .send(
        renderPage(
          `${view.project.name} saved context`,
          `<nav><a href="/projects/${encodeURIComponent(view.project.id)}">Project</a><a href="/connections">AI connections</a></nav><h1>${escapeHtml(view.project.name)} / ${escapeHtml(view.context.name)}</h1><p>${escapeHtml(view.context.description)}</p><nav aria-label="Project contexts">${contextLinks(view)}</nav><nav aria-label="Context views">${viewLinks(view, selected)}</nav><section><h2>${selected === "saved" ? "Saved context" : selected === "attention" ? "Needs attention" : selected === "removed" ? "Removed" : "History"}</h2>${content}</section>`,
        ),
      );
  });

  return router;
}
