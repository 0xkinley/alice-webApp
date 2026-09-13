import express from "express";
import { getProjectMigrationStatus } from "@alice/domain";
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
      const body = `<div class="project-home">${renderProjectShell({ shell, fileStore })}<section><div class="section-heading"><div><p class="eyebrow">Project migration</p><h2>${escapeHtml(status.status === "COMPLETE" ? "Ready in Alice" : status.status)}</h2></div><p class="muted">Updated ${localTimestamp(status.updated_at)}</p></div><p>This is backend-authoritative status for the material supplied to Alice. The original ${status.source.provider === "chatgpt" ? "ChatGPT" : "Claude"} project remains unchanged.</p><div class="signal-grid">${fidelityItem("Observed", fidelity.observed)}${fidelityItem("Retained", fidelity.imported)}${fidelityItem("Exact bytes", fidelity.exact_bytes)}${fidelityItem("Content only", fidelity.content_only)}${fidelityItem("References", fidelity.references)}${fidelityItem("Missing", fidelity.missing)}${fidelityItem("External", fidelity.external)}${fidelityItem("Unsupported", fidelity.unsupported)}${fidelityItem("Alice-confirmed", fidelity.alice_confirmed)}</div>${status.error_summary ? `<p class="error" role="alert">${escapeHtml(status.error_summary)}</p>` : ""}<aside class="callout"><h3>Fidelity boundary</h3><p>These counts describe only the supplied scope. They are not proof that Alice accessed the complete provider project. Host-derived material remains unverified data until a separate Alice-native confirmation.</p></aside><aside class="callout"><h3>Add material safely</h3><p>${canAddFiles ? "Use Add files above to select exact local files through Alice's existing private, scan-gated upload." : "File enrichment is unavailable on this deployment or for your current access."} Provider-export archives and unknown formats are not silently parsed. Filter unrelated account history locally before uploading any relevant file.</p></aside></section></div>`;
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
