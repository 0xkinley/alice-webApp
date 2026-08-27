import { loadMcpConfig } from "@alice/config";
import { createApp } from "./app.ts";

const { databaseFilename, host, passphrase, port, publicUrl, reviewUrl } = loadMcpConfig();

const { app } = createApp({ databaseFilename, passphrase, publicUrl, reviewUrl });
app.listen(port, host, () => {
  console.log(`alice. MCP spike listening on ${host}:${port}`);
  console.log(`Public MCP URL: ${new URL("/mcp", publicUrl).href}`);
});
