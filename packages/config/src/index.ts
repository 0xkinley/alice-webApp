import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function loadPassphrase(environment: Environment): string {
  const inline = environment.ALICE_AUTH_PASSPHRASE;
  const filename = environment.ALICE_AUTH_PASSPHRASE_FILE;
  if (inline && filename) {
    throw new Error("Set only one of ALICE_AUTH_PASSPHRASE or ALICE_AUTH_PASSPHRASE_FILE.");
  }
  if (!inline && !filename) {
    throw new Error(
      "Set one of ALICE_AUTH_PASSPHRASE or ALICE_AUTH_PASSPHRASE_FILE on the server.",
    );
  }

  let passphrase = inline;
  if (filename) {
    try {
      passphrase = readFileSync(resolve(filename), "utf8").trim();
    } catch (error) {
      throw new Error(`Unable to read ALICE_AUTH_PASSPHRASE_FILE: ${String(error)}`, {
        cause: error,
      });
    }
  }
  if (!passphrase || passphrase.length < 12) {
    throw new Error("The alice. authentication passphrase must contain at least 12 characters.");
  }
  return passphrase;
}

function loadCommon(environment: Environment, defaultPort: number) {
  const host = z
    .string()
    .min(1)
    .parse(environment.HOST || "127.0.0.1");
  const port = portSchema.parse(environment.PORT || defaultPort);
  const databaseFilename = resolve(environment.ALICE_DATABASE_PATH || ".data/spike.sqlite");
  const passphrase = loadPassphrase(environment);
  return { databaseFilename, host, passphrase, port };
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
  return { ...common, publicUrl };
}
