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
  activeTargetForConnection,
  getProjectContext,
  listProjects,
  listSelectableProjectContexts,
  saveCandidateUpdate,
} from "@alice/domain";
import {
  consumptionContractVersion,
  getActiveContextSchema,
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
      const userId = authenticatedUserId(context);
      const connectionId = authenticatedConnectionId(context);
      const [projects, selectable, activeTarget] = await Promise.all([
        listProjects(database, userId),
        listSelectableProjectContexts(database, userId),
        activeTargetForConnection(database, { userId, connectionId }),
      ]);
      const contextsByProject = new Map(
        selectable.map((project) => [project.id, project.contexts]),
      );
      const output = {
        contract_version: consumptionContractVersion,
        projects: projects.map((project) => ({
          ...project,
          contexts: contextsByProject.get(project.id) || [],
        })),
        active_target: activeTarget || null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_active_context",
    {
      title: "Get the active alice. context",
      description:
        "Retrieve the deterministic, budget-bounded context package for the project and work context that this user selected for this exact AI connection in alice. Includes project-wide entries plus the selected work context. Use this normal continuation path without asking the user to repeat a project identifier or say ‘use alice.’. Returns an explicit error when no target is selected and cannot change selection or trusted state.",
      inputSchema: getActiveContextSchema,
      outputSchema: getProjectContextOutputSchema,
      ...oauthToolSecurity("mcp:read"),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task, context_budget: contextBudget }, context) => {
      const userId = authenticatedUserId(context);
      const connectionId = authenticatedConnectionId(context);
      const target = await activeTargetForConnection(database, { userId, connectionId });
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `No active alice. project/work context is selected for this connection. Select one at ${new URL("/connections", publicUrl).href}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const activeContext = await getProjectContext(database, {
          userId,
          projectId: target.project_id,
          contextId: target.context_id,
          task,
          contextBudget,
        });
        if (!activeContext) {
          return {
            content: [{ type: "text", text: "The active target is no longer accessible." }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(activeContext) }],
          structuredContent: activeContext,
        };
      } catch (error) {
        if (error instanceof ContextBudgetError) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
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
    async (
      { project_id: projectId, context_id: contextId, task, context_budget: contextBudget },
      context,
    ) => {
      let projectContext;
      try {
        projectContext = await getProjectContext(database, {
          userId: authenticatedUserId(context),
          projectId,
          contextId,
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
        "Use only after the user explicitly asks to save or record an update in alice. Do not call for ordinary project work, suggestions, summaries, or inferred save intent. Uses this connection's active alice. project/work context when destination fields are omitted; explicit destination fields must match that active target. Stores the bounded validated payload as immutable evidence and creates pending candidate claims for exact human confirmation. Never accepts, rejects, supersedes, or otherwise changes trusted project state.",
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
      const result = await saveCandidateUpdate(database, {
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

export async function createApp({
  database: suppliedDatabase = undefined,
  databaseUrl,
  publicUrl,
  reviewUrl = publicUrl,
}) {
  const database = suppliedDatabase || (await openDatabase({ connectionString: databaseUrl }));
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

  app.get("/health", async (_request, response) => {
    try {
      await database.query("SELECT 1");
      response.json({ database: "reachable", service: "alice-mcp", status: "ok" });
    } catch {
      response.status(503).json({ database: "unreachable", service: "alice-mcp", status: "error" });
    }
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
