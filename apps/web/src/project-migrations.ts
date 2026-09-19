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

function sourceScopeCopy(scope: string): string {
  if (scope === "conversation") return "One supplied conversation";
  if (scope === "provider_project") return "Provider project material";
  return "Not established from supplied evidence";
}

function scopeBasisCopy(basis: string): string {
  return basis === "unavailable" ? "No supported scope evidence supplied" : readableLabel(basis);
}

function scopeCompletenessCopy(completeness: string): string {
  return completeness === "unknown"
    ? "Not established for the original source"
    : readableLabel(completeness);
}

function itemGroup(kind: string): string {
  if (kind === "message") return "Conversations";
  if (kind === "instruction") return "Instructions";
  if (kind === "artifact" || kind === "artifact_reference" || kind === "file_reference") {
    return "Artifacts and file references";
  }
  return "Other supplied material";
}

function importedItems(items): string {
  const groups = new Map<string, any[]>();
  for (const item of items) {
    const group = itemGroup(item.kind);
    groups.set(group, [...(groups.get(group) || []), item]);
  }
  return [...groups.entries()]
    .map(
      ([group, grouped]) =>
        `<section class="imported-group"><h3>${escapeHtml(group)}</h3><ol class="imported-material-list">${grouped
          .map((item) => {
            const artifactReference = item.kind === "artifact_reference";
            const kind = artifactReference ? "Artifact description" : readableLabel(item.kind);
            const representation = artifactReference
              ? "Original artifact not established"
              : readableLabel(item.representation);
            const completeness =
              artifactReference && item.completeness === "complete"
                ? "Supplied description retained"
                : readableLabel(item.completeness);
            const capture =
              artifactReference && item.capture_state === "content_only"
                ? "Text supplied · Original artifact and file bytes unverified"
                : captureCopy(item.capture_state);
            const artifactBoundary = artifactReference
              ? '<p class="muted">Alice retained this description as source evidence. The host did not identify it as the complete original artifact, so it was not added to Artifacts.</p>'
              : "";
            return `<li><article class="imported-item"><div class="imported-item-meta"><span class="badge">${escapeHtml(kind)}</span><span>${escapeHtml(representation)}</span><span>${escapeHtml(completeness)}</span><span>${escapeHtml(capture)}</span>${item.speaker ? `<span>Speaker · ${escapeHtml(item.speaker)}</span>` : ""}${item.occurred_at ? `<span>Source time · ${escapeHtml(item.occurred_at)}</span>` : ""}</div>${item.title ? `<h4>${escapeHtml(item.title)}</h4>` : ""}<div class="artifact-body">${escapeHtml(item.content)}</div>${artifactBoundary}<p class="muted">Unverified source material · Item ${escapeHtml(item.position)}</p></article></li>`;
          })
          .join("")}</ol></section>`,
    )
    .join("");
}

function importedSession(session): string {
  const fidelity = session.fidelity;
  const sourceName = providerName(session.source.provider);
  const itemList = importedItems(session.items);
  const sourceWarning = session.source_readable
    ? ""
    : '<p class="notice danger" role="alert">At least one retained source record could not be displayed safely. The immutable record remains preserved for authorized export and investigation.</p>';
  const status =
    session.status === "COMPLETE" ? "Ready for supplied scope" : readableLabel(session.status);
  const boundary = session.scope.legacy
    ? `<aside class="notice warning"><strong>Legacy acquisition boundary</strong><p>This import predates Alice's bounded source-scope fields. Alice cannot establish whether the supplied material represented a provider project, one conversation, or another bounded selection. Counts describe only what Alice received.</p></aside>`
    : `<aside class="notice warning"><strong>Acquisition boundary</strong><p>${session.scope.source_scope === "conversation" ? "Alice received one supplied conversation; no surrounding provider project context was established." : "The host did not provide evidence strong enough for Alice to claim a complete provider project."} Completeness is ${escapeHtml(readableLabel(session.scope.scope_completeness))}; counts describe only what Alice received.</p></aside>`;
  return `<section class="import-session"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(sourceName)} import</p><h2>${escapeHtml(session.source.project_name || "Provider project name not supplied")}</h2></div><span class="badge">${escapeHtml(status)}</span></div><dl><dt>Imported</dt><dd>${localTimestamp(session.created_at)}</dd><dt>Authority</dt><dd>Unverified host-derived material</dd><dt>Source scope</dt><dd>${escapeHtml(sourceScopeCopy(session.scope.source_scope))}</dd><dt>Scope basis</dt><dd>${escapeHtml(scopeBasisCopy(session.scope.scope_basis))}</dd><dt>Completeness</dt><dd>${escapeHtml(scopeCompletenessCopy(session.scope.scope_completeness))}</dd><dt>Destination action</dt><dd>${escapeHtml(readableLabel(session.destination_action))}</dd></dl>${boundary}<div class="signal-grid">${fidelityItem("Observed", fidelity.observed)}${fidelityItem("Retained", fidelity.imported)}${fidelityItem("Exact bytes", fidelity.exact_bytes)}${fidelityItem("Content only", fidelity.content_only)}${fidelityItem("References", fidelity.references)}${fidelityItem("Missing", fidelity.missing)}${fidelityItem("External", fidelity.external)}${fidelityItem("Alice-confirmed", fidelity.alice_confirmed)}</div>${sourceWarning}${itemList || '<div class="empty-state"><h3>No imported source retained</h3><p>This project was created empty, or no source item can be displayed safely.</p></div>'}</section>`;
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
