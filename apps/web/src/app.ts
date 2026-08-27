import express from "express";
import { openDatabase } from "@alice/database";
import { createAuthRouter, renderPage, requireAuthenticatedUser } from "./auth.ts";
import { createReviewRouter } from "./review.ts";

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
    response
      .type("html")
      .send(
        renderPage(
          "alice. private workspace",
          `<nav><strong>alice.</strong><span>${request.aliceUser!.email}</span><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></nav><h1>Private workspace</h1><p>Your workspace is ready. Projects remain private to this account.</p>`,
        ),
      );
  });
  app.use("/review", createReviewRouter({ database }));

  return { app, database };
}
