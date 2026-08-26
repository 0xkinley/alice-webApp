import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { saveCandidateUpdate } from "./candidate-updates.js";
import { openDatabase } from "./database.js";
import { createOAuth } from "./oauth.js";
import { getProjectContext, listProjects } from "./project-context.js";

function authenticatedUserId(context) {
  return context.http?.authInfo?.extra?.userId;
}

function createProtocolServer(database, publicUrl) {
  const server = new McpServer({ name: "alice-mcp-compatibility-spike", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    {
      title: "List alice. projects",
      description: "List projects in the authenticated user's private alice. workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (_input, context) => {
      const projects = listProjects(database, authenticatedUserId(context));
      const output = { projects };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Get trusted alice. project context",
      description:
        "Retrieve bounded project context from human-accepted alice. state. Pending candidate claims are excluded. Use this before continuing work on a saved project.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(200).describe("Project identifier returned by list_projects"),
        task: z.string().min(1).max(2_000).describe("The current task, used to describe the context package"),
        context_budget: z.number().int().min(256).max(8_000).optional().default(2_000),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id: projectId, task, context_budget: contextBudget }, context) => {
      const projectContext = getProjectContext(database, {
        userId: authenticatedUserId(context),
        projectId,
        task,
        contextBudget,
      });
      if (!projectContext) {
        return {
          content: [{ type: "text", text: "Project not found in the authenticated workspace." }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(projectContext) }],
        structuredContent: projectContext,
      };
    },
  );

  server.registerTool(
    "save_project_update",
    {
      title: "Save a candidate project update to alice.",
      description:
        "Use only after the user explicitly asks to save or record an update in alice. Stores immutable submitted evidence and pending candidate claims for human review. Never changes trusted project state.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(200).describe("Project identifier returned by list_projects"),
        summary: z.string().min(1).max(1_000),
        candidate_claims: z
          .array(
            z.object({
              state_key: z
                .string()
                .min(1)
                .max(200)
                .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
              value: z.json(),
              summary: z.string().min(1).max(500),
            }),
          )
          .min(1)
          .max(20),
        source_note: z.string().max(4_000).optional(),
        idempotency_key: z.string().min(8).max(200),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (payload, context) => {
      const authInfo = context.http?.authInfo;
      if (!authInfo?.scopes.includes("mcp:write")) {
        return {
          content: [{ type: "text", text: "The connection does not grant mcp:write." }],
          isError: true,
        };
      }
      const result = saveCandidateUpdate(database, {
        clientId: authInfo.clientId,
        publicUrl,
        userId: authenticatedUserId(context),
        payload,
      });
      if (result.error) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: `${result.candidate_ids.length} candidate claim(s) saved for human review. Trusted state was not changed. ${JSON.stringify(result)}`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  return server;
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
    const protocolServer = createProtocolServer(database, publicUrl);
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
