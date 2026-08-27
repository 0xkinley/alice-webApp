import express from "express";
import { openDatabase } from "@alice/database";
import { createReviewRouter } from "./review.ts";

export function createApp({ database: suppliedDatabase, databaseFilename, passphrase, publicUrl }) {
  const database = suppliedDatabase || openDatabase(databaseFilename);
  const app = express();

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.get("/health", (_request, response) => {
    response.json({ service: "alice-web", status: "ok" });
  });
  app.use("/review", createReviewRouter({ database, passphrase, publicUrl }));

  return { app, database };
}

