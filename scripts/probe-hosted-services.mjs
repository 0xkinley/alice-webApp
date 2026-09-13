import { Buffer } from "node:buffer";
import { pathToFileURL, URL } from "node:url";

const MAX_RESPONSE_BYTES = 16 * 1024;

export function parseHostedOrigin(name, value) {
  let url;
  try {
    url = new URL(value || "");
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS origin.`);
  }
  return url.origin;
}

async function jsonResponse(url) {
  const response = await globalThis.fetch(url, {
    headers: { accept: "application/json", "user-agent": "alice-hosted-health/1" },
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`${url.pathname} exceeded the probe response budget.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url.pathname} did not return JSON.`);
  }
}

export async function probeHostedServices(environment = process.env) {
  const webOrigin = parseHostedOrigin(
    "ALICE_HOSTED_WEB_ORIGIN",
    environment.ALICE_HOSTED_WEB_ORIGIN,
  );
  const mcpOrigin = parseHostedOrigin(
    "ALICE_HOSTED_MCP_ORIGIN",
    environment.ALICE_HOSTED_MCP_ORIGIN,
  );
  const [webHealth, mcpHealth, resourceMetadata] = await Promise.all([
    jsonResponse(new URL("/health", webOrigin)),
    jsonResponse(new URL("/health", mcpOrigin)),
    jsonResponse(new URL("/.well-known/oauth-protected-resource/mcp", mcpOrigin)),
  ]);
  if (
    webHealth.status !== "ok" ||
    webHealth.service !== "alice-web" ||
    webHealth.database !== "reachable"
  ) {
    throw new Error("The web health contract did not report a reachable database.");
  }
  if (
    mcpHealth.status !== "ok" ||
    mcpHealth.service !== "alice-mcp" ||
    mcpHealth.database !== "reachable"
  ) {
    throw new Error("The MCP health contract did not report a reachable database.");
  }
  if (resourceMetadata.resource !== new URL("/mcp", mcpOrigin).href) {
    throw new Error("The MCP protected-resource metadata advertises the wrong resource.");
  }
  if (!resourceMetadata.authorization_servers?.includes(mcpOrigin)) {
    throw new Error("The MCP protected-resource metadata omits its authorization server.");
  }
  return { mcpOrigin, webOrigin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeHostedServices();
    console.log(`Hosted alice. health verified for ${result.webOrigin} and ${result.mcpOrigin}.`);
  } catch (error) {
    console.error(
      `Hosted alice. health failed: ${error instanceof Error ? error.message : "error"}`,
    );
    process.exitCode = 1;
  }
}
