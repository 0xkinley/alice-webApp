import { loadMcpConfig } from "@alice/config";
import { createS3PrivateFileStore } from "@alice/private-files";
import { createApp } from "./app.ts";

const { databaseUrl, fileStorage, host, port, publicUrl, reviewUrl } = loadMcpConfig();
const fileStore = fileStorage ? createS3PrivateFileStore(fileStorage) : undefined;

const { app, database } = await createApp({ databaseUrl, fileStore, publicUrl, reviewUrl });
const server = app.listen(port, host, () => {
  console.log(`alice. MCP listening on ${host}:${port}`);
  console.log(`Public MCP URL: ${new URL("/mcp", publicUrl).href}`);
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`alice. MCP received ${signal}; shutting down.`);
  const timeout = setTimeout(() => {
    console.error("alice. MCP graceful shutdown timed out.");
    server.closeAllConnections();
    process.exit(1);
  }, 10_000);
  timeout.unref();
  server.close((error) => {
    void database
      .close()
      .catch(() => {
        console.error("alice. MCP database shutdown failed.");
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (error) {
          console.error("alice. MCP HTTP shutdown failed.");
          process.exitCode = 1;
        }
      });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
