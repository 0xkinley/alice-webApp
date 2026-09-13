import { loadWebConfig } from "@alice/config";
import { createS3PrivateFileStore } from "@alice/private-files";
import { createApp } from "./app.ts";

const { databaseUrl, fileStorage, host, mcpPublicUrl, port, publicUrl } = loadWebConfig();
const fileStore = fileStorage ? createS3PrivateFileStore(fileStorage) : undefined;

const { app, database } = await createApp({ databaseUrl, fileStore, mcpPublicUrl, publicUrl });
const server = app.listen(port, host, () => {
  console.log(`alice. web listening on ${host}:${port}`);
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`alice. web received ${signal}; shutting down.`);
  const timeout = setTimeout(() => {
    console.error("alice. web graceful shutdown timed out.");
    server.closeAllConnections();
    process.exit(1);
  }, 10_000);
  timeout.unref();
  server.close((error) => {
    void database
      .close()
      .catch(() => {
        console.error("alice. web database shutdown failed.");
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (error) {
          console.error("alice. web HTTP shutdown failed.");
          process.exitCode = 1;
        }
      });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
