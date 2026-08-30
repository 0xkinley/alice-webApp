import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseHostedOrigin } from "../scripts/probe-hosted-services.mjs";

const templatePath = new URL("../infra/aws/private-files.template.json", import.meta.url);
const dockerfilePath = new URL("../Dockerfile", import.meta.url);

test("production image pins the Lambda adapter and retains non-root portable startup", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  assert.match(
    dockerfile,
    /aws-lambda-adapter:1\.0\.1@sha256:[0-9a-f]{64} \/lambda-adapter \/opt\/extensions\/lambda-adapter/,
  );
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["npm", "run", "start:mcp"\]/);
  assert.doesNotMatch(dockerfile, /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
});

test("hosted probes accept only credential-free HTTPS origins", () => {
  assert.equal(
    parseHostedOrigin("TEST_ORIGIN", "https://app.alice.example"),
    "https://app.alice.example",
  );
  for (const value of [
    "http://app.alice.example",
    "https://user:secret@app.alice.example",
    "https://app.alice.example/path",
    "https://app.alice.example/?token=secret",
  ]) {
    assert.throws(() => parseHostedOrigin("TEST_ORIGIN", value), /HTTPS origin/);
  }
});

test("private-file infrastructure is retained, blocked public, scanned, and credential-free", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  const bucket = resources.PrivateFilesBucket;
  assert.equal(bucket.DeletionPolicy, "Retain");
  assert.equal(bucket.UpdateReplacePolicy, "Retain");
  assert.equal(bucket.Properties.VersioningConfiguration.Status, "Enabled");
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
  assert.equal(resources.MalwareProtectionPlan.Properties.Actions.Tagging.Status, "ENABLED");
  const bucketPolicy = resources.PrivateFilesBucketPolicy.Properties.PolicyDocument.Statement;
  assert.ok(bucketPolicy.some(({ Sid }) => Sid === "DenyInsecureTransport"));
  assert.ok(bucketPolicy.some(({ Sid }) => Sid === "NoReadUnlessGuardDutyMarkedClean"));
  assert.ok(bucketPolicy.some(({ Sid }) => Sid === "OnlyGuardDutyCanSetScanStatus"));
  assert.equal(
    Object.values(resources).some(({ Type }: any) => Type === "AWS::IAM::AccessKey"),
    false,
  );
});

test("MCP storage identity is read-only and neither runtime identity can erase objects", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  const actionsFor = (resource) =>
    resource.Properties.Policies.flatMap(({ PolicyDocument }) =>
      PolicyDocument.Statement.flatMap(({ Action }) => (Array.isArray(Action) ? Action : [Action])),
    );
  const mcpActions = actionsFor(resources.McpFilesUser);
  const webActions = actionsFor(resources.WebFilesUser);
  assert.equal(
    mcpActions.some((action) => action.startsWith("s3:Put")),
    false,
  );
  assert.ok(webActions.includes("s3:PutObject"));
  for (const actions of [mcpActions, webActions]) {
    assert.equal(actions.includes("s3:DeleteObject"), false);
    assert.equal(actions.includes("s3:DeleteObjectVersion"), false);
    assert.equal(actions.includes("s3:ListBucket"), false);
  }
});
