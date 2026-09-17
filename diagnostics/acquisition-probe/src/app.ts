import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { Express, Request } from "express";
import { DiagnosticRecordAlreadyExistsError, type DiagnosticRuntimeStore } from "./storage.ts";
import { ACQUISITION_TOOL_NAME, type AcquisitionSession } from "./types.ts";

export const ACQUISITION_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export const ACQUISITION_TOOL_DESCRIPTION = "Submit diagnostic acquisition evidence for this test.";

interface CapturedToolArguments {
  toolName: string;
  exactJson: string;
  parsed: Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

export function capturePreValidationToolArguments(
  body: unknown,
): CapturedToolArguments | undefined {
  const messages = Array.isArray(body) ? body : [body];
  const matches: CapturedToolArguments[] = [];
  for (const message of messages) {
    const object = asObject(message);
    if (object?.method !== "tools/call") continue;
    const params = asObject(object.params);
    if (params?.name !== ACQUISITION_TOOL_NAME) continue;
    const parsed = asObject(params.arguments);
    if (!parsed) continue;
    matches.push({
      toolName: ACQUISITION_TOOL_NAME,
      exactJson: JSON.stringify(parsed),
      parsed: JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>,
    });
  }
  if (matches.length > 1) throw new Error("Only one diagnostic tool call is allowed per request.");
  return matches[0];
}

export function createAcquisitionProtocolServer({
  store,
  session,
  capturedArguments,
}: {
  store: DiagnosticRuntimeStore;
  session: AcquisitionSession;
  capturedArguments?: CapturedToolArguments;
}): McpServer {
  const server = new McpServer({ name: "alice-acquisition-probe", version: "1.0.0" });
  const inputSchema = fromJsonSchema<Record<string, unknown>>(ACQUISITION_INPUT_JSON_SCHEMA);
  server.registerTool(
    ACQUISITION_TOOL_NAME,
    {
      title: "Submit acquisition evidence",
      description: ACQUISITION_TOOL_DESCRIPTION,
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (!capturedArguments || capturedArguments.toolName !== ACQUISITION_TOOL_NAME) {
        return {
          content: [{ type: "text", text: "Diagnostic argument snapshot unavailable." }],
          isError: true,
        };
      }
      try {
        if (JSON.stringify(input) !== capturedArguments.exactJson) {
          return {
            content: [
              { type: "text", text: "Diagnostic argument validation changed the payload." },
            ],
            isError: true,
          };
        }
        const record = await store.capture(
          session,
          capturedArguments.exactJson,
          capturedArguments.parsed,
        );
        return {
          content: [
            {
              type: "text",
              text: `Diagnostic evidence received as record ${record.record_id}. This confirms receipt only, not completeness or correctness.`,
            },
          ],
        };
      } catch (error) {
        if (error instanceof DiagnosticRecordAlreadyExistsError) {
          try {
            await store.recordOutcome(session, {
              source: "runtime",
              kind: "additional_call_attempted",
              value: "yes",
              detail_code: "rejected_after_first_capture",
            });
          } catch {
            // A failed diagnostic annotation must not turn a bounded rejection into acceptance.
          }
        }
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof DiagnosticRecordAlreadyExistsError
                  ? "This diagnostic session already received its one permitted call."
                  : "Diagnostic evidence could not be stored.",
            },
          ],
          isError: true,
        };
      }
    },
  );
  return server;
}

function sessionToken(request: Request): string {
  const value = request.params.sessionToken;
  return typeof value === "string" ? value : "";
}

export function createAcquisitionProbeApp({
  store,
  allowedHosts = ["127.0.0.1", "localhost", "[::1]"],
}: {
  store: DiagnosticRuntimeStore;
  allowedHosts?: string[];
}): Express {
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts,
    jsonLimit: "8mb",
  });
  app.get("/health", (_request, response) => {
    response.json({ service: "alice-acquisition-probe", status: "ok", alice_state_access: false });
  });
  app.all("/mcp/:sessionToken", async (request, response) => {
    const session = await store.resolveSessionToken(sessionToken(request));
    if (!session) {
      response.status(404).json({ error: "diagnostic_session_unavailable" });
      return;
    }
    let capturedArguments: CapturedToolArguments | undefined;
    try {
      capturedArguments = capturePreValidationToolArguments(request.body);
    } catch {
      response.status(400).json({ error: "multiple_diagnostic_calls_not_allowed" });
      return;
    }
    const protocolServer = createAcquisitionProtocolServer({
      store,
      session,
      ...(capturedArguments ? { capturedArguments } : {}),
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void protocolServer.close();
    });
    try {
      await protocolServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json({ error: "diagnostic_request_failed" });
    }
  });
  return app;
}
