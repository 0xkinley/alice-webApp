import { getRemovalPreview, getSavedContextView, removeSavedContextEntry } from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import express from "express";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { escapeHtml, readableLabel, readableText, renderReadableValue } from "./human-readable.ts";
import { hostLabel, timestampLabel } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";

const VIEWS = new Set(["saved", "attention", "removed", "history"]);
const REPAIR_TYPES = new Map([
  ["stale", "Stale"],
  ["contradicted", "Contradicted"],
  ["wrong", "Wrong"],
]);

function changeTimestamp(entry) {
  return entry.removed_at || entry.accepted_at || entry.created_at;
}

function localTimestamp(value) {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? "" : date.toISOString();
  return `<time datetime="${escapeHtml(iso)}" data-local-time>${escapeHtml(timestampLabel(value))}</time>`;
}

function localTimeScript() {
  return `<script>(()=>{const formatter=new Intl.DateTimeFormat(undefined,{year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});for(const time of document.querySelectorAll("time[data-local-time]")){const date=new Date(time.dateTime);if(!Number.isNaN(date.getTime()))time.textContent=formatter.format(date)}})();</script>`;
}

function changeLogCards(entries) {
  if (entries.length === 0)
    return '<div class="empty-state"><h2>No changes yet</h2><p>Project updates from your connected AI tools will appear here after review.</p></div>';
  const labels = { accepted: "Saved", pending: "Proposed", rejected: "Not saved" };
  return `<div class="change-log-list">${entries
    .map((entry) => {
      const state = entry.removed_at
        ? "Removed"
        : entry.superseded_by_version
          ? "Replaced"
          : labels[entry.status] || "Updated";
      const reason = readableText(entry.removal_reason || "");
      const reviewLink =
        entry.status === "pending"
          ? `<p><a href="/review/captures/${encodeURIComponent(entry.evidence_id)}">Review proposed change</a></p>`
          : "";
      return `<article class="change-entry"><div class="change-entry-meta"><span class="badge">${state}</span><span>From ${escapeHtml(hostLabel(entry.client_classification))}</span><span>${localTimestamp(changeTimestamp(entry))}</span></div><h2>${escapeHtml(readableLabel(entry.state_key))}</h2><div class="change-entry-value">${renderReadableValue(entry.value)}</div>${reason ? `<p><strong>Removal reason:</strong> ${escapeHtml(reason)}</p>` : ""}${reviewLink}</article>`;
    })
    .join("")}</div>`;
}

async function projectChangeLog(database, userId, initialView) {
  const entries = new Map();
  for (const context of initialView.contexts) {
    const contextView =
      context.id === initialView.context.id
        ? initialView
        : await getSavedContextView(database, {
            userId,
            projectId: initialView.project.id,
            contextId: context.id,
          });
    for (const entry of contextView?.history || []) {
      const current = entries.get(entry.id);
      if (
        !current ||
        new Date(changeTimestamp(entry)).getTime() > new Date(changeTimestamp(current)).getTime()
      ) {
        entries.set(entry.id, entry);
      }
    }
  }
  return [...entries.values()].sort(
    (left, right) =>
      new Date(changeTimestamp(right)).getTime() - new Date(changeTimestamp(left)).getTime(),
  );
}

function provenance(entry) {
  return `<details><summary>Source and history</summary><dl><dt>Source</dt><dd>${escapeHtml(hostLabel(entry.client_classification))}</dd><dt>Saved</dt><dd>${localTimestamp(entry.accepted_at)}</dd><dt>Revision</dt><dd>${entry.version}</dd></dl></details>`;
}

function removalPreviewPage(preview) {
  return `<section><div class="section-heading"><div><p class="eyebrow">Remove information</p><h2>Remove this from the project?</h2></div></div><p>This stops the item from being used as current project information. It does not erase the saved version, its source, or its history.</p><article><h3>${escapeHtml(readableLabel(preview.entry.state_key))}</h3><div class="readable-value">${renderReadableValue(preview.entry.value)}</div><p>${escapeHtml(readableText(preview.entry.summary))}</p>${provenance(preview.entry)}</article><form method="post" action="/projects/${encodeURIComponent(preview.project.id)}/saved-context/${encodeURIComponent(preview.entry.id)}/remove"><input type="hidden" name="context_id" value="${escapeHtml(preview.context.id)}"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><label>Reason (optional)<textarea name="reason" maxlength="500"></textarea></label><button class="destructive" type="submit">Remove from project</button></form><p><a href="/projects/${encodeURIComponent(preview.project.id)}/changes">Keep this information</a></p></section>`;
}

