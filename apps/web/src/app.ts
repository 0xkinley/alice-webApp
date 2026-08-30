import express from "express";
import { openDatabase } from "@alice/database";
import {
  ContextBudgetError,
  createProject,
  createWorkContext,
  getProject,
  getProjectContext,
  getPrivateAlphaSignals,
  listArchivedProjects,
  listContextReadEvents,
  listSharedProjects,
  listProjects,
  listWorkContexts,
  suggestSimilarWorkContexts,
} from "@alice/domain";
import { getProjectContextSchema } from "@alice/schemas";
import { createAuthRouter, renderPage, requireAuthenticatedUser } from "./auth.ts";
import { createConnectionsRouter } from "./connections.ts";
import { createContextAccessRouter } from "./context-access.ts";
import { createFilesRouter } from "./files.ts";
import { createProjectLifecycleRouter } from "./project-lifecycle.ts";
import { createProjectMembershipRouter } from "./project-memberships.ts";
import { createReviewRouter } from "./review.ts";
import { createSavedContextRouter } from "./saved-context.ts";
import type { PrivateFileStore } from "@alice/domain";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function contextReadEventCard(event) {
  const route = event.requested_via === "active_target" ? "active target" : "explicit fallback";
  const result =
    event.status === "succeeded"
      ? `Succeeded · package ${escapeHtml(event.package_version)} · ${escapeHtml(event.package_utf8_bytes)} UTF-8 bytes`
      : `Failed · ${escapeHtml(String(event.failure_code).replaceAll("_", " "))}`;
  return `<article><p><strong>${result}</strong></p><p>${escapeHtml(event.client_name)} · ${escapeHtml(event.client_classification)} · ${route}${event.context_name ? ` · ${escapeHtml(event.context_name)}` : ""}</p><p class="muted">${escapeHtml(event.created_at)}</p></article>`;
}

