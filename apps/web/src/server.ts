import { loadWebConfig } from "@alice/config";
import { createS3PrivateFileStore } from "@alice/private-files";
import { createApp } from "./app.ts";

const { databaseUrl, fileStorage, host, mcpPublicUrl, port, publicUrl } = loadWebConfig();
const fileStore = fileStorage ? createS3PrivateFileStore(fileStorage) : undefined;

const { app } = await createApp({ databaseUrl, fileStore, mcpPublicUrl, publicUrl });
app.listen(port, host, () => {
  console.log(`alice. web listening on ${host}:${port}`);
});
