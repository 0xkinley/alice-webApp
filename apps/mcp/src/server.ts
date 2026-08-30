import { loadMcpConfig } from "@alice/config";
import { createS3PrivateFileStore } from "@alice/private-files";
import { createApp } from "./app.ts";

const { databaseUrl, fileStorage, host, port, publicUrl, reviewUrl } = loadMcpConfig();
const fileStore = fileStorage ? createS3PrivateFileStore(fileStorage) : undefined;

const { app } = await createApp({ databaseUrl, fileStore, publicUrl, reviewUrl });
app.listen(port, host, () => {
  console.log(`alice. MCP listening on ${host}:${port}`);
  console.log(`Public MCP URL: ${new URL("/mcp", publicUrl).href}`);
});
