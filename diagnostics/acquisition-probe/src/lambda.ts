import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { capturePreValidationToolArguments, createAcquisitionProtocolServer } from "./app.ts";
import { S3DiagnosticStore } from "./s3-storage.ts";
import type { DiagnosticRuntimeStore } from "./storage.ts";

export const HOSTED_MAXIMUM_BODY_BYTES = 5 * 1024 * 1024;

interface FunctionUrlEvent {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    domainName?: string;
    http?: { method?: string };
  };
}

interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

function result(statusCode: number, body: Record<string, unknown>): FunctionUrlResult {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function eventBodyBytes(event: FunctionUrlEvent): Buffer {
  const body = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
}

function tokenFromPath(rawPath: string): string | undefined {
  return /^\/mcp\/([A-Za-z0-9_-]{43})$/.exec(rawPath)?.[1];
}

async function responseResult(response: Response): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  });
  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

export function createAcquisitionLambdaHandler({
  store,
  allowedHost,
  maximumBodyBytes = HOSTED_MAXIMUM_BODY_BYTES,
}: {
  store: DiagnosticRuntimeStore;
  allowedHost: string;
  maximumBodyBytes?: number;
}): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  if (!allowedHost || allowedHost.includes(":")) {
    throw new Error("ACQUISITION_PROBE_ALLOWED_HOST must be one exact hostname without a port.");
  }
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1) {
    throw new Error("The hosted maximum request size is invalid.");
  }
  return async (event) => {
    const domainName = event.requestContext?.domainName ?? "";
    if (domainName !== allowedHost) return result(403, { error: "diagnostic_request_unavailable" });
    const method = event.requestContext?.http?.method?.toUpperCase() ?? "";
    const rawPath = event.rawPath ?? "";
    if (method === "GET" && rawPath === "/health") {
      return result(200, {
        service: "alice-acquisition-probe",
        status: "ok",
        alice_state_access: false,
        call_mode: "single-call-v1",
      });
    }
    const token = tokenFromPath(rawPath);
    if (!token || method !== "POST") {
      return result(404, { error: "diagnostic_session_unavailable" });
    }
    const session = await store.resolveSessionToken(token);
    if (!session) return result(404, { error: "diagnostic_session_unavailable" });

    const bodyBytes = eventBodyBytes(event);
    if (bodyBytes.byteLength > maximumBodyBytes) {
      await store.recordOutcome(session, {
        source: "runtime",
        kind: "payload_ceiling_reached",
        value: "yes",
        detail_code: "request_body_over_5_mib",
      });
      return result(413, { error: "diagnostic_request_too_large" });
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(bodyBytes.toString("utf8"));
    } catch {
      return result(400, { error: "diagnostic_request_invalid" });
    }
    let capturedArguments;
    try {
      capturedArguments = capturePreValidationToolArguments(parsedBody);
    } catch {
      return result(400, { error: "multiple_diagnostic_calls_not_allowed" });
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(event.headers ?? {})) {
      if (value !== undefined && !["cookie", "authorization"].includes(name.toLowerCase())) {
        headers.set(name, value);
      }
    }
    headers.set("host", allowedHost);
    headers.set("content-length", String(bodyBytes.byteLength));
    const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
    const request = new Request(`https://${allowedHost}${rawPath}${query}`, {
      method: "POST",
      headers,
      body: bodyBytes,
    });
    const protocolServer = createAcquisitionProtocolServer({
      store,
      session,
      ...(capturedArguments ? { capturedArguments } : {}),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await protocolServer.connect(transport);
      return await responseResult(await transport.handleRequest(request, { parsedBody }));
    } catch {
      return result(500, { error: "diagnostic_request_failed" });
    } finally {
      await transport.close();
      await protocolServer.close();
    }
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

let configuredHandler: ((event: FunctionUrlEvent) => Promise<FunctionUrlResult>) | undefined;

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  configuredHandler ??= createAcquisitionLambdaHandler({
    store: new S3DiagnosticStore({ bucket: requiredEnvironment("ACQUISITION_PROBE_BUCKET") }),
    allowedHost: requiredEnvironment("ACQUISITION_PROBE_ALLOWED_HOST"),
  });
  return await configuredHandler(event);
}
