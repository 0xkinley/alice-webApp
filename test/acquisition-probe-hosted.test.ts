import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ACQUISITION_INPUT_JSON_SCHEMA,
  ACQUISITION_TOOL_DESCRIPTION,
} from "../diagnostics/acquisition-probe/src/app.ts";
import { createAcquisitionLambdaHandler } from "../diagnostics/acquisition-probe/src/lambda.ts";
import { S3DiagnosticStore } from "../diagnostics/acquisition-probe/src/s3-storage.ts";
import {
  DiagnosticRecordAlreadyExistsError,
  FileDiagnosticStore,
  sha256,
} from "../diagnostics/acquisition-probe/src/storage.ts";
import {
  ACQUISITION_TOOL_NAME,
  type AcquisitionRunMetadata,
} from "../diagnostics/acquisition-probe/src/types.ts";
import { buildAcquisitionProbeLambda } from "../scripts/build-acquisition-probe-lambda.mjs";

function runMetadata(overrides: Partial<AcquisitionRunMetadata> = {}): AcquisitionRunMetadata {
  return {
    fixture_id: "alice-acquisition-hosted-test",
    provider: "chatgpt",
    account_plan: "test-plan",
    region: "test-region",
    surface: "web",
    host_version: "not exposed",
    entry_position: "new project conversation",
    acquisition_leg: "ambient",
    call_mode: "single-call-v1",
    trial: 1,
    exact_prompt: "Exact synthetic prompt",
    exact_prompt_sha256: sha256("Exact synthetic prompt"),
    ...overrides,
  };
}

interface RecordedCommand {
  name: string;
  input: Record<string, unknown>;
}

class MemoryS3Client {
  readonly objects = new Map<string, string>();
  readonly commands: RecordedCommand[] = [];

