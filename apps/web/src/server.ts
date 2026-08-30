import { loadWebConfig } from "@alice/config";
import { createApp } from "./app.ts";

const { databaseUrl, host, mcpPublicUrl, port, publicUrl } = loadWebConfig();

const { app } = await createApp({ databaseUrl, mcpPublicUrl, publicUrl });
app.listen(port, host, () => {
  console.log(`alice. web listening on ${host}:${port}`);
});
