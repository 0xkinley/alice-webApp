import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";
import { openDatabase } from "@alice/database";
import { issueAlphaInvitation } from "@alice/domain";

const MAX_REQUEST_BYTES = 4_096;

function jsonResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    body,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      pragma: "no-cache",
      ...headers,
    },
  };
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error("The request body is too large.");
    }
  }
  if (!body) throw new Error("A JSON request body is required.");
  return body;
}

export async function invitationOperatorResponse({ database, request, webUrl }) {
  if (request.url !== "/invite") {
    return jsonResponse(404, { error: "Not found." });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." }, { allow: "POST" });
  }
  if (!String(request.contentType || "").startsWith("application/json")) {
    return jsonResponse(415, { error: "Content-Type must be application/json." });
  }

  try {
    const input = JSON.parse(request.body);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "email")
    ) {
      throw new Error("Only an email address may be supplied.");
    }
    const invitation = await issueAlphaInvitation(database, { email: input.email });
    const invitationUrl = new URL("/auth/register", webUrl);
    invitationUrl.searchParams.set("invite", invitation.token);
    return jsonResponse(201, {
      email: invitation.email,
      expires_at: invitation.expires_at,
      invitation_url: invitationUrl.href,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse(400, { error: "The request body must be valid JSON." });
    }
    if (
      error instanceof Error &&
      ["Enter a valid email address.", "Only an email address may be supplied."].includes(
        error.message,
      )
    ) {
      return jsonResponse(400, { error: error.message });
    }
    console.error("alice. invitation operator request failed.");
    return jsonResponse(500, { error: "Invitation creation failed." });
  }
}

export function createInvitationOperatorServer({ database, webUrl }) {
  return createServer(async (request, response) => {
    try {
      const result = await invitationOperatorResponse({
        database,
        webUrl,
        request: {
          method: request.method,
          url: request.url,
          contentType: request.headers["content-type"],
          body:
            request.url === "/invite" && request.method === "POST" ? await readBody(request) : "",
        },
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(JSON.stringify(result.body));
    } catch (error) {
      if (
        error instanceof Error &&
        ["A JSON request body is required.", "The request body is too large."].includes(
          error.message,
        )
      ) {
        const result = jsonResponse(400, { error: error.message });
        response.writeHead(result.statusCode, result.headers);
        response.end(JSON.stringify(result.body));
        return;
      }
      console.error("alice. invitation operator request failed.");
      const result = jsonResponse(500, { error: "Invitation creation failed." });
      response.writeHead(result.statusCode, result.headers);
      response.end(JSON.stringify(result.body));
    }
  });
}

export async function startInvitationOperator({
  databaseUrl = process.env.ALICE_DATABASE_URL,
  host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 8789),
  webUrl = process.env.ALICE_WEB_URL,
} = {}) {
  if (!databaseUrl) throw new Error("ALICE_DATABASE_URL is required.");
  if (!webUrl) throw new Error("ALICE_WEB_URL is required.");
  const publicUrl = new URL(webUrl);
  if (publicUrl.protocol !== "https:") throw new Error("ALICE_WEB_URL must use HTTPS.");

  const database = await openDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  const server = createInvitationOperatorServer({ database, webUrl: publicUrl });
  server.listen(port, host, () => {
    console.log(`alice. invitation operator listening on ${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`alice. invitation operator received ${signal}; shutting down.`);
    const timeout = setTimeout(() => {
      console.error("alice. invitation operator graceful shutdown timed out.");
      server.closeAllConnections();
      process.exit(1);
    }, 10_000);
    timeout.unref();
    server.close((error) => {
      void database
        .close()
        .catch(() => {
          console.error("alice. invitation operator database shutdown failed.");
          process.exitCode = 1;
        })
        .finally(() => {
          clearTimeout(timeout);
          if (error) {
            console.error("alice. invitation operator HTTP shutdown failed.");
            process.exitCode = 1;
          }
        });
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return { database, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startInvitationOperator();
}
