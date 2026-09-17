import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateAcquisitionFixture } from "./fixture.ts";
import { S3DiagnosticStore } from "./s3-storage.ts";
import { createScoreReport, readFixtureManifest, scoreReportMarkdown } from "./scoring.ts";
import {
  DEFAULT_DIAGNOSTIC_TTL_MS,
  FileDiagnosticStore,
  MAXIMUM_DIAGNOSTIC_TTL_MS,
  sha256,
} from "./storage.ts";
import type {
  AcquisitionLeg,
  AcquisitionOutcomeKind,
  AcquisitionOutcomeValue,
  AcquisitionProvider,
  AcquisitionRunMetadata,
} from "./types.ts";

function parseArguments(values: string[]): { command: string; options: Map<string, string> } {
  const [command = "", ...rest] = values;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected --name value near ${name || "end of command"}.`);
    }
    options.set(name.slice(2), value);
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function dataDirectory(options: Map<string, string>): string {
  return path.resolve(options.get("data-dir") || ".data/acquisition-probe");
}

function diagnosticStore(options: Map<string, string>): FileDiagnosticStore | S3DiagnosticStore {
  const bucket = options.get("s3-bucket")?.trim();
  if (bucket && options.has("data-dir")) {
    throw new Error("Use either --data-dir or --s3-bucket, not both.");
  }
  if (bucket) return new S3DiagnosticStore({ bucket });
  return new FileDiagnosticStore(dataDirectory(options));
}

function sessionIds(options: Map<string, string>): string[] | undefined {
  const value = options.get("session-ids")?.trim();
  if (!value) return undefined;
  const ids = value.split(",").map((entry) => entry.trim());
  if (
    ids.some(
      (entry) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry),
    )
  ) {
    throw new Error("--session-ids must be a comma-separated list of UUIDs.");
  }
  return [...new Set(ids)];
}

function assertChoice<T extends string>(value: string, choices: readonly T[], name: string): T {
  if (!choices.includes(value as T)) throw new Error(`--${name} must be ${choices.join(" or ")}.`);
  return value as T;
}

function validatedBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--base-url must use HTTPS except on loopback.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--base-url may not contain credentials, query, or fragment.");
  }
  return url;
}

async function fixtureCommand(options: Map<string, string>): Promise<void> {
  const output = path.resolve(options.get("output") || ".data/provider-acquisition-fixtures");
  const result = await generateAcquisitionFixture({ outputDirectory: output });
  console.log(`Fixture created: ${result.directory}`);
  console.log(`Fixture ID: ${result.manifest.fixture_id}`);
  console.log(`Provider uploads: ${path.join(result.directory, "provider-upload")}`);
  console.log(
    `Operator manifest: ${path.join(result.directory, "operator-only", "manifest.json")}`,
  );
}

async function sessionCommand(options: Map<string, string>): Promise<void> {
  const manifestPath = path.resolve(required(options, "manifest"));
  const manifest = await readFixtureManifest(manifestPath);
  const promptPath = path.resolve(required(options, "prompt-file"));
  const exactPrompt = await readFile(promptPath, "utf8");
  const provider = assertChoice(
    required(options, "provider"),
    ["chatgpt", "claude"] as const,
    "provider",
  );
  const acquisitionLeg = assertChoice(
    required(options, "leg"),
    ["ambient", "active-retrieval", "user-mediated"] as const,
    "leg",
  );
  const trial = Number(required(options, "trial"));
  if (!Number.isInteger(trial) || trial < 1 || trial > 3)
    throw new Error("--trial must be 1, 2, or 3.");
  const ttlHours = Number(options.get("ttl-hours") || DEFAULT_DIAGNOSTIC_TTL_MS / 3_600_000);
  const ttlMs = ttlHours * 3_600_000;
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlMs > MAXIMUM_DIAGNOSTIC_TTL_MS) {
    throw new Error("--ttl-hours must be between 1 and 72.");
  }
  const expectedPromptRelativePath = manifest.prompt_files[acquisitionLeg];
  const expectedPromptPath = path.resolve(
    path.dirname(path.dirname(manifestPath)),
    expectedPromptRelativePath,
  );
  if (path.normalize(expectedPromptPath) !== path.normalize(promptPath)) {
    throw new Error(`Use the fixture's exact ${acquisitionLeg} prompt file: ${expectedPromptPath}`);
  }
  const run: AcquisitionRunMetadata = {
    fixture_id: manifest.fixture_id,
    provider: provider as AcquisitionProvider,
    account_plan: required(options, "account-plan"),
    region: required(options, "region"),
    surface: required(options, "surface"),
    host_version: required(options, "host-version"),
    entry_position: required(options, "entry-position"),
    acquisition_leg: acquisitionLeg as AcquisitionLeg,
    call_mode: "single-call-v1",
    trial,
    exact_prompt: exactPrompt,
    exact_prompt_sha256: sha256(exactPrompt),
  };
  const store = diagnosticStore(options);
  if (store instanceof FileDiagnosticStore) await store.pruneExpired();
  const { session, token } = await store.createSession(run, { ttlMs });
  const baseUrl = validatedBaseUrl(options.get("base-url") || "http://127.0.0.1:8790");
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/mcp/${token}`;
  console.log(`Session ID: ${session.session_id}`);
  console.log(`Expires: ${session.expires_at}`);
  console.log(`MCP URL (shown once; do not copy into evidence): ${baseUrl.href}`);
}

async function scoreCommand(options: Map<string, string>): Promise<void> {
  const manifest = await readFixtureManifest(required(options, "manifest"));
  const store = diagnosticStore(options);
  const requestedSessionIds = sessionIds(options);
  if (store instanceof S3DiagnosticStore && !requestedSessionIds) {
    throw new Error("Hosted scoring requires --session-ids so evidence is read by exact key.");
  }
  const records = requestedSessionIds
    ? (
        await Promise.all(requestedSessionIds.map((sessionId) => store.readRecord(sessionId)))
      ).filter((record) => record !== undefined)
    : await (store as FileDiagnosticStore).readAllRecords();
  const outcomes = requestedSessionIds
    ? (
        await Promise.all(
          requestedSessionIds.map((sessionId) => store.readOutcomesForSession(sessionId)),
        )
      ).flat()
    : await (store as FileDiagnosticStore).readAllOutcomes();
  const report = createScoreReport(manifest, records, outcomes);
  const outputDirectory = path.resolve(
    options.get("output") || path.join(".data", "acquisition-reports", manifest.fixture_id),
  );
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "score.json");
  const markdownPath = path.join(outputDirectory, "score.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(markdownPath, scoreReportMarkdown(report), { mode: 0o600 }),
  ]);
  console.log(`Scored ${report.runs.length} matching run(s).`);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Readable report: ${markdownPath}`);
}