function repairPreviewPage(preview) {
  return `<section><div class="section-heading"><div><p class="eyebrow">Correct project information</p><h2>What needs to change?</h2></div></div><p>Classify what is wrong, then remove this exact revision from current project information. Its value, source, and history remain unchanged. A correction must arrive as a new proposal and receive its own confirmation.</p><article><h3>${escapeHtml(readableLabel(preview.entry.state_key))}</h3><div class="readable-value">${renderReadableValue(preview.entry.value)}</div><p>${escapeHtml(readableText(preview.entry.summary))}</p>${provenance(preview.entry)}</article><form method="post" action="/projects/${encodeURIComponent(preview.project.id)}/saved-context/${encodeURIComponent(preview.entry.id)}/repair"><input type="hidden" name="context_id" value="${escapeHtml(preview.context.id)}"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><label>What is wrong?<select name="repair_type" required><option value="stale">Stale: it is no longer current</option><option value="contradicted">Contradicted: reliable information now conflicts with it</option><option value="wrong">Wrong: it should not have been saved as stated</option></select></label><label>Explanation (optional)<textarea name="note" maxlength="450"></textarea></label><button class="destructive" type="submit">Confirm and remove</button></form><p><a href="/projects/${encodeURIComponent(preview.project.id)}/changes">Keep the current information</a></p></section>`;
}

export function createSavedContextRouter({
  database,
  fileStore,
}: {
  database: unknown;
  fileStore?: PrivateFileStore | undefined;
}) {
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
            '<h1>Project information not found</h1><p>The entry may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) return response.status(404).end();
    response
      .type("html")
      .send(
        renderAppPage(
          "Remove project information",
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "changes" })}${removalPreviewPage(preview)}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
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
            '<h1>Project information not found</h1><p>The entry may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) return response.status(404).end();
    response
      .type("html")
      .send(
        renderAppPage(
          "Correct project information",
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "changes" })}${repairPreviewPage(preview)}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
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
            '<h1>Select a valid repair reason.</h1><p>No project information was changed.</p><p><a href="/">Return to your private workspace</a></p>',
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
            '<h1>Repair explanation exceeds 450 characters.</h1><p>No project information was changed.</p><p><a href="/">Return to your private workspace</a></p>',
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
            `<h1>${escapeHtml(String(error))}</h1><p>No project information was changed.</p><p><a href="/">Return to your private workspace</a></p>`,
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
            '<h1>Project information not found</h1><p>No project information was changed.</p><p><a href="/">Return to your private workspace</a></p>',
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
            `<h1>This project information changed.</h1><p>Nothing was removed or overwritten.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/changes">Review the current change log before repairing it.</a></p>`,
          ),
        );
    }
    response.redirect(303, `/projects/${encodeURIComponent(result.projectId)}/changes`);
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
            `<h1>${escapeHtml(String(error))}</h1><p>No project information was changed.</p><p><a href="/">Return to your private workspace</a></p>`,
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
            '<h1>Project information not found</h1><p>No project information was changed.</p><p><a href="/">Return to your private workspace</a></p>',
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
            `<h1>This project information changed.</h1><p>Nothing was removed or overwritten.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/changes">Review the current change log before deciding.</a></p>`,
          ),
        );
    }
    response.redirect(303, `/projects/${encodeURIComponent(result.projectId)}/changes`);
  });

  router.get(
    ["/:projectId/changes", "/:projectId/saved", "/:projectId/saved-context"],
    async (request, response) => {
      const changeLog = request.path.endsWith("/changes") && !request.query.context_id;
      const selected = String(request.query.view || "saved");
      if (!VIEWS.has(selected)) {
        return response
          .status(400)
          .type("html")
          .send(
            renderStatusPage(
              "Invalid view",
              '<h1>Invalid change-log view</h1><p>No project information was changed.</p><p><a href="/">Return to your private workspace</a></p>',
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
              '<h1>Project not found</h1><p>The project may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
              "neutral",
            ),
          );
      }

      if (!changeLog) {
        return response.redirect(303, `/projects/${encodeURIComponent(view.project.id)}/changes`);
      }
      const content = changeLogCards(await projectChangeLog(database, request.aliceUser!.id, view));
      const shell = await getProjectShell(
        database,
        request.aliceUser!.id,
        String(request.params.projectId),
      );
      return response
        .type("html")
        .send(
          renderAppPage(
            `${view.project.name} change log`,
            `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "changes" })}<section><div class="section-heading"><h2>Latest changes</h2><p class="muted">Shown in your local time</p></div>${content}</section></div>${localTimeScript()}`,
            { email: request.aliceUser!.email, activeSection: "projects" },
          ),
        );
    },
  );

  return router;
}