export async function createApp({
  database: suppliedDatabase = undefined,
  databaseUrl,
  publicUrl,
  mcpPublicUrl = publicUrl,
  fileStore = undefined as PrivateFileStore | undefined,
}) {
  const database = suppliedDatabase || (await openDatabase({ connectionString: databaseUrl }));
  const app = express();

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.get("/health", async (_request, response) => {
    try {
      await database.query("SELECT 1");
      response.json({ database: "reachable", service: "alice-web", status: "ok" });
    } catch {
      response.status(503).json({ database: "unreachable", service: "alice-web", status: "error" });
    }
  });
  app.use("/auth", createAuthRouter({ database, publicUrl }));
  app.use("/connections", createConnectionsRouter({ database, mcpPublicUrl }));
  app.use(createProjectMembershipRouter({ database, publicUrl }));
  app.use(createProjectLifecycleRouter({ database }));
  app.use("/projects", createContextAccessRouter({ database }));
  app.get("/", requireAuthenticatedUser(database), async (request, response) => {
    const projects = await listProjects(database, request.aliceUser!.id);
    const sharedProjects = await listSharedProjects(database, request.aliceUser!.id);
    const archivedProjects = await listArchivedProjects(database, request.aliceUser!.id);
    const sharedProjectIds = new Set(sharedProjects.map(({ id }) => id));
    const projectList = projects
      .filter(({ id }) => !sharedProjectIds.has(id))
      .map(
        (project) =>
          `<article><h2><a href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p>${escapeHtml(project.brief)}</p></article>`,
      )
      .join("");
    const sharedProjectList = sharedProjects
      .map(
        (project) =>
          `<article><h2><a href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p>${escapeHtml(project.brief)}</p><p class="muted">Shared with you · ${escapeHtml(project.role)}</p></article>`,
      )
      .join("");
    const archivedProjectList = archivedProjects
      .map(
        (project) =>
          `<article><h3><a href="/projects/${encodeURIComponent(project.id)}/lifecycle">${escapeHtml(project.name)}</a></h3><p>${escapeHtml(project.brief)}</p><p class="muted">Archived ${escapeHtml(project.archived_at)}</p></article>`,
      )
      .join("");
    response
      .type("html")
      .send(
        renderPage(
          "alice. private workspace",
          `<nav><strong>alice.</strong><span>${escapeHtml(request.aliceUser!.email)}</span><a href="/connections">AI connections</a><a href="/review">Review queue</a><a href="/signals">Alpha signals</a><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></nav><h1>Private workspace</h1><p>Projects you create remain anchored to this account and can be shared only through explicit membership.</p>${projectList || "<p>No projects yet.</p>"}<h2>Shared with you</h2>${sharedProjectList || "<p>No shared projects.</p>"}<h2>Archived projects you own</h2>${archivedProjectList || "<p>No archived projects.</p>"}<h2>Create project</h2><form method="post" action="/projects"><label>Name<input name="name" maxlength="120" required></label><label>Brief<textarea name="brief" maxlength="4000" required></textarea></label><button type="submit">Create project</button></form>`,
        ),
      );
  });
  app.get("/signals", requireAuthenticatedUser(database), async (request, response) => {
    const signals = await getPrivateAlphaSignals(database, request.aliceUser!.id);
    if (!signals) {
      return response
        .status(404)
        .type("html")
        .send(renderPage("Not found", "<h1>Signals not found</h1>"));
    }
    const percentage = (value) => (value === null ? "Not enough data" : `${value}%`);
    const duration = (value) => (value === null ? "Not enough data" : `${value} seconds`);
    response
      .type("html")
      .send(
        renderPage(
          "Private alpha signals",
          `<nav><a href="/">Private workspace</a><a href="/connections">AI connections</a></nav><h1>Private alpha signals</h1><p>These aggregate signals use identifiers, status, counts, and timestamps. They do not inspect prompts, model responses, candidate values, evidence payloads, or saved project content.</p><section><h2>Context retrieval</h2><dl><dt>Observed MCP read attempts</dt><dd>${signals.consumption.observed_attempts}</dd><dt>Successful package reads</dt><dd>${signals.consumption.successful_reads}</dd><dt>Failed package reads</dt><dd>${signals.consumption.failed_reads}</dd><dt>Success among observed attempts</dt><dd>${percentage(signals.consumption.success_rate_percent)}</dd><dt>Successful host classifications</dt><dd>${signals.consumption.successful_host_surfaces}</dd><dt>Projects reused across hosts within 7 days</dt><dd>${signals.consumption.projects_reused_across_hosts_within_7_days}</dd><dt>UTC weeks with a successful read</dt><dd>${signals.consumption.active_utc_weeks}</dd><dt>Repeated weekly use</dt><dd>${signals.consumption.repeated_weekly_use ? "Observed" : "Not yet observed"}</dd></dl><p class="muted"><strong>Important limitation:</strong> ${escapeHtml(signals.privacy.limitation)} Therefore this page does not call the observed-attempt success percentage a host invocation rate.</p></section><section><h2>Save and confirmation burden</h2><dl><dt>Save offers received</dt><dd>${signals.saving.offers}</dd><dt>Proposed entries</dt><dd>${signals.saving.proposals}</dd><dt>Confirmed offers</dt><dd>${signals.saving.confirmed_offers}</dd><dt>Cancelled offers</dt><dd>${signals.saving.cancelled_offers}</dd><dt>Still pending</dt><dd>${signals.saving.pending_offers}</dd><dt>Offer completion</dt><dd>${percentage(signals.saving.completion_rate_percent)}</dd><dt>Average entries per offer</dt><dd>${signals.saving.average_proposals_per_offer ?? "Not enough data"}</dd><dt>Median time to confirm or cancel</dt><dd>${duration(signals.saving.median_decision_seconds)}</dd><dt>Saved-context repairs</dt><dd>${signals.saving.repairs}</dd></dl></section>`,
        ),
      );
  });
  app.post("/projects", requireAuthenticatedUser(database), async (request, response) => {
    try {
      const project = await createProject(database, request.aliceUser!.id, request.body);
      if (!project) return response.status(403).send("Authorization denied.");
      response.redirect(303, `/projects/${encodeURIComponent(project.id)}`);
    } catch (error) {
      response
        .status(400)
        .type("html")
        .send(
          renderPage(
            "Project not created",
            `<h1>Project not created</h1><p>${escapeHtml(String(error))}</p>`,
          ),
        );
    }
  });
  app.get("/projects/:projectId", requireAuthenticatedUser(database), async (request, response) => {
    const project = await getProject(database, request.aliceUser!.id, request.params.projectId);
    if (!project) {
      return response
        .status(404)
        .type("html")
        .send(renderPage("Not found", "<h1>Project not found</h1>"));
    }
    const contexts =
      (await listWorkContexts(database, request.aliceUser!.id, request.params.projectId)) || [];
    const contextReadEvents = await listContextReadEvents(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      limit: 10,
    });
    const canWrite = project.project_role === "owner" || project.project_role === "editor";
    const isOwner = project.project_role === "owner";
    const contextCards = contexts
      .map(
        (context) =>
          `<article id="${escapeHtml(context.id)}"><h2>${escapeHtml(context.name)}</h2><p>${escapeHtml(context.description)}</p><p class="muted">${context.context_kind === "project_wide" ? "Included with every selected work context" : "Work context"} · ${escapeHtml(context.visibility)} · your context role: ${escapeHtml(context.context_role)}</p><p><a href="/projects/${encodeURIComponent(project.id)}/saved-context?context_id=${encodeURIComponent(context.id)}">View saved context</a> · <a href="/projects/${encodeURIComponent(project.id)}/context-preview${context.context_kind === "project_wide" ? "" : `?context_id=${encodeURIComponent(context.id)}`}">Preview host package</a>${fileStore ? ` · <a href="/projects/${encodeURIComponent(project.id)}/files?context_id=${encodeURIComponent(context.id)}">Files</a>` : ""}${context.visibility === "selected_members" && context.can_manage ? ` · <a href="/projects/${encodeURIComponent(project.id)}/contexts/${encodeURIComponent(context.id)}/access">Manage context access</a>` : ""}</p></article>`,
      )
      .join("");
    const reviewLink = canWrite
      ? `<p><a href="/review?project_id=${encodeURIComponent(project.id)}">Review candidate claims</a></p>`
      : "";
    const createContext = canWrite
      ? `<h2>Create a work context</h2><form method="post" action="/projects/${encodeURIComponent(project.id)}/contexts/preview"><label>Name<input name="name" maxlength="120" required></label><label>Description<textarea name="description" maxlength="2000" required></textarea></label><label>Visibility<select name="visibility"><option value="all_members">All project members</option><option value="selected_members">Selected members</option><option value="personal">Personal draft</option></select></label><p class="muted">Project Owners do not automatically receive access to selected-member or personal contexts.</p><button type="submit">Check for similar contexts</button></form>`
      : "";
    const collaboratorsLink = isOwner
      ? `<a href="/projects/${encodeURIComponent(project.id)}/collaborators">Collaborators</a>`
      : "";
    const lifecycleLink = isOwner
      ? `<a href="/projects/${encodeURIComponent(project.id)}/lifecycle">Project lifecycle</a>`
      : "";
    const readActivity = contextReadEvents.length
      ? contextReadEvents.map(contextReadEventCard).join("")
      : "<p>No host context read has been recorded for your AI connections in this project. This does not mean a host consulted alice.</p>";
    response
      .type("html")
      .send(
        renderPage(
          project.name,
          `<nav><a href="/">Private workspace</a><a href="/connections">AI connections</a><a href="/projects/${encodeURIComponent(project.id)}/access">Your access</a>${collaboratorsLink}${lifecycleLink}</nav><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.brief)}</p><p class="muted">Your project role: ${escapeHtml(project.project_role)}</p>${reviewLink}<h2>Project and work contexts</h2><p>Only contexts listed here are visible to you. Project-wide saved context is included with whichever work context you select for an AI connection.</p>${contextCards}<h2>Your recent host reads</h2><p>These receipts show retrieval through your own AI connections. A successful retrieval does not prove the host used the context in its answer.</p>${readActivity}${createContext}`,
        ),
      );
  });
  const renderContextPreview = async (request, response, input) => {
    const parsed = getProjectContextSchema.safeParse({
      project_id: request.params.projectId,
      context_id:
        typeof input.context_id === "string" && input.context_id ? input.context_id : undefined,
      task:
        typeof input.task === "string" && input.task.trim()
          ? input.task
          : "Preview the exact host context package",
      context_budget:
        typeof input.context_budget === "string" ? Number(input.context_budget) : undefined,
    });
    if (!parsed.success) {
      return response
        .status(400)
        .type("html")
        .send(
          renderPage(
            "Invalid preview",
            `<h1>Invalid package preview request</h1><p>${escapeHtml(parsed.error.issues[0]?.message || "Invalid input")}</p>`,
          ),
        );
    }
    let packagePreview;
    try {
      packagePreview = await getProjectContext(database, {
        userId: request.aliceUser!.id,
        projectId: parsed.data.project_id,
        contextId: parsed.data.context_id,
        task: parsed.data.task,
        contextBudget: parsed.data.context_budget,
        fileTextReadAvailable: Boolean(fileStore),
      });
    } catch (error) {
      if (error instanceof ContextBudgetError) {
        return response
          .status(422)
          .type("html")
          .send(
            renderPage(
              "Package does not fit",
              `<h1>Package does not fit this byte budget</h1><p>${escapeHtml(error.message)}</p>`,
            ),
          );
      }
      throw error;
    }
    if (!packagePreview) {
      return response
        .status(404)
        .type("html")
        .send(renderPage("Not found", "<h1>Project or context not found</h1>"));
    }
    response
      .type("html")
      .send(
        renderPage(
          "Host package preview",
          `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}">Back to project</a></nav><h1>Exact host package preview</h1><p>This is the deterministic JSON alice. would return for this task and byte budget. Opening this preview does not create a host-read receipt and does not mean an AI host consulted alice.</p><form method="post"><input type="hidden" name="context_id" value="${escapeHtml(parsed.data.context_id || "")}"><label>Task<input name="task" maxlength="2000" value="${escapeHtml(parsed.data.task)}" required></label><label>UTF-8 byte budget<input name="context_budget" type="number" min="2000" max="32000" value="${escapeHtml(parsed.data.context_budget)}" required></label><button type="submit">Refresh preview</button></form><dl><dt>Package version</dt><dd>${escapeHtml(packagePreview.package.version)}</dd><dt>Budget</dt><dd>${escapeHtml(packagePreview.package.budget.used)} of ${escapeHtml(packagePreview.package.budget.limit)} UTF-8 bytes</dd><dt>Freshness</dt><dd><pre>${escapeHtml(JSON.stringify(packagePreview.package.freshness, null, 2))}</pre></dd><dt>Omitted entries</dt><dd>${escapeHtml(packagePreview.package.omissions.total)}</dd></dl><pre>${escapeHtml(JSON.stringify(packagePreview, null, 2))}</pre>`,
        ),
      );
  };
  app.get(
    "/projects/:projectId/context-preview",
    requireAuthenticatedUser(database),
    (request, response) =>
      renderContextPreview(request, response, { context_id: request.query.context_id }),
  );
  app.post(
    "/projects/:projectId/context-preview",
    requireAuthenticatedUser(database),
    (request, response) => renderContextPreview(request, response, request.body),
  );
  app.post(
    "/projects/:projectId/contexts/preview",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const suggestions = await suggestSimilarWorkContexts(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          input: request.body,
        });
        if (!suggestions) {
          return response
            .status(404)
            .type("html")
            .send(renderPage("Not found", "<h1>Project not found</h1>"));
        }
        const similar = suggestions.length
          ? `<h2>Similar contexts</h2><p>Nothing is grouped or moved automatically. You can return to one of these contexts instead.</p>${suggestions
              .map(
                (context) =>
                  `<article><h3><a href="/projects/${encodeURIComponent(request.params.projectId)}#${encodeURIComponent(context.id)}">${escapeHtml(context.name)}</a></h3><p>${escapeHtml(context.description)}</p></article>`,
              )
              .join("")}`
          : "<p>No similar work context was found.</p>";
        response
          .type("html")
          .send(
            renderPage(
              "Confirm work context",
              `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}">Back to project</a></nav><h1>Confirm new work context</h1>${similar}<article><h2>${escapeHtml(request.body.name)}</h2><p>${escapeHtml(request.body.description)}</p><p>Visibility: ${escapeHtml(request.body.visibility)}</p></article><form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/contexts"><input type="hidden" name="name" value="${escapeHtml(request.body.name)}"><input type="hidden" name="description" value="${escapeHtml(request.body.description)}"><input type="hidden" name="visibility" value="${escapeHtml(request.body.visibility)}"><button type="submit">Create this work context</button></form>`,
            ),
          );
      } catch (error) {
        response
          .status(400)
          .type("html")
          .send(renderPage("Invalid work context", `<h1>${escapeHtml(String(error))}</h1>`));
      }
    },
  );
  app.post(
    "/projects/:projectId/contexts",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const context = await createWorkContext(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          input: request.body,
        });
        if (!context) {
          return response
            .status(404)
            .type("html")
            .send(renderPage("Not found", "<h1>Project not found</h1>"));
        }
        response.redirect(
          303,
          `/projects/${encodeURIComponent(request.params.projectId)}#${encodeURIComponent(context.id)}`,
        );
      } catch (error) {
        response
          .status(400)
          .type("html")
          .send(renderPage("Work context not created", `<h1>${escapeHtml(String(error))}</h1>`));
      }
    },
  );
  app.use("/projects", createSavedContextRouter({ database }));
  if (fileStore) app.use("/projects", createFilesRouter({ database, fileStore, publicUrl }));
  app.use("/review", createReviewRouter({ database }));

  return { app, database };
}
