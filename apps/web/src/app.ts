import express from "express";
import { openDatabase } from "@alice/database";
import { createProject, getProject, listProjects } from "@alice/domain";
import { createAuthRouter, renderPage, requireAuthenticatedUser } from "./auth.ts";
import { createConnectionsRouter } from "./connections.ts";
import { createReviewRouter } from "./review.ts";

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
  app.get("/", requireAuthenticatedUser(database), async (request, response) => {
    const projects = await listProjects(database, request.aliceUser!.id);
    const projectList = projects
      .map(
        (project) =>
          `<article><h2><a href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p>${escapeHtml(project.brief)}</p></article>`,
      )
      .join("");
    response
      .type("html")
      .send(
        renderPage(
          "alice. private workspace",
          `<nav><strong>alice.</strong><span>${escapeHtml(request.aliceUser!.email)}</span><a href="/connections">AI connections</a><a href="/review">Review queue</a><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></nav><h1>Private workspace</h1><p>Projects remain private to this account.</p>${projectList || "<p>No projects yet.</p>"}<h2>Create project</h2><form method="post" action="/projects"><label>Name<input name="name" maxlength="120" required></label><label>Brief<textarea name="brief" maxlength="4000" required></textarea></label><button type="submit">Create project</button></form>`,
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
    response
      .type("html")
      .send(
        renderPage(
          project.name,
          `<nav><a href="/">Private workspace</a></nav><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.brief)}</p><p><a href="/review?project_id=${encodeURIComponent(project.id)}">Review candidate claims</a></p>`,
        ),
      );
  });
  app.use("/review", createReviewRouter({ database }));

  return { app, database };
}
