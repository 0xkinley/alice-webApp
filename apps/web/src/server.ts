import { loadWebConfig } from "@alice/config";
import { createApp } from "./app.ts";

const { databaseFilename, host, passphrase, port, publicUrl } = loadWebConfig();

const { app } = createApp({ databaseFilename, passphrase, publicUrl });
app.listen(port, host, () => {
  console.log(`alice. web listening on ${host}:${port}`);
});
