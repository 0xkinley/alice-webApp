import { loadMcpConfig } from "@alice/config";
import { createApp } from "./app.ts";

const { databaseUrl, host, port, publicUrl, reviewUrl } = loadMcpConfig();

const { app } = await createApp({ databaseUrl, publicUrl, reviewUrl });
app.listen(port, host, () => {
  console.log(`alice. MCP listening on ${host}:${port}`);
  console.log(`Public MCP URL: ${new URL("/mcp", publicUrl).href}`);
});
