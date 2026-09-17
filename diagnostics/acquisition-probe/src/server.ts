import path from "node:path";
import { createAcquisitionProbeApp } from "./app.ts";
import { FileDiagnosticStore } from "./storage.ts";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8790);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid.");
const dataDirectory = path.resolve(
  process.env.ACQUISITION_PROBE_DATA_DIR || ".data/acquisition-probe",
);
const allowedHosts = (process.env.ACQUISITION_PROBE_ALLOWED_HOSTS || "127.0.0.1,localhost,[::1]")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const store = new FileDiagnosticStore(dataDirectory);
await store.initialize();
await store.pruneExpired();
const app = createAcquisitionProbeApp({ store, allowedHosts });
const server = app.listen(port, host, () => {
  console.log(`Alice acquisition probe listening on ${host}:${port}.`);
  console.log(
    "No Alice database, project, migration, artifact, file, or trusted-state service is loaded.",
  );
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Alice acquisition probe received ${signal}; shutting down.`);
  server.close((error) => {
    if (error) process.exitCode = 1;
  });
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