async function retrieveCommand(options: Map<string, string>): Promise<void> {
  const sessionId = required(options, "session-id");
  const store = diagnosticStore(options);
  const session = await store.readSessionById(sessionId);
  if (!session) throw new Error("Diagnostic session was not found.");
  const evidence = {
    session,
    record: (await store.readRecord(sessionId)) ?? null,
    outcomes: await store.readOutcomesForSession(sessionId),
  };
  const output = path.resolve(required(options, "output"));
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`Evidence retrieved: ${output}`);
}

async function pruneCommand(options: Map<string, string>): Promise<void> {
  const store = diagnosticStore(options);
  if (store instanceof S3DiagnosticStore) {
    throw new Error(
      "Hosted evidence must be deleted by exact session ID; lifecycle is a backstop.",
    );
  }
  const result = await store.pruneExpired();
  console.log(JSON.stringify(result));
}

async function deleteCommand(options: Map<string, string>): Promise<void> {
  const result = await diagnosticStore(options).deleteSession(required(options, "session-id"));
  console.log(JSON.stringify(result));
}

async function verifyMissingCommand(options: Map<string, string>): Promise<void> {
  const missing = await diagnosticStore(options).verifySessionMissing(
    required(options, "session-id"),
  );
  if (!missing) throw new Error("Diagnostic session evidence still exists.");
  console.log("Diagnostic session evidence is absent.");
}

async function outcomeCommand(options: Map<string, string>): Promise<void> {
  const sessionId = required(options, "session-id");
  const store = diagnosticStore(options);
  const session = await store.readSessionById(sessionId);
  if (!session) throw new Error("Diagnostic session was not found.");
  const kind = assertChoice(
    required(options, "kind"),
    [
      "provider_observed_success",
      "additional_call_attempted",
      "truncation_or_chunking_observed",
      "payload_ceiling_reached",
    ] as const,
    "kind",
  ) as AcquisitionOutcomeKind;
  const value = assertChoice(
    required(options, "value"),
    ["yes", "no", "unknown"] as const,
    "value",
  ) as AcquisitionOutcomeValue;
  const detailCode = required(options, "detail-code");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(detailCode)) {
    throw new Error(
      "--detail-code must be a content-free lowercase code of at most 64 characters.",
    );
  }
  const outcome = await store.recordOutcome(session, {
    source: "operator",
    kind,
    value,
    detail_code: detailCode,
  });
  console.log(`Outcome recorded: ${outcome.outcome_id}`);
}

function usage(): string {
  return `Alice provider-acquisition diagnostic commands

fixture [--output PATH]

session --manifest PATH --prompt-file PATH --provider chatgpt|claude
  --account-plan VALUE --region VALUE --surface VALUE --host-version VALUE
  --entry-position VALUE --leg ambient|active-retrieval|user-mediated
  --trial 1|2|3 [--ttl-hours 1-72] [--base-url URL] [--data-dir PATH|--s3-bucket NAME]

retrieve --session-id UUID --output PATH [--data-dir PATH|--s3-bucket NAME]
score --manifest PATH [--session-ids UUID,UUID] [--data-dir PATH|--s3-bucket NAME] [--output PATH]
outcome --session-id UUID --kind KIND --value yes|no|unknown
  --detail-code CONTENT_FREE_CODE [--data-dir PATH|--s3-bucket NAME]
prune [--data-dir PATH]
delete --session-id UUID [--data-dir PATH|--s3-bucket NAME]
verify-missing --session-id UUID [--data-dir PATH|--s3-bucket NAME]`;
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "fixture") await fixtureCommand(options);
  else if (command === "session") await sessionCommand(options);
  else if (command === "retrieve") await retrieveCommand(options);
  else if (command === "score") await scoreCommand(options);
  else if (command === "outcome") await outcomeCommand(options);
  else if (command === "prune") await pruneCommand(options);
  else if (command === "delete") await deleteCommand(options);
  else if (command === "verify-missing") await verifyMissingCommand(options);
  else if (command === "help" || command === "--help" || !command) console.log(usage());
  else throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Acquisition diagnostic command failed.");
  process.exitCode = 1;
});
