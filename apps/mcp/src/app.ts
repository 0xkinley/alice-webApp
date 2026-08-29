import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  bearerAuthChallengeResponse,
  McpServer,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import { openDatabase } from "@alice/database";
import {
  ContextBudgetError,
  getProjectContext,
  listProjects,
  saveCandidateUpdate,
} from "@alice/domain";
import {
  consumptionContractVersion,
  getProjectContextOutputSchema,
  getProjectContextSchema,
  listProjectsOutputSchema,
  listProjectsSchema,
  saveProjectUpdateSchema,
} from "@alice/schemas";
import { createOAuth } from "./oauth.ts";

function authenticatedUserId(context) {
  return context.http?.authInfo?.extra?.userId;
}

function authenticatedConnectionId(context) {
  return context.http?.authInfo?.extra?.connectionId;
}

function oauthToolSecurity(scope) {
  return {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [scope] }] },
  };
}

function requireMcpBearerAuth({ verifier, resourceMetadataUrl, advertisedScopes }) {
  return async (request, response, next) => {
    try {
      request.auth = await verifyBearerToken(request.get("authorization"), {
        verifier,
        requiredScopes: [],
      });
      next();
    } catch (error) {
      const challenge = bearerAuthChallengeResponse(error, {
        requiredScopes: advertisedScopes,
        resourceMetadataUrl,
      });
      for (const [name, value] of challenge.headers) response.set(name, value);
      response.status(challenge.status).send(await challenge.text());
    }
  };
}

function createProtocolServer(database, publicUrl) {
  const server = new McpServer({ name: "alice-mcp", version: "0.5.0" });

  server.registerTool(
    "list_projects",
    {
      title: "List alice. projects",
      description:
        "List projects in the authenticated user's private alice. workspace, including current accepted-state counts and freshness. This read cannot mutate project, captured, or trusted state.",
      inputSchema: listProjectsSchema,
      outputSchema: listProjectsOutputSchema,
      ...oauthToolSecurity("mcp:read"),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (_input, context) => {
      const projects = listProjects(database, authenticatedUserId(context));
      const output = { contract_version: consumptionContractVersion, projects };
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
        "Retrieve a deterministic, budget-bounded project context package from human-accepted alice. state. The package includes explicit freshness, accepted-state/candidate/evidence provenance, and omission reporting. Open questions, artifact references, and unresolved-conflict notices are separately labeled when available; pending and rejected candidate values are never presented as trusted decisions. This read cannot mutate project, captured, or trusted state.",
      inputSchema: getProjectContextSchema,
      outputSchema: getProjectContextOutputSchema,
      ...oauthToolSecurity("mcp:read"),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id: projectId, task, context_budget: contextBudget }, context) => {
      let projectContext;
      try {
        projectContext = getProjectContext(database, {
          userId: authenticatedUserId(context),
          projectId,
          task,
          contextBudget,
        });
      } catch (error) {
        if (error instanceof ContextBudgetError) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
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
        "Use only after the user explicitly asks to save or record an update in alice. Do not call for ordinary project work, suggestions, summaries, or inferred save intent. Stores the bounded validated payload as immutable evidence and creates pending candidate claims for human review. Never accepts, rejects, supersedes, or otherwise changes trusted project state.",
      inputSchema: saveProjectUpdateSchema,
      ...oauthToolSecurity("mcp:write"),
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
        connectionId: authenticatedConnectionId(context),
        publicUrl,
        userId: authenticatedUserId(context),
        payload,
      });
      if ("error" in result) {
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

export function createApp({
  database: suppliedDatabase = undefined,
  databaseFilename = ":memory:",
  publicUrl,
  reviewUrl = publicUrl,
}) {
  const database = suppliedDatabase || openDatabase(databaseFilename);
  const oauth = createOAuth({ database, publicUrl });
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
      resourceName: "alice.",
      scopesSupported: ["mcp:read", "mcp:write"],
    }),
  );

  app.get("/health", (_request, response) => {
    response.json({ service: "alice-mcp", status: "ok" });
  });
  app.post("/register", (request, response) => oauth.register(request, response));
  app.get("/authorize", (request, response) => oauth.authorizeForm(request, response));
  app.post("/authorize", (request, response) => oauth.authorize(request, response));
  app.post("/token", (request, response) => oauth.token(request, response));
  app.post("/revoke", (request, response) => oauth.revoke(request, response));

  const authenticate = requireMcpBearerAuth({
    verifier: oauth.verifier,
    advertisedScopes: ["mcp:read", "mcp:write"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauth.resource)),
  });

  app.all("/mcp", authenticate, async (request, response) => {
    const protocolServer = createProtocolServer(database, reviewUrl);
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
