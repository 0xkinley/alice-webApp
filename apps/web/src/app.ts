import express from "express";
import { openDatabase } from "@alice/database";
import {
  createProject,
  createWorkContext,
  getProject,
  listSharedProjects,
  listProjects,
  listWorkContexts,
  suggestSimilarWorkContexts,
} from "@alice/domain";
import { createAuthRouter, renderPage, requireAuthenticatedUser } from "./auth.ts";
import { createConnectionsRouter } from "./connections.ts";
import { createContextAccessRouter } from "./context-access.ts";
import { createFilesRouter } from "./files.ts";
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
  app.use("/projects", createContextAccessRouter({ database }));
  app.get("/", requireAuthenticatedUser(database), async (request, response) => {
    const projects = await listProjects(database, request.aliceUser!.id);
    const sharedProjects = await listSharedProjects(database, request.aliceUser!.id);
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
    response
      .type("html")
      .send(
        renderPage(
          "alice. private workspace",
          `<nav><strong>alice.</strong><span>${escapeHtml(request.aliceUser!.email)}</span><a href="/connections">AI connections</a><a href="/review">Review queue</a><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></nav><h1>Private workspace</h1><p>Projects you create remain anchored to this account and can be shared only through explicit membership.</p>${projectList || "<p>No projects yet.</p>"}<h2>Shared with you</h2>${sharedProjectList || "<p>No shared projects.</p>"}<h2>Create project</h2><form method="post" action="/projects"><label>Name<input name="name" maxlength="120" required></label><label>Brief<textarea name="brief" maxlength="4000" required></textarea></label><button type="submit">Create project</button></form>`,
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
    const canWrite = project.project_role === "owner" || project.project_role === "editor";
    const isOwner = project.project_role === "owner";
    const contextCards = contexts
      .map(
        (context) =>
          `<article id="${escapeHtml(context.id)}"><h2>${escapeHtml(context.name)}</h2><p>${escapeHtml(context.description)}</p><p class="muted">${context.context_kind === "project_wide" ? "Included with every selected work context" : "Work context"} · ${escapeHtml(context.visibility)} · your context role: ${escapeHtml(context.context_role)}</p><p><a href="/projects/${encodeURIComponent(project.id)}/saved-context?context_id=${encodeURIComponent(context.id)}">View saved context</a>${fileStore ? ` · <a href="/projects/${encodeURIComponent(project.id)}/files?context_id=${encodeURIComponent(context.id)}">Files</a>` : ""}${context.visibility === "selected_members" && context.can_manage ? ` · <a href="/projects/${encodeURIComponent(project.id)}/contexts/${encodeURIComponent(context.id)}/access">Manage context access</a>` : ""}</p></article>`,
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
    response
      .type("html")
      .send(
        renderPage(
          project.name,
          `<nav><a href="/">Private workspace</a><a href="/connections">AI connections</a><a href="/projects/${encodeURIComponent(project.id)}/access">Your access</a>${collaboratorsLink}</nav><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.brief)}</p><p class="muted">Your project role: ${escapeHtml(project.project_role)}</p>${reviewLink}<h2>Project and work contexts</h2><p>Only contexts listed here are visible to you. Project-wide saved context is included with whichever work context you select for an AI connection.</p>${contextCards}${createContext}`,
        ),
      );
  });
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
