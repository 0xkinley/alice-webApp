import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { pathToFileURL, URL } from "node:url";

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";

function randomValue(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseMcpPayload(text) {
  if (!text.startsWith("event:")) return JSON.parse(text);
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error("The MCP response did not contain an SSE data event.");
  return JSON.parse(dataLine.slice("data: ".length));
}

async function readBoundedText(response, label) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`${label} exceeded the response-size limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function expectJson(response, label) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  try {
    return JSON.parse(await readBoundedText(response, label));
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("response-size limit.")) throw error;
    throw new Error(`${label} did not return JSON.`, { cause: error });
  }
}

function expectTokenSet(payload, label) {
  if (
    typeof payload?.access_token !== "string" ||
    payload.access_token.length === 0 ||
    typeof payload?.refresh_token !== "string" ||
    payload.refresh_token.length === 0 ||
    payload.token_type !== "Bearer"
  ) {
    throw new Error(`${label} returned an incomplete token contract.`);
  }
  return payload;
}

async function formPost(url, body) {
  return globalThis.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new globalThis.URLSearchParams(body),
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(30_000),
  });
}

async function callMcp(resource, accessToken, method, params = {}) {
  const response = await globalThis.fetch(resource, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomValue(12), method, params }),
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  return { response, text: await readBoundedText(response, `MCP ${method}`) };
}

function startCallbackServer() {
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("alice. authorization received. You can return to Codex.");
      resolveCallback({
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
        state: url.searchParams.get("state"),
      });
    } catch (error) {
      rejectCallback(error);
    }
  });
  return { callback, server };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local callback failed to bind.");
  return `http://127.0.0.1:${address.port}/callback`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function probeHostedOAuth(environment = process.env) {
  const origin = new URL(environment.ALICE_HOSTED_MCP_ORIGIN || "");
  if (origin.protocol !== "https:" || origin.origin !== origin.href.replace(/\/$/, "")) {
    throw new Error("ALICE_HOSTED_MCP_ORIGIN must be a credential-free HTTPS origin.");
  }
  const resource = new URL("/mcp", `${origin.origin}/`).href;
  const { callback, server } = startCallbackServer();
  const redirectUri = await listen(server);
  let clientId;
  let operationError;
  let result;
  let revocationToken;

  try {
    const registrationResponse = await globalThis.fetch(new URL("/register", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "alice hosted verification",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    const client = await expectJson(registrationResponse, "Dynamic client registration");
    if (typeof client?.client_id !== "string" || client.client_id.length === 0) {
      throw new Error("Dynamic client registration returned an incomplete client contract.");
    }
    clientId = client.client_id;
    const verifier = randomValue(48);
    const state = randomValue(24);
    const authorizationUrl = new URL("/authorize", origin);
    authorizationUrl.search = new globalThis.URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      scope: "mcp:read offline_access",
      resource,
    });

    console.log(`AUTHORIZATION_URL=${authorizationUrl.href}`);
    console.log("Waiting for the local OAuth callback; no credential or token is logged.");

    const returned = await Promise.race([
      callback,
      new Promise((_, reject) =>
        globalThis.setTimeout(
          () => reject(new Error("Authorization timed out.")),
          CALLBACK_TIMEOUT_MS,
        ),
      ),
    ]);
    if (returned.error) throw new Error("Authorization was denied.");
    if (!returned.code || returned.state !== state) {
      throw new Error("Authorization callback state validation failed.");
    }

    const tokenResponse = await formPost(new URL("/token", origin), {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: returned.code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    });
    const tokenPayload = await expectJson(tokenResponse, "Authorization-code exchange");
    if (typeof tokenPayload?.access_token === "string") {
      revocationToken = tokenPayload.access_token;
    }
    const tokens = expectTokenSet(tokenPayload, "Authorization-code exchange");

    const initialized = await callMcp(resource, tokens.access_token, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "alice-hosted-verification", version: "1.0.0" },
    });
    if (!initialized.response.ok) {
      throw new Error(`Authenticated MCP initialize returned HTTP ${initialized.response.status}.`);
    }
    const initializePayload = parseMcpPayload(initialized.text);
    if (initializePayload.error || initializePayload.result?.serverInfo?.name !== "alice-mcp") {
      throw new Error("Authenticated MCP initialize returned the wrong server contract.");
    }

    const listed = await callMcp(resource, tokens.access_token, "tools/list");
    if (!listed.response.ok) {
      throw new Error(`Authenticated tools/list returned HTTP ${listed.response.status}.`);
    }
    const listPayload = parseMcpPayload(listed.text);
    const tools = listPayload.result?.tools;
    if (!Array.isArray(tools) || !tools.some((tool) => tool.name === "list_projects")) {
      throw new Error("Authenticated tools/list omitted list_projects.");
    }

    const projectsCall = await callMcp(resource, tokens.access_token, "tools/call", {
      name: "list_projects",
      arguments: {},
    });
    if (!projectsCall.response.ok) {
      throw new Error(`Authenticated list_projects returned HTTP ${projectsCall.response.status}.`);
    }
    const projectsPayload = parseMcpPayload(projectsCall.text);
    if (
      projectsPayload.error ||
      !Array.isArray(projectsPayload.result?.structuredContent?.projects)
    ) {
      throw new Error("Authenticated list_projects returned the wrong contract.");
    }

    const refreshResponse = await formPost(new URL("/token", origin), {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    });
    const refreshedPayload = await expectJson(refreshResponse, "Refresh-token rotation");
    if (typeof refreshedPayload?.access_token === "string") {
      revocationToken = refreshedPayload.access_token;
    }
    const refreshed = expectTokenSet(refreshedPayload, "Refresh-token rotation");
    if (refreshed.refresh_token === tokens.refresh_token) {
      throw new Error("Refresh-token rotation returned the original refresh token.");
    }
    const refreshedPing = await callMcp(resource, refreshed.access_token, "ping");
    if (!refreshedPing.response.ok || parseMcpPayload(refreshedPing.text).error) {
      throw new Error("The rotated access token could not call MCP ping.");
    }

    const revokeResponse = await formPost(new URL("/revoke", origin), {
      client_id: client.client_id,
      token: refreshed.refresh_token,
    });
    if (!revokeResponse.ok) {
      throw new Error(`Token revocation returned HTTP ${revokeResponse.status}.`);
    }
    revocationToken = undefined;
    const rejected = await callMcp(resource, refreshed.access_token, "ping");
    if (rejected.response.status !== 401) {
      throw new Error(`Revoked MCP access returned HTTP ${rejected.response.status}, not 401.`);
    }
    result = {
      projectCount: projectsPayload.result.structuredContent.projects.length,
      protocolVersion: initializePayload.result.protocolVersion,
      toolCount: tools.length,
    };
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  if (clientId && revocationToken) {
    try {
      const cleanupResponse = await formPost(new URL("/revoke", origin), {
        client_id: clientId,
        token: revocationToken,
      });
      if (!cleanupResponse.ok) {
        cleanupError = new Error(
          `Emergency connection revocation returned HTTP ${cleanupResponse.status}.`,
        );
      }
    } catch (error) {
      cleanupError = new Error("Emergency connection revocation failed.", { cause: error });
    }
  }
  try {
    await close(server);
  } catch (error) {
    cleanupError ||= new Error("Local callback cleanup failed.", { cause: error });
  }
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeHostedOAuth();
    console.log(
      `Hosted OAuth/MCP verified and revoked: protocol ${result.protocolVersion}, ${result.toolCount} tools, ${result.projectCount} visible projects.`,
    );
  } catch (error) {
    console.error(
      `Hosted OAuth/MCP verification failed: ${error instanceof Error ? error.message : "error"}`,
    );
    process.exitCode = 1;
  }
}
