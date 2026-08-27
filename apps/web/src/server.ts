import { loadWebConfig } from "@alice/config";
import { createApp } from "./app.ts";

const { databaseFilename, host, port, publicUrl } = loadWebConfig();

const { app } = createApp({ databaseFilename, publicUrl });
app.listen(port, host, () => {
  console.log(`alice. web listening on ${host}:${port}`);
});
