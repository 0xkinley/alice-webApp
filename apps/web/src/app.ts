import express from "express";
import { openDatabase } from "@alice/database";
import { createProject, getProject, listProjects } from "@alice/domain";
import { createAuthRouter, renderPage, requireAuthenticatedUser } from "./auth.ts";
import { createReviewRouter } from "./review.ts";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function createApp({
  database: suppliedDatabase = undefined,
  databaseFilename = ":memory:",
  publicUrl,
}) {
  const database = suppliedDatabase || openDatabase(databaseFilename);
  const app = express();

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.get("/health", (_request, response) => {
    response.json({ service: "alice-web", status: "ok" });
  });
  app.use("/auth", createAuthRouter({ database, publicUrl }));
  app.get("/", requireAuthenticatedUser(database), (request, response) => {
    const projects = listProjects(database, request.aliceUser!.id);
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
          `<nav><strong>alice.</strong><span>${escapeHtml(request.aliceUser!.email)}</span><a href="/review">Review queue</a><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></nav><h1>Private workspace</h1><p>Projects remain private to this account.</p>${projectList || "<p>No projects yet.</p>"}<h2>Create project</h2><form method="post" action="/projects"><label>Name<input name="name" maxlength="120" required></label><label>Brief<textarea name="brief" maxlength="4000" required></textarea></label><button type="submit">Create project</button></form>`,
        ),
      );
  });
  app.post("/projects", requireAuthenticatedUser(database), (request, response) => {
    try {
      const project = createProject(database, request.aliceUser!.id, request.body);
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
  app.get("/projects/:projectId", requireAuthenticatedUser(database), (request, response) => {
    const project = getProject(database, request.aliceUser!.id, request.params.projectId);
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
