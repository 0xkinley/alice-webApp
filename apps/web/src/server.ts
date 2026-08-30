import { loadWebConfig } from "@alice/config";
import { createApp } from "./app.ts";
import { createS3PrivateFileStore } from "./file-store.ts";

const { databaseUrl, fileStorage, host, mcpPublicUrl, port, publicUrl } = loadWebConfig();
const fileStore = fileStorage ? createS3PrivateFileStore(fileStorage) : undefined;

const { app } = await createApp({ databaseUrl, fileStore, mcpPublicUrl, publicUrl });
app.listen(port, host, () => {
  console.log(`alice. web listening on ${host}:${port}`);
});
