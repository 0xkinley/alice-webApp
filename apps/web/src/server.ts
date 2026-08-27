import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "127.0.0.1";
const publicUrl = process.env.ALICE_WEB_URL || `http://127.0.0.1:${port}`;
const passphrase = process.env.ALICE_AUTH_PASSPHRASE_FILE
  ? readFileSync(resolve(process.env.ALICE_AUTH_PASSPHRASE_FILE), "utf8").trim()
  : process.env.ALICE_AUTH_PASSPHRASE;
const databaseFilename = resolve(process.env.ALICE_DATABASE_PATH || ".data/spike.sqlite");

if (!passphrase || passphrase.length < 12) {
  throw new Error("ALICE_AUTH_PASSPHRASE must contain at least 12 characters.");
}

const { app } = createApp({ databaseFilename, passphrase, publicUrl });
app.listen(port, host, () => {
  console.log(`alice. web listening on ${host}:${port}`);
});
