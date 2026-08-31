import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseHostedOrigin } from "../scripts/probe-hosted-services.mjs";

const templatePath = new URL("../infra/aws/private-files.template.json", import.meta.url);
const dockerfilePath = new URL("../Dockerfile", import.meta.url);
const migrationContainerScriptPath = new URL(
  "../scripts/migrate-postgres-container.mjs",
  import.meta.url,
);

test("production image pins the Lambda adapter and retains non-root portable startup", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const migrationContainerScript = await readFile(migrationContainerScriptPath, "utf8");
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1$/m);
  assert.match(
    dockerfile,
    /ADD --checksum=sha256:56a0cae044b6cc433971d964347401692a92ea0294e392753a3ebdaee54d8b84/,
  );
  assert.match(
    dockerfile,
    /https:\/\/truststore\.pki\.rds\.amazonaws\.com\/eu-central-1\/eu-central-1-bundle\.pem/,
  );
  assert.match(dockerfile, /\.\/certs\/eu-central-1-bundle\.pem/);
  assert.match(dockerfile, /ENV NODE_EXTRA_CA_CERTS=\/app\/certs\/eu-central-1-bundle\.pem/);
  assert.match(
    dockerfile,
    /COPY --from=build --chown=node:node --chmod=0644 \/app\/certs\/eu-central-1-bundle\.pem \.\/certs\/eu-central-1-bundle\.pem/,
  );
  assert.match(
    dockerfile,
    /RUN chmod 0755 \.\/certs && chmod 0644 \.\/certs\/eu-central-1-bundle\.pem/,
  );
  assert.match(
    dockerfile,
    /aws-lambda-adapter:1\.0\.1@sha256:[0-9a-f]{64} \/lambda-adapter \/opt\/extensions\/lambda-adapter/,
  );
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["npm", "run", "start:mcp"\]/);
  assert.match(
    dockerfile,
    /COPY scripts\/migrate-postgres\.mjs scripts\/migrate-postgres-container\.mjs scripts\/alpha-invitation-operator\.mjs \.\/scripts\//,
  );
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/scripts \.\/scripts/);
  assert.doesNotMatch(dockerfile, /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
  assert.doesNotMatch(dockerfile, /rejectUnauthorized\s*:\s*false/);
  assert.match(migrationContainerScript, /ALICE_DATABASE_SSLMODE \|\| "verify-full"/);
  assert.doesNotMatch(migrationContainerScript, /rejectUnauthorized\s*:\s*false/);
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
  const cors = bucket.Properties.CorsConfiguration["Fn::If"][1].CorsRules[0];
  assert.deepEqual(cors.AllowedMethods, ["PUT"]);
  assert.deepEqual(cors.AllowedOrigins, [{ Ref: "WebPublicUrl" }]);
  assert.deepEqual(cors.ExposedHeaders, ["ETag", "x-amz-version-id"]);
  const lifecycle = bucket.Properties.LifecycleConfiguration.Rules;
  assert.ok(lifecycle.every(({ Prefix }) => Prefix === "staging/"));
  assert.ok(lifecycle.some(({ ExpirationInDays }) => ExpirationInDays === 2));
  assert.ok(
    lifecycle.some(
      ({ NoncurrentVersionExpiration }) => NoncurrentVersionExpiration?.NoncurrentDays === 1,
    ),
  );
  const bucketPolicy = resources.PrivateFilesBucketPolicy.Properties.PolicyDocument.Statement;
  assert.ok(bucketPolicy.some(({ Sid }) => Sid === "DenyInsecureTransport"));
  assert.ok(bucketPolicy.some(({ Sid }) => Sid === "NoReadUnlessGuardDutyMarkedClean"));
  assert.ok(bucketPolicy.some(({ Sid }) => Sid === "OnlyGuardDutyCanSetScanStatus"));
  assert.equal(
    Object.values(resources).some(({ Type }: any) => Type === "AWS::IAM::AccessKey"),
    false,
  );
  assert.equal(
    Object.values(resources).some(({ Type }: any) => Type === "AWS::IAM::User"),
    false,
  );
  assert.equal(
    Object.values(resources).some(({ Type }: any) => Type === "AWS::Budgets::Budget"),
    false,
  );
});

