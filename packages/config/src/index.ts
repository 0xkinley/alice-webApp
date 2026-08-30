import { z } from "zod";

type Environment = Record<string, string | undefined>;

const portSchema = z.coerce.number().int().min(1).max(65_535);

function parseServerOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${name} must use HTTPS except on a loopback host.`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}

function parseDatabaseUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value || "");
  } catch {
    throw new Error("ALICE_DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  ) {
    throw new Error("ALICE_DATABASE_URL must use postgresql:// and name a database.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    !loopback &&
    !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") || "")
  ) {
    throw new Error("ALICE_DATABASE_URL must require TLS outside loopback development.");
  }
  return url.href;
}

function loadCommon(environment: Environment, defaultPort: number) {
  const host = z
    .string()
    .min(1)
    .parse(environment.HOST || "127.0.0.1");
  const port = portSchema.parse(environment.PORT || defaultPort);
  const databaseUrl = parseDatabaseUrl(environment.ALICE_DATABASE_URL);
  return { databaseUrl, host, port };
}

export function loadMcpConfig(environment: Environment = process.env) {
  const common = loadCommon(environment, 8787);
  const publicUrl = parseServerOrigin(
    "ALICE_PUBLIC_URL",
    environment.ALICE_PUBLIC_URL || `http://127.0.0.1:${common.port}`,
  );
  const reviewUrl = parseServerOrigin("ALICE_WEB_URL", environment.ALICE_WEB_URL || publicUrl);
  return { ...common, publicUrl, reviewUrl };
}

export function loadWebConfig(environment: Environment = process.env) {
  const common = loadCommon(environment, 8788);
  const publicUrl = parseServerOrigin(
    "ALICE_WEB_URL",
    environment.ALICE_WEB_URL || `http://127.0.0.1:${common.port}`,
  );
  const mcpPublicUrl = parseServerOrigin(
    "ALICE_MCP_URL",
    environment.ALICE_MCP_URL || "http://127.0.0.1:8787",
  );
  return { ...common, mcpPublicUrl, publicUrl };
}
