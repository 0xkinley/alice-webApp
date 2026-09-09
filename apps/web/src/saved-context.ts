import { getRemovalPreview, getSavedContextView, removeSavedContextEntry } from "@alice/domain";
import express from "express";
import { renderAppPage, renderPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { hostLabel, timestampLabel } from "./product-copy.ts";

const VIEWS = new Set(["saved", "attention", "removed", "history"]);
const REPAIR_TYPES = new Map([
  ["stale", "Stale"],
  ["contradicted", "Contradicted"],
  ["wrong", "Wrong"],
]);

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

function viewLinks(view, selected, projectOnly = false) {
  const labels = {
    saved: [projectOnly ? "Saved information" : "Saved context", view.saved.length],
    attention: ["Needs attention", view.needs_attention.length],
    removed: ["Removed", view.removed.length],
    history: ["History", view.history.length],
  };
  return Object.entries(labels)
    .map(
      ([key, [label, count]]) =>
        `<a${key === selected ? ' aria-current="page"' : ""} href="/projects/${encodeURIComponent(view.project.id)}/${projectOnly ? "saved" : "saved-context"}?${projectOnly ? "" : `context_id=${encodeURIComponent(view.context.id)}&`}view=${key}">${label} (${count})</a>`,
    )
    .join(" ");
}

function provenance(entry) {
  return `<details><summary>Source and history</summary><dl><dt>Source host</dt><dd>${escapeHtml(hostLabel(entry.client_classification))}</dd><dt>Saved</dt><dd>${escapeHtml(timestampLabel(entry.accepted_at))}</dd><dt>Version</dt><dd>${entry.version}</dd><dt>Evidence receipt</dt><dd><code>${escapeHtml(entry.evidence_id)}</code></dd><dt>Payload hash</dt><dd><code>${escapeHtml(entry.payload_hash)}</code></dd></dl></details>`;
}

function savedCards(view, projectOnly = false) {
  if (view.saved.length === 0)
    return `<div class="empty-state"><h2>Nothing is saved in this ${projectOnly ? "project" : "context"} yet.</h2><p>Review an exact proposal before it becomes active ${projectOnly ? "project information" : "context"}.</p></div>`;
  return view.saved
    .map(
      (entry) =>
        `<article class="context-card"><h2>${escapeHtml(entry.state_key)}</h2><p><span class="badge">Saved · version ${entry.version}</span></p><pre>${renderJson(entry.value)}</pre><p>${escapeHtml(entry.summary)}</p>${provenance(entry)}${view.access.can_write ? `<p><a href="/projects/${encodeURIComponent(view.project.id)}/saved-context/${encodeURIComponent(entry.id)}/repair?context_id=${encodeURIComponent(view.context.id)}">Repair stale, contradicted, or wrong context</a> · <a href="/projects/${encodeURIComponent(view.project.id)}/saved-context/${encodeURIComponent(entry.id)}/remove?context_id=${encodeURIComponent(view.context.id)}">Remove from active context</a></p>` : ""}</article>`,
    )
    .join("");
}

function removedCards(view, projectOnly = false) {
  if (view.removed.length === 0)
    return `<div class="empty-state"><h2>Nothing has been removed from this ${projectOnly ? "project" : "context"}.</h2><p>Removal stops active use while preserving provenance here.</p></div>`;
  return view.removed
    .map(
      (entry) =>
        `<article class="rejected"><h2>${escapeHtml(entry.state_key)}</h2><p><span class="badge">Removed</span> · ${escapeHtml(timestampLabel(entry.removed_at))}</p><pre>${renderJson(entry.value)}</pre><p>${escapeHtml(entry.summary)}</p>${entry.reason ? `<p><strong>Reason:</strong> ${escapeHtml(entry.reason)}</p>` : ""}${provenance(entry)}</article>`,
    )
    .join("");
}

function attentionCards(view, projectOnly = false) {
  if (view.needs_attention.length === 0)
    return `<div class="empty-state"><h2>Nothing needs your attention.</h2><p>AI tools cannot save ${projectOnly ? "project information" : "context"} by themselves.</p></div>`;
  return view.needs_attention
    .map(
      (entry) =>
        `<article class="pending"><h2>${escapeHtml(entry.state_key)}</h2><p><span class="badge">Proposed only</span></p><pre>${renderJson(entry.value)}</pre><p>${escapeHtml(entry.summary)}</p><p class="muted">${escapeHtml(entry.capture_summary || "Proposed save")} · ${escapeHtml(hostLabel(entry.client_classification))}</p><p><a href="/review/captures/${encodeURIComponent(entry.evidence_id)}">Check the exact save preview</a></p></article>`,
    )
    .join("");
}

function historyCards(view, projectOnly = false) {
  if (view.history.length === 0)
    return `<div class="empty-state"><h2>No ${projectOnly ? "saved-information" : "context"} history yet.</h2><p>Accepted, declined, superseded, and removed entries will remain traceable here.</p></div>`;
  const labels = { accepted: "Saved", pending: "Needs attention", rejected: "Not saved" };
  return view.history
    .map((entry) => {
      const state = entry.removed_at
        ? "Removed"
        : entry.superseded_by_version
          ? "Superseded"
          : labels[entry.status] || escapeHtml(entry.status);
      return `<article><h2>${escapeHtml(entry.state_key)}</h2><p><span class="badge">${state}</span> · ${escapeHtml(timestampLabel(entry.removed_at || entry.accepted_at || entry.created_at))}</p>${entry.superseded_by_version ? `<p>Replaced by saved version ${escapeHtml(entry.superseded_by_version)}. This older version remains in history and is not active.</p>` : ""}<pre>${renderJson(entry.value)}</pre><p>${escapeHtml(entry.summary)}</p>${entry.removal_reason ? `<p><strong>Removal reason:</strong> ${escapeHtml(entry.removal_reason)}</p>` : ""}<details><summary>Provenance</summary><dl><dt>Evidence receipt</dt><dd><code>${escapeHtml(entry.evidence_id)}</code></dd><dt>Payload hash</dt><dd><code>${escapeHtml(entry.payload_hash)}</code></dd>${entry.version ? `<dt>Saved version</dt><dd>${entry.version}</dd>` : ""}</dl></details></article>`;
    })
    .join("");
}

function removalPreviewPage(preview) {
  return `<nav><a href="/projects/${encodeURIComponent(preview.project.id)}/saved-context?context_id=${encodeURIComponent(preview.context.id)}">Back to Saved context</a></nav><header class="hero"><p class="eyebrow">Remove from active context</p><h1>Remove from ${escapeHtml(preview.project.name)} / ${escapeHtml(preview.context.name)}?</h1><p>This stops the item from being sent as active context. It does not erase the saved version, its evidence, provenance, or audit history.</p></header><article><h2>${escapeHtml(preview.entry.state_key)}</h2><pre>${renderJson(preview.entry.value)}</pre><p>${escapeHtml(preview.entry.summary)}</p>${provenance(preview.entry)}</article><form method="post" action="/projects/${encodeURIComponent(preview.project.id)}/saved-context/${encodeURIComponent(preview.entry.id)}/remove"><input type="hidden" name="context_id" value="${escapeHtml(preview.context.id)}"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><label>Reason (optional)<textarea name="reason" maxlength="500"></textarea></label><button class="destructive" type="submit">Remove from active context</button></form><p><a href="/projects/${encodeURIComponent(preview.project.id)}/saved-context?context_id=${encodeURIComponent(preview.context.id)}">Keep this saved context</a></p>`;
}

function repairPreviewPage(preview) {
  return `<nav><a href="/projects/${encodeURIComponent(preview.project.id)}/saved-context?context_id=${encodeURIComponent(preview.context.id)}">Back to Saved context</a></nav><header class="hero"><p class="eyebrow">Repair saved context</p><h1>Repair ${escapeHtml(preview.project.name)} / ${escapeHtml(preview.context.name)}</h1><p>Classify what is wrong, then remove this exact version from active context. Its value, evidence, provenance, and history remain unchanged. A corrected value must arrive as a new proposal and receive its own exact human confirmation.</p></header><article><h2>${escapeHtml(preview.entry.state_key)}</h2><pre>${renderJson(preview.entry.value)}</pre><p>${escapeHtml(preview.entry.summary)}</p>${provenance(preview.entry)}</article><form method="post" action="/projects/${encodeURIComponent(preview.project.id)}/saved-context/${encodeURIComponent(preview.entry.id)}/repair"><input type="hidden" name="context_id" value="${escapeHtml(preview.context.id)}"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><label>What is wrong?<select name="repair_type" required><option value="stale">Stale: it is no longer current</option><option value="contradicted">Contradicted: reliable information now conflicts with it</option><option value="wrong">Wrong: it should not have been saved as stated</option></select></label><label>Explanation (optional)<textarea name="note" maxlength="450"></textarea></label><button class="destructive" type="submit">Confirm repair and remove from active context</button></form><p><a href="/projects/${encodeURIComponent(preview.project.id)}/saved-context?context_id=${encodeURIComponent(preview.context.id)}">Keep the current saved context</a></p>`;
}

export function createSavedContextRouter({ database }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/:projectId/saved-context/:acceptedStateId/remove", async (request, response) => {
    const preview = await getRemovalPreview(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId: String(request.query.context_id || ""),
      acceptedStateId: request.params.acceptedStateId,
    });
    if (!preview) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Saved context not found</h1><p>The entry may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    response.type("html").send(renderPage("Remove saved context", removalPreviewPage(preview)));
  });

  router.get("/:projectId/saved-context/:acceptedStateId/repair", async (request, response) => {
    const preview = await getRemovalPreview(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId: String(request.query.context_id || ""),
      acceptedStateId: request.params.acceptedStateId,
    });
    if (!preview) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Saved context not found</h1><p>The entry may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    response.type("html").send(renderPage("Repair saved context", repairPreviewPage(preview)));
  });

  router.post("/:projectId/saved-context/:acceptedStateId/repair", async (request, response) => {
    const repairType = String(request.body.repair_type || "");
    const label = REPAIR_TYPES.get(repairType);
    if (!label) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Invalid repair",
            '<h1>Select a valid repair reason.</h1><p>No saved context was changed.</p><p><a href="/">Return to your private workspace</a></p>',
          ),
        );
    }
    const note = String(request.body.note || "").trim();
    if (note.length > 450) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Invalid repair",
            '<h1>Repair explanation exceeds 450 characters.</h1><p>No saved context was changed.</p><p><a href="/">Return to your private workspace</a></p>',
          ),
        );
    }
    let result;
    try {
      result = await removeSavedContextEntry(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        contextId: String(request.body.context_id || ""),
        acceptedStateId: request.params.acceptedStateId,
        expectedPreviewVersion: String(request.body.preview_version || ""),
        reason: `${label}${note ? `: ${note}` : ""}`,
        repairType,
      });
    } catch (error) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Not repaired",
            `<h1>${escapeHtml(String(error))}</h1><p>No saved context was changed.</p><p><a href="/">Return to your private workspace</a></p>`,
            "danger",
          ),
        );
    }
    if (!result) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Saved context not found</h1><p>No saved context was changed.</p><p><a href="/">Return to your private workspace</a></p>',
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
            "Repair changed",
            `<h1>This saved context changed.</h1><p>Nothing was removed or overwritten.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/saved-context?context_id=${encodeURIComponent(String(request.body.context_id || ""))}">Review the current context before repairing it.</a></p>`,
          ),
        );
    }
    response.redirect(
      303,
      `/projects/${encodeURIComponent(result.projectId)}/saved-context?context_id=${encodeURIComponent(result.contextId)}&view=removed`,
    );
  });

  router.post("/:projectId/saved-context/:acceptedStateId/remove", async (request, response) => {
    let result;
    try {
      result = await removeSavedContextEntry(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        contextId: String(request.body.context_id || ""),
        acceptedStateId: request.params.acceptedStateId,
        expectedPreviewVersion: String(request.body.preview_version || ""),
        reason: request.body.reason,
      });
    } catch (error) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Not removed",
            `<h1>${escapeHtml(String(error))}</h1><p>No saved context was changed.</p><p><a href="/">Return to your private workspace</a></p>`,
            "danger",
          ),
        );
    }
    if (!result) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Saved context not found</h1><p>No saved context was changed.</p><p><a href="/">Return to your private workspace</a></p>',
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
            "Removal changed",
            `<h1>This saved context changed.</h1><p>Nothing was removed or overwritten.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/saved-context?context_id=${encodeURIComponent(String(request.body.context_id || ""))}">Review the current context before deciding.</a></p>`,
          ),
        );
    }
    response.redirect(
      303,
      `/projects/${encodeURIComponent(result.projectId)}/saved-context?context_id=${encodeURIComponent(result.contextId)}&view=removed`,
    );
  });

  router.get(["/:projectId/saved", "/:projectId/saved-context"], async (request, response) => {
    const selected = String(request.query.view || "saved");
    const projectOnly = !request.query.context_id;
    if (!VIEWS.has(selected)) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Invalid view",
            '<h1>Invalid saved-context view</h1><p>No saved context was changed.</p><p><a href="/">Return to your private workspace</a></p>',
          ),
        );
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
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Project or context not found</h1><p>The destination may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }

    const content =
      selected === "saved"
        ? savedCards(view, projectOnly)
        : selected === "attention"
          ? attentionCards(view, projectOnly)
          : selected === "removed"
            ? removedCards(view, projectOnly)
            : historyCards(view, projectOnly);
    if (projectOnly) {
      return response
        .type("html")
        .send(
          renderAppPage(
            `${view.project.name} saved information`,
            `<div class="project-home"><header class="project-header"><div><p class="eyebrow">Saved information</p><h1>${escapeHtml(view.project.name)}</h1><p>Human-approved information that alice. can provide to your connected AI tools.</p></div><a href="/projects/${encodeURIComponent(view.project.id)}">Back to project</a></header><nav aria-label="Saved information views">${viewLinks(view, selected, true)}</nav><section><div class="section-heading"><h2>${selected === "saved" ? "Saved information" : selected === "attention" ? "Needs attention" : selected === "removed" ? "Removed" : "History"}</h2><p class="muted">${selected === "saved" ? "Active and human-approved" : selected === "attention" ? "Awaiting your review" : selected === "removed" ? "Inactive, with provenance preserved" : "Decision history"}</p></div>${content}</section></div>`,
            { email: request.aliceUser!.email, activeSection: "projects" },
          ),
        );
    }
    response
      .type("html")
      .send(
        renderPage(
          `${view.project.name} saved context`,
          `<nav><a href="/projects/${encodeURIComponent(view.project.id)}">Project</a><a href="/connections">AI connections</a></nav><header class="hero"><p class="eyebrow">Project intelligence</p><h1>${escapeHtml(view.project.name)} / ${escapeHtml(view.context.name)}</h1><p>${escapeHtml(view.context.description)}</p></header><nav aria-label="Project contexts">${contextLinks(view)}</nav><nav aria-label="Context views">${viewLinks(view, selected)}</nav><section><div class="section-heading"><h2>${selected === "saved" ? "Saved context" : selected === "attention" ? "Needs attention" : selected === "removed" ? "Removed" : "History"}</h2><p class="muted">${selected === "saved" ? "Active, human-confirmed context" : selected === "attention" ? "Awaiting exact human review" : selected === "removed" ? "Inactive, with provenance preserved" : "Immutable decision history"}</p></div>${content}</section>`,
        ),
      );
  });

  return router;
}