test("Lambda storage roles are credential-free and MCP remains exact-version read-only", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  const actionsFor = (resource) =>
    resource.Properties.Policies.flatMap(({ PolicyDocument }) =>
      PolicyDocument.Statement.flatMap(({ Action }) => (Array.isArray(Action) ? Action : [Action])),
    );
  const mcpActions = actionsFor(resources.McpExecutionRole);
  const webActions = actionsFor(resources.WebExecutionRole);
  assert.equal(
    resources.McpExecutionRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service,
    "lambda.amazonaws.com",
  );
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

test("AWS-native services are private, bounded, buffered, and staged before public access", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  const serializedTemplate = JSON.stringify(template);
  assert.equal(serializedTemplate.match(/sslmode=verify-full/g)?.length, 3);
  assert.doesNotMatch(serializedTemplate, /sslmode=require/);
  assert.equal(template.Rules.FrankfurtOnly.Assertions[0].Assert["Fn::Equals"][1], "eu-central-1");
  assert.equal(
    Object.values(resources).some(({ Type }: any) =>
      ["AWS::EC2::InternetGateway", "AWS::EC2::NatGateway"].includes(Type),
    ),
    false,
  );
  assert.equal(resources.DatabaseWriter.Properties.PubliclyAccessible, false);
  assert.deepEqual(resources.DatabaseCluster.Properties.ServerlessV2ScalingConfiguration, {
    MinCapacity: 0,
    MaxCapacity: 1,
    SecondsUntilAutoPause: 600,
  });
  assert.equal(resources.DatabaseCluster.Properties.EngineVersion, "17.4");
  assert.equal(resources.DatabaseCluster.Properties.DeletionProtection, true);
  assert.equal(resources.S3GatewayEndpoint.Properties.VpcEndpointType, "Gateway");
  for (const name of ["WebFunction", "McpFunction"]) {
    const resource = resources[name];
    assert.equal(resource.Condition, "ServicesEnabled");
    assert.deepEqual(resource.Properties.Architectures, ["arm64"]);
    assert.equal(resource.Properties.PackageType, "Image");
    assert.equal("ReservedConcurrentExecutions" in resource.Properties, false);
    assert.equal(resource.Properties.Environment.Variables.AWS_LWA_INVOKE_MODE, "buffered");
    assert.equal(resource.Properties.Environment.Variables.AWS_LWA_READINESS_CHECK_PROTOCOL, "tcp");
    assert.equal(resource.Properties.VpcConfig.SubnetIds.length, 2);
  }
  assert.equal(resources.WebFunction.Properties.MemorySize, 512);
  assert.equal(resources.McpFunction.Properties.MemorySize, 1024);
  for (const name of ["WebFunctionUrl", "McpFunctionUrl"]) {
    assert.equal(resources[name].Properties.AuthType, "NONE");
    assert.equal(resources[name].Properties.InvokeMode, "BUFFERED");
  }
  const urlPermissions = Object.values(resources).filter(
    ({ Type, Condition }: any) =>
      Type === "AWS::Lambda::Permission" && Condition === "PublicOriginsReady",
  ) as any[];
  assert.equal(urlPermissions.length, 4);
  assert.deepEqual(
    new Set(urlPermissions.map(({ Properties }) => Properties.Action)),
    new Set(["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"]),
  );
  assert.ok(
    urlPermissions
      .filter(({ Properties }) => Properties.Action === "lambda:InvokeFunction")
      .every(({ Properties }) => Properties.InvokedViaFunctionUrl === true),
  );
});

test("private migration access is temporary, secret-backed, and cannot coexist with services", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  assert.equal(
    template.Rules.MigrationExcludesServices.Assertions[0].Assert["Fn::Equals"][1],
    "false",
  );
  for (const name of [
    "MigrationEcrApiEndpoint",
    "MigrationEcrDkrEndpoint",
    "MigrationLogsEndpoint",
    "MigrationSecretsEndpoint",
  ]) {
    assert.equal(resources[name].Condition, "MigrationEnabled");
    assert.equal(resources[name].Properties.VpcEndpointType, "Interface");
  }
  const task = resources.MigrationTaskDefinition;
  assert.equal(task.Condition, "MigrationEnabled");
  assert.deepEqual(task.Properties.RequiresCompatibilities, ["FARGATE"]);
  assert.equal(task.Properties.RuntimePlatform.CpuArchitecture, "ARM64");
  const container = task.Properties.ContainerDefinitions[0];
  assert.deepEqual(container.Command, ["npm", "run", "db:migrate:container"]);
  assert.deepEqual(container.Secrets.map(({ Name }) => Name).sort(), [
    "ALICE_APPLICATION_DATABASE_PASSWORD",
    "ALICE_MIGRATION_DATABASE_PASSWORD",
  ]);
  assert.equal(
    container.Environment.some(({ Name }) => Name.toLowerCase().includes("password")),
    false,
  );
  assert.doesNotMatch(JSON.stringify(template), /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
});

test("the invitation operator is temporary, private, and narrowly permissioned", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  assert.equal(template.Parameters.RunInvitationOperator.Default, "false");
  assert.equal(resources.InvitationOperatorExecutionRole.Condition, "InvitationOperatorEnabled");
  assert.deepEqual(resources.InvitationOperatorExecutionRole.Properties.Policies, undefined);
  assert.equal(resources.InvitationOperatorLogGroup.Properties.RetentionInDays, 1);

  const operator = resources.InvitationOperatorFunction;
  assert.equal(operator.Condition, "InvitationOperatorEnabled");
  assert.equal(operator.Properties.Code.ImageUri.Ref, "OperatorImageUri");
  assert.deepEqual(operator.Properties.ImageConfig.Command, [
    "node",
    "scripts/alpha-invitation-operator.mjs",
  ]);
  assert.equal("ReservedConcurrentExecutions" in operator.Properties, false);
  assert.equal(operator.Properties.Timeout, 30);
  assert.equal(operator.Properties.Environment.Variables.ALICE_WEB_URL.Ref, "WebPublicUrl");
  assert.equal("ALICE_S3_BUCKET" in operator.Properties.Environment.Variables, false);

  const targetsOperator = Object.values(resources).filter(({ Properties }: any) => {
    const serialized = JSON.stringify(Properties || {});
    return serialized.includes("InvitationOperatorFunction");
  }) as any[];
  assert.equal(
    targetsOperator.some(({ Type }) =>
      ["AWS::Lambda::Permission", "AWS::Lambda::Url"].includes(Type),
    ),
    false,
  );
});
