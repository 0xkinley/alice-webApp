import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateAcquisitionFixture } from "./fixture.ts";
import { createScoreReport, readFixtureManifest, scoreReportMarkdown } from "./scoring.ts";
import {
  DEFAULT_DIAGNOSTIC_TTL_MS,
  FileDiagnosticStore,
  MAXIMUM_DIAGNOSTIC_TTL_MS,
  sha256,
} from "./storage.ts";
import type { AcquisitionLeg, AcquisitionProvider, AcquisitionRunMetadata } from "./types.ts";

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
  if (!Number.isFinite(ttlHours) || ttlMs > MAXIMUM_DIAGNOSTIC_TTL_MS) {
    throw new Error("--ttl-hours must not exceed 72.");
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
    trial,
    exact_prompt: exactPrompt,
    exact_prompt_sha256: sha256(exactPrompt),
  };
  const store = new FileDiagnosticStore(dataDirectory(options));
  await store.pruneExpired();
  const { session, token } = await store.createSession(run, { ttlMs });
  const baseUrl = validatedBaseUrl(options.get("base-url") || "http://127.0.0.1:8790");
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/mcp/${token}`;
  console.log(`Session ID: ${session.session_id}`);
  console.log(`Expires: ${session.expires_at}`);
  console.log(`MCP URL (shown once; do not copy into evidence): ${baseUrl.href}`);
}

async function scoreCommand(options: Map<string, string>): Promise<void> {
  const manifest = await readFixtureManifest(required(options, "manifest"));
  const store = new FileDiagnosticStore(dataDirectory(options));
  const report = createScoreReport(manifest, await store.readAllRecords());
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

async function pruneCommand(options: Map<string, string>): Promise<void> {
  const result = await new FileDiagnosticStore(dataDirectory(options)).pruneExpired();
  console.log(JSON.stringify(result));
}

async function deleteCommand(options: Map<string, string>): Promise<void> {
  const result = await new FileDiagnosticStore(dataDirectory(options)).deleteSession(
    required(options, "session-id"),
  );
  console.log(JSON.stringify(result));
}

function usage(): string {
  return `Alice provider-acquisition diagnostic commands

fixture [--output PATH]

session --manifest PATH --prompt-file PATH --provider chatgpt|claude
  --account-plan VALUE --region VALUE --surface VALUE --host-version VALUE
  --entry-position VALUE --leg ambient|active-retrieval|user-mediated
  --trial 1|2|3 [--ttl-hours 1-72] [--base-url URL] [--data-dir PATH]

score --manifest PATH [--data-dir PATH] [--output PATH]
prune [--data-dir PATH]
delete --session-id UUID [--data-dir PATH]`;
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "fixture") await fixtureCommand(options);
  else if (command === "session") await sessionCommand(options);
  else if (command === "score") await scoreCommand(options);
  else if (command === "prune") await pruneCommand(options);
  else if (command === "delete") await deleteCommand(options);
  else if (command === "help" || command === "--help" || !command) console.log(usage());
  else throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Acquisition diagnostic command failed.");
  process.exitCode = 1;
});