  async send(command: object): Promise<Record<string, unknown>> {
    const candidate = command as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    const name = candidate.constructor.name;
    const input = candidate.input;
    this.commands.push({ name, input });
    const key = String(input.Key ?? "");
    if (name === "PutObjectCommand") {
      if (input.IfNoneMatch === "*" && this.objects.has(key)) {
        throw Object.assign(new Error("precondition"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      this.objects.set(key, String(input.Body));
      return {};
    }
    if (name === "GetObjectCommand") {
      const body = this.objects.get(key);
      if (body === undefined) {
        throw Object.assign(new Error("missing"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { Body: { transformToString: async () => body } };
    }
    if (name === "ListObjectsV2Command") {
      const prefix = String(input.Prefix ?? "");
      return {
        Contents: [...this.objects.keys()]
          .filter((entry) => entry.startsWith(prefix))
          .map((entry) => ({ Key: entry })),
        IsTruncated: false,
      };
    }
    if (name === "DeleteObjectCommand") {
      this.objects.delete(key);
      return {};
    }
    throw new Error(`Unexpected fake S3 command: ${name}`);
  }
}

function lambdaEvent({
  host = "probe.lambda-url.eu-central-1.on.aws",
  path: rawPath,
  body,
}: {
  host?: string;
  path: string;
  body: Record<string, unknown> | string;
}) {
  return {
    version: "2.0",
    rawPath,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      cookie: "must-not-be-forwarded",
      authorization: "must-not-be-forwarded",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { domainName: host, http: { method: "POST" } },
  };
}

function mcpRequest(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };
}

test("S3 runtime uses digest lookup and atomic first-write-wins without list access", async () => {
  const client = new MemoryS3Client();
  const store = new S3DiagnosticStore({ bucket: "test-bucket", client });
  const now = new Date("2026-09-17T08:00:00.000Z");
  const { session, token } = await store.createSession(runMetadata(), { now });
  assert.ok(client.objects.has(`sessions/by-token/${sha256(token)}.json`));
  assert.ok(client.objects.has(`sessions/by-id/${session.session_id}.json`));

  client.commands.length = 0;
  assert.equal(
    (await store.resolveSessionToken(token, new Date("2026-09-17T08:01:00.000Z")))?.session_id,
    session.session_id,
  );
  assert.deepEqual(
    client.commands.map((command) => command.name),
    ["GetObjectCommand"],
  );
  assert.equal(client.commands[0]?.input.Key, `sessions/by-token/${sha256(token)}.json`);
  assert.equal(
    await store.resolveSessionToken(token, new Date("2026-09-18T08:00:00.000Z")),
    undefined,
  );

  const payload = { marker: "ALICE_PROJECT_01_TEST" };
  const captures = await Promise.allSettled([
    store.capture(session, JSON.stringify(payload), payload, new Date("2026-09-17T08:02:00.000Z")),
    store.capture(session, JSON.stringify(payload), payload, new Date("2026-09-17T08:02:00.001Z")),
  ]);
  assert.equal(captures.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = captures.find((entry) => entry.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof DiagnosticRecordAlreadyExistsError);
  assert.equal(
    client.commands.some((command) => command.name === "ListObjectsV2Command"),
    false,
  );

  await store.recordOutcome(session, {
    source: "operator",
    kind: "provider_observed_success",
    value: "yes",
    detail_code: "host_confirmed",
  });
  assert.equal((await store.readOutcomesForSession(session.session_id)).length, 1);
  const outcomeLists = client.commands.filter((command) => command.name === "ListObjectsV2Command");
  assert.ok(
    outcomeLists.every((command) => command.input.Prefix === `outcomes/${session.session_id}/`),
  );

  assert.deepEqual(await store.deleteSession(session.session_id), {
    session_deleted: true,
    record_deleted: true,
  });
  assert.equal(await store.verifySessionMissing(session.session_id), true);
});

test("Lambda adapter exposes the fixed tool contract, bounds bodies, and records retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alice-acquisition-lambda-"));
  const store = new FileDiagnosticStore(root);
  const { session, token } = await store.createSession(runMetadata());
  const allowedHost = "probe.lambda-url.eu-central-1.on.aws";
  const handler = createAcquisitionLambdaHandler({ store, allowedHost });

  const wrongHost = await handler(
    lambdaEvent({ host: "wrong.example", path: `/mcp/${token}`, body: {} }),
  );
  assert.equal(wrongHost.statusCode, 403);
  const expiredSession = await store.createSession(runMetadata({ trial: 3 }), {
    now: new Date("2020-01-01T00:00:00.000Z"),
  });
  const expired = await handler(
    lambdaEvent({ path: `/mcp/${expiredSession.token}`, body: mcpRequest("tools/list") }),
  );
  const unknown = await handler(
    lambdaEvent({ path: `/mcp/${"A".repeat(43)}`, body: mcpRequest("tools/list") }),
  );
  assert.equal(expired.statusCode, 404);
  assert.equal(unknown.statusCode, 404);
  assert.equal(expired.body, unknown.body);

  const listed = await handler(
    lambdaEvent({ path: `/mcp/${token}`, body: mcpRequest("tools/list") }),
  );
  assert.equal(listed.statusCode, 200);
  const listedBody = JSON.parse(listed.body);
  assert.equal(listedBody.result.tools.length, 1);
  assert.equal(listedBody.result.tools[0].name, ACQUISITION_TOOL_NAME);
  assert.equal(listedBody.result.tools[0].title, "Submit acquisition evidence");
  assert.equal(listedBody.result.tools[0].description, ACQUISITION_TOOL_DESCRIPTION);
  assert.deepEqual(listedBody.result.tools[0].inputSchema, ACQUISITION_INPUT_JSON_SCHEMA);
  assert.deepEqual(listedBody.result.tools[0].annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });

  const arbitrary = { provider_shape: { messages: ["one", "two"] } };
  const called = await handler(
    lambdaEvent({
      path: `/mcp/${token}`,
      body: mcpRequest("tools/call", { name: ACQUISITION_TOOL_NAME, arguments: arbitrary }),
    }),
  );
  assert.equal(called.statusCode, 200);
  assert.deepEqual((await store.readRecord(session.session_id))?.parsed_arguments, arbitrary);

  const repeated = await handler(
    lambdaEvent({
      path: `/mcp/${token}`,
      body: mcpRequest("tools/call", {
        name: ACQUISITION_TOOL_NAME,
        arguments: { rejected_payload_content: "must-not-replace-first" },
      }),
    }),
  );
  assert.equal(repeated.statusCode, 200);
  assert.equal(JSON.parse(repeated.body).result.isError, true);
  const outcomes = await store.readOutcomesForSession(session.session_id);
  assert.equal(outcomes.at(-1)?.kind, "additional_call_attempted");
  assert.equal(
    JSON.stringify(await store.readRecord(session.session_id)).includes("must-not-replace-first"),
    false,
  );

  const oversizedSession = await store.createSession(runMetadata({ trial: 2 }));
  const boundedHandler = createAcquisitionLambdaHandler({
    store,
    allowedHost,
    maximumBodyBytes: 10,
  });
  const oversized = await boundedHandler(
    lambdaEvent({ path: `/mcp/${oversizedSession.token}`, body: "not parsed because too large" }),
  );
  assert.equal(oversized.statusCode, 413);
  assert.equal(
    (await store.readOutcomesForSession(oversizedSession.session.session_id))[0]?.kind,
    "payload_ceiling_reached",
  );
  assert.equal(await store.readRecord(oversizedSession.session.session_id), undefined);
});

test("Lambda ZIP is deterministic, content-addressed, and within the direct upload limit", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "alice-acquisition-build-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "alice-acquisition-build-b-"));
  const [buildA, buildB] = await Promise.all([
    buildAcquisitionProbeLambda({ outputDirectory: first }),
    buildAcquisitionProbeLambda({ outputDirectory: second }),
  ]);
  assert.deepEqual(buildA.zip, buildB.zip);
  assert.equal(buildA.manifest.zip_sha256, buildB.manifest.zip_sha256);
  assert.equal(buildA.manifest.zip_sha256, createHash("sha256").update(buildA.zip).digest("hex"));
  assert.equal(buildA.manifest.artifact_key, `artifacts/${buildA.manifest.zip_sha256}.zip`);
  assert.equal(buildA.manifest.runtime, "nodejs24.x");
  assert.equal(buildA.manifest.architecture, "arm64");
  assert.equal(buildA.manifest.handler, "index.handler");
  assert.ok(buildA.zip.length < 50 * 1024 * 1024);
});

test("isolated CloudFormation grants only the reviewed runtime permissions", async () => {
  const templateText = await readFile(
    path.resolve("infra/aws/acquisition-probe.template.json"),
    "utf8",
  );
  const runtimeSources = await Promise.all(
    ["app.ts", "lambda.ts", "s3-storage.ts"].map((name) =>
      readFile(path.resolve("diagnostics/acquisition-probe/src", name), "utf8"),
    ),
  );
  assert.equal(
    runtimeSources.some((source) => source.includes("console.")),
    false,
  );
  const template = JSON.parse(templateText) as {
    Resources: Record<
      string,
      { Type: string; Condition?: string; Properties: Record<string, unknown> }
    >;
  };
  assert.doesNotMatch(templateText, /alice-private-alpha|AWS::RDS|AWS::SecretsManager|VpcConfig/);
  const resources = template.Resources;
  assert.deepEqual(
    Object.values(resources)
      .map((resource) => resource.Type)
      .sort(),
    [
      "AWS::IAM::Role",
      "AWS::Lambda::Function",
      "AWS::Lambda::Permission",
      "AWS::Lambda::Permission",
      "AWS::Lambda::Url",
      "AWS::Logs::LogGroup",
      "AWS::S3::Bucket",
      "AWS::S3::BucketPolicy",
    ].sort(),
  );
  assert.equal(resources.ProbeBucket?.Condition, undefined);
  assert.equal(resources.ProbeLogGroup?.Condition, undefined);
  assert.equal(resources.ProbeExecutionRole?.Condition, undefined);
  assert.equal(resources.ProbeFunction?.Condition, "RuntimeEnabled");
  assert.equal(resources.ProbeFunctionUrlPublicPermission?.Condition, "PublicAccessEnabled");
  assert.equal(resources.ProbeFunctionPublicInvokePermission?.Condition, "PublicAccessEnabled");

  const functionProperties = resources.ProbeFunction?.Properties as Record<string, unknown>;
  assert.equal(functionProperties.Runtime, "nodejs24.x");
  assert.deepEqual(functionProperties.Architectures, ["arm64"]);
  assert.equal(functionProperties.Handler, "index.handler");
  assert.equal(functionProperties.MemorySize, 256);
  assert.equal(functionProperties.Timeout, 30);
  assert.equal(functionProperties.ReservedConcurrentExecutions, 2);

  const role = resources.ProbeExecutionRole?.Properties as {
    Policies: Array<{ PolicyDocument: { Statement: Array<Record<string, unknown>> } }>;
  };
  const statements = role.Policies[0]?.PolicyDocument.Statement ?? [];
  const actions = statements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action],
  );
  assert.deepEqual(
    actions.sort(),
    ["logs:CreateLogStream", "logs:PutLogEvents", "s3:GetObject", "s3:PutObject"].sort(),
  );
  assert.equal(
    actions.some((action) => String(action).includes("List")),
    false,
  );
  assert.equal(
    actions.some((action) => String(action).includes("Delete")),
    false,
  );
  assert.match(JSON.stringify(statements), /sessions\/by-token\/\*/);
  assert.doesNotMatch(JSON.stringify(statements), /artifacts\/\*|records\/\*.*GetObject/);

  const urlPermission = resources.ProbeFunctionUrlPublicPermission?.Properties;
  assert.equal(urlPermission.Action, "lambda:InvokeFunctionUrl");
  const invokePermission = resources.ProbeFunctionPublicInvokePermission?.Properties;
  assert.equal(invokePermission.Action, "lambda:InvokeFunction");
  assert.equal(invokePermission.InvokedViaFunctionUrl, true);
});
