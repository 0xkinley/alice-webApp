import express from "express";
import { getProjectImportedMaterial, getProjectMigrationStatus } from "@alice/domain";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { localTimestamp } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";
import type { PrivateFileStore } from "@alice/domain";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fidelityItem(label: string, value: number): string {
  return `<div class="signal-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function providerName(provider: unknown): string {
  return provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "AI platform";
}

function readableLabel(value: unknown): string {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function captureCopy(state: string): string {
  if (state === "reference") return "Reference only · Original content or bytes unavailable";
  if (state === "missing") return "Reported missing · Content unavailable";
  if (state === "external") return "External · Not stored in Alice";
  return "Content only · Original bytes unavailable";
}

function importedSession(session): string {
  const fidelity = session.fidelity;
  const sourceName = providerName(session.source.provider);
  const itemList = session.items
    .map(
      (item) =>
        `<li><article class="imported-item"><div class="imported-item-meta"><span class="badge">${escapeHtml(readableLabel(item.kind))}</span><span>${escapeHtml(captureCopy(item.capture_state))}</span>${item.speaker ? `<span>Speaker · ${escapeHtml(item.speaker)}</span>` : ""}${item.occurred_at ? `<span>Source time · ${escapeHtml(item.occurred_at)}</span>` : ""}</div><div class="artifact-body">${escapeHtml(item.content)}</div><p class="muted">Unverified host-derived material · Item ${escapeHtml(item.position)}</p></article></li>`,
    )
    .join("");
  const sourceWarning = session.source_readable
    ? ""
    : '<p class="notice danger" role="alert">At least one retained source record could not be displayed safely. The immutable record remains preserved for authorized export and investigation.</p>';
  const status =
    session.status === "COMPLETE" ? "Ready for supplied scope" : readableLabel(session.status);
  return `<section class="import-session"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(sourceName)} import</p><h2>${escapeHtml(session.source.project_name || "Provider project name not supplied")}</h2></div><span class="badge">${escapeHtml(status)}</span></div><dl><dt>Imported</dt><dd>${localTimestamp(session.created_at)}</dd><dt>Authority</dt><dd>Unverified host-derived material</dd><dt>Source scope</dt><dd>Unknown</dd><dt>Completeness</dt><dd>Unknown</dd></dl><aside class="notice warning"><strong>Legacy acquisition boundary</strong><p>This import predates Alice's bounded source-scope fields. Alice cannot establish whether the supplied material represented a provider project, one conversation, or another bounded selection. Counts describe only what Alice received.</p></aside><div class="signal-grid">${fidelityItem("Observed", fidelity.observed)}${fidelityItem("Retained", fidelity.imported)}${fidelityItem("Exact bytes", fidelity.exact_bytes)}${fidelityItem("Content only", fidelity.content_only)}${fidelityItem("References", fidelity.references)}${fidelityItem("Missing", fidelity.missing)}${fidelityItem("External", fidelity.external)}${fidelityItem("Alice-confirmed", fidelity.alice_confirmed)}</div>${sourceWarning}${itemList ? `<ol class="imported-material-list">${itemList}</ol>` : '<div class="empty-state"><h3>No readable imported items</h3><p>The migration record is retained, but no source item can be safely displayed from this session.</p></div>'}</section>`;
}

export function createProjectMigrationsRouter({
  database,
  fileStore,
  publicUrl,
}: {
  database: any;
  fileStore?: PrivateFileStore | undefined;
  publicUrl: string;
}) {
  const router = express.Router();
  const authenticated = requireAuthenticatedUser(database);

  router.get("/:projectId/imported", authenticated, async (request, response) => {
    const view = await getProjectImportedMaterial(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
    });
    if (!view) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Imported material unavailable",
            "This project is unavailable or outside your access.",
            "neutral",
          ),
        );
    }
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) return response.status(404).end();
    const sessions = view.sessions.map(importedSession).join("");
    const body = `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "imported" })}<section><div class="section-heading"><div><p class="eyebrow">Immutable source</p><h2>Imported material</h2></div><p class="muted">${view.sessions.length} ${view.sessions.length === 1 ? "import session" : "import sessions"}</p></div><p>This page shows exactly the migration material Alice retained. It is readable source evidence, not accepted project information. Opening this page creates no artifact, file, proposal, or trusted-state change.</p>${sessions || '<div class="empty-state"><h3>No imported material</h3><p>This project has no retained migration source. Files and information saved through other Alice flows remain in their existing tabs.</p></div>'}</section></div>`;
    response
      .type("html")
      .set("Cache-Control", "no-store")
      .send(
        renderAppPage("Imported material", body, {
          email: request.aliceUser!.email,
          activeSection: "projects",
        }),
      );
  });

  router.get(
    "/:projectId/migrations/:migrationSessionId",
    authenticated,
    async (request, response) => {
      const status = await getProjectMigrationStatus(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        migrationSessionId: request.params.migrationSessionId,
        publicUrl,
      });
      if (!status) {
        return response
          .status(404)
          .type("html")
          .send(
            renderStatusPage(
              "Migration unavailable",
              "This migration is unavailable or outside your access.",
              "neutral",
            ),
          );
      }
      const shell = await getProjectShell(
        database,
        request.aliceUser!.id,
        request.params.projectId,
      );
      if (!shell) return response.status(404).end();
      const fidelity = status.fidelity;
      const canAddFiles = Boolean(
        fileStore &&
        shell.uploadEnabled &&
        (shell.project.project_role === "owner" || shell.project.project_role === "editor"),
      );
      const body = `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "imported" })}<section><div class="section-heading"><div><p class="eyebrow">Project migration</p><h2>${escapeHtml(status.status === "COMPLETE" ? "Ready in Alice" : status.status)}</h2></div><p class="muted">Updated ${localTimestamp(status.updated_at)}</p></div><p>This is backend-authoritative status for the material supplied to Alice. The original ${status.source.provider === "chatgpt" ? "ChatGPT" : "Claude"} project remains unchanged.</p><div class="signal-grid">${fidelityItem("Observed", fidelity.observed)}${fidelityItem("Retained", fidelity.imported)}${fidelityItem("Exact bytes", fidelity.exact_bytes)}${fidelityItem("Content only", fidelity.content_only)}${fidelityItem("References", fidelity.references)}${fidelityItem("Missing", fidelity.missing)}${fidelityItem("External", fidelity.external)}${fidelityItem("Unsupported", fidelity.unsupported)}${fidelityItem("Alice-confirmed", fidelity.alice_confirmed)}</div>${status.error_summary ? `<p class="error" role="alert">${escapeHtml(status.error_summary)}</p>` : ""}<aside class="callout"><h3>Fidelity boundary</h3><p>These counts describe only the supplied scope. They are not proof that Alice accessed the complete provider project. Host-derived material remains unverified data until a separate Alice-native confirmation.</p></aside><aside class="callout"><h3>Add material safely</h3><p>${canAddFiles ? "Use Add files above to select exact local files through Alice's existing private, scan-gated upload." : "File enrichment is unavailable on this deployment or for your current access."} Provider-export archives and unknown formats are not silently parsed. Filter unrelated account history locally before uploading any relevant file.</p></aside></section></div>`;
      response
        .type("html")
        .set("Cache-Control", "no-store")
        .send(
          renderAppPage("Project migration", body, {
            email: request.aliceUser!.email,
            activeSection: "projects",
          }),
        );
    },
  );

  return router;
}
