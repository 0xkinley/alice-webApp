import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { openDatabase } from "./database.js";
import { createOAuth } from "./oauth.js";

function createProtocolServer() {
  return new McpServer({ name: "alice-mcp-compatibility-spike", version: "0.1.0" });
}

export function createApp({ databaseFilename, passphrase, publicUrl }) {
  const database = openDatabase(databaseFilename);
  const oauth = createOAuth({ database, passphrase, publicUrl });
  const publicHostname = new URL(publicUrl).hostname;
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: [publicHostname, "127.0.0.1", "localhost", "[::1]"],
    jsonLimit: "64kb",
  });

  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: oauth.metadata,
      resourceServerUrl: new URL(oauth.resource),
      resourceName: "alice. Milestone 01 spike",
      scopesSupported: ["mcp:read", "mcp:write"],
    }),
  );

  app.get("/health", (_request, response) => {
    response.json({ service: "alice-mcp-compatibility-spike", status: "ok" });
  });
  app.post("/register", (request, response) => oauth.register(request, response));
  app.get("/authorize", (request, response) => oauth.authorizeForm(request, response));
  app.post("/authorize", (request, response) => oauth.authorize(request, response));
  app.post("/token", (request, response) => oauth.token(request, response));
  app.post("/revoke", (request, response) => oauth.revoke(request, response));

  const authenticate = requireBearerAuth({
    verifier: oauth.verifier,
    requiredScopes: ["mcp:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauth.resource)),
  });

  app.all("/mcp", authenticate, async (request, response) => {
    const protocolServer = createProtocolServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void protocolServer.close();
    });
    try {
      await protocolServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) {
        response.status(500).json({ error: "internal_server_error" });
      }
    }
  });

  return { app, database, oauth };
}
