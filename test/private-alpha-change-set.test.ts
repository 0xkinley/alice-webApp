import assert from "node:assert/strict";
import test from "node:test";
import {
  createChangeSetCommand,
  createPrivateAlphaChangeSetPlan,
  PRIVATE_ALPHA_REGION,
  PRIVATE_ALPHA_STACK,
} from "../scripts/private-alpha-change-set.mjs";

test("safe-stop plan disables services and public origins without changing retained values", () => {
  const plan = createPrivateAlphaChangeSetPlan({
    mode: "safe-stop",
    name: "runtime-stage-8-stop",
  });

  assert.equal(plan.public, false);
  assert.deepEqual(plan.parameters, [
    "ParameterKey=BucketName,UsePreviousValue=true",
    "ParameterKey=ImageUri,UsePreviousValue=true",
    "ParameterKey=ResourcePrefix,UsePreviousValue=true",
    "ParameterKey=RunMigration,ParameterValue=false",
    "ParameterKey=DeployServices,ParameterValue=false",
    "ParameterKey=OriginsConfigured,ParameterValue=false",
    "ParameterKey=WebPublicUrl,UsePreviousValue=true",
    "ParameterKey=McpPublicUrl,UsePreviousValue=true",
  ]);
});

test("hosted-proof plan requires exact Frankfurt Function URL origins", () => {
  assert.throws(
    () =>
      createPrivateAlphaChangeSetPlan({
        mode: "hosted-proof",
        name: "runtime-stage-5-origins",
        webOrigin: "https://example.com",
        mcpOrigin: "https://mcp.lambda-url.eu-central-1.on.aws",
      }),
    /webOrigin must be an HTTPS Function URL origin/,
  );

  const plan = createPrivateAlphaChangeSetPlan({
    mode: "hosted-proof",
    name: "runtime-stage-5-origins",
    webOrigin: "https://web.lambda-url.eu-central-1.on.aws",
    mcpOrigin: "https://mcp.lambda-url.eu-central-1.on.aws",
  });
  const command = createChangeSetCommand(plan);

  assert.equal(plan.public, true);
  assert.deepEqual(command.slice(0, 6), [
    "cloudformation",
    "create-change-set",
    "--region",
    PRIVATE_ALPHA_REGION,
    "--stack-name",
    PRIVATE_ALPHA_STACK,
  ]);
  assert.ok(command.includes("ParameterKey=OriginsConfigured,ParameterValue=true"));
});
