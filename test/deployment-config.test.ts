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
const backupContainerScriptPath = new URL(
  "../scripts/verify-postgres-backup-container.mjs",
  import.meta.url,
);
const erasureContainerScriptPath = new URL(
  "../scripts/erase-project-container.mjs",
  import.meta.url,
);

test("production image pins the Lambda adapter and retains non-root portable startup", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const migrationContainerScript = await readFile(migrationContainerScriptPath, "utf8");
  const backupContainerScript = await readFile(backupContainerScriptPath, "utf8");
  const erasureContainerScript = await readFile(erasureContainerScriptPath, "utf8");
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1$/m);
  assert.equal(dockerfile.match(/^FROM node:24-alpine(?: AS \w+)?$/gm)?.length, 4);
  assert.match(dockerfile, /^FROM node:24-alpine AS backup$/m);
  assert.match(dockerfile, /^FROM node:24-alpine AS erasure$/m);
  assert.match(dockerfile, /apk add --no-cache postgresql17-client/);
  assert.match(dockerfile, /^RUN apk upgrade --no-cache libcrypto3 libssl3$/m);
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
  assert.match(dockerfile, /CMD \["npm", "run", "project:erase:container"\]/);
  assert.match(
    dockerfile,
    /COPY scripts\/build-mcp-app\.mjs scripts\/migrate-postgres\.mjs scripts\/migrate-postgres-container\.mjs scripts\/verify-postgres-backup\.mjs scripts\/verify-postgres-backup-container\.mjs scripts\/alpha-invitation-operator\.mjs scripts\/erase-project\.mjs scripts\/erase-project-container\.mjs \.\/scripts\//,
  );
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/scripts \.\/scripts/);
  assert.doesNotMatch(dockerfile, /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
  assert.doesNotMatch(dockerfile, /rejectUnauthorized\s*:\s*false/);
  assert.match(migrationContainerScript, /ALICE_DATABASE_SSLMODE \|\| "verify-full"/);
  assert.doesNotMatch(migrationContainerScript, /rejectUnauthorized\s*:\s*false/);
  assert.match(backupContainerScript, /ALICE_DATABASE_SSLMODE \|\| "verify-full"/);
  assert.match(
    backupContainerScript,
    /PGSSLROOTCERT \|\|= "\/app\/certs\/eu-central-1-bundle\.pem"/,
  );
  assert.doesNotMatch(backupContainerScript, /console\.|rejectUnauthorized\s*:\s*false/);
  assert.match(erasureContainerScript, /ALICE_DATABASE_SSLMODE \|\| "verify-full"/);
  assert.doesNotMatch(erasureContainerScript, /console\.|rejectUnauthorized\s*:\s*false/);
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
  assert.deepEqual(cors.AllowedOrigins, [
    { Ref: "WebPublicUrl" },
    "https://web-sandbox.oaiusercontent.com",
    "https://*.web-sandbox.oaiusercontent.com",
    "https://*.claudemcpcontent.com",
  ]);
  const originMatches = (pattern: string, origin: string) => {
    const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "[^.]+");
    return new RegExp(`^${expression}$`).test(origin);
  };
  const stringOrigins = cors.AllowedOrigins.filter((origin: unknown) => typeof origin === "string");
  assert.equal(
    stringOrigins.some((pattern: string) =>
      originMatches(
        pattern,
        "https://asdk_app_6aa31b4f3b8881919d8fe14a7e52d557.web-sandbox.oaiusercontent.com",
      ),
    ),
    true,
  );
  assert.equal(
    stringOrigins.some((pattern: string) =>
      originMatches(pattern, "https://0123456789abcdef0123456789abcdef.claudemcpcontent.com"),
    ),
    true,
  );
  for (const deniedOrigin of [
    "https://chatgpt.com",
    "https://claude.ai",
    "https://evil.example",
    "https://web-sandbox.oaiusercontent.com.evil.example",
  ]) {
    assert.equal(
      stringOrigins.some((pattern: string) => originMatches(pattern, deniedOrigin)),
      false,
    );
  }
  assert.equal(stringOrigins.includes("*"), false);
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

test("Lambda storage roles are credential-free and MCP writes only exact upload prefixes", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  const actionsFor = (resource) =>
    resource.Properties.Policies.flatMap(({ PolicyDocument }) =>
      PolicyDocument.Statement.flatMap(({ Action }) => (Array.isArray(Action) ? Action : [Action])),
    );
  const mcpActions = actionsFor(resources.McpExecutionRole);
  const webActions = actionsFor(resources.WebExecutionRole);
  const mcpStatements = resources.McpExecutionRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.equal(
    resources.McpExecutionRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service,
    "lambda.amazonaws.com",
  );
  assert.equal(mcpActions.includes("s3:PutObject"), true);
  assert.deepEqual(
    mcpStatements.find(({ Sid }) => Sid === "UploadAppStagingAndVerifiedObjects").Resource,
    [
      { "Fn::Sub": "${PrivateFilesBucket.Arn}/staging/*" },
      { "Fn::Sub": "${PrivateFilesBucket.Arn}/objects/*" },
    ],
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

test("private database operations are temporary, exclusive, and least-secret", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const resources = template.Resources;
  assert.equal(
    template.Rules.MigrationExcludesServices.Assertions[0].Assert["Fn::Equals"][1],
    "false",
  );
  assert.equal(template.Parameters.RunBackupVerification.Default, "false");
  assert.equal(template.Parameters.RunProjectErasure.Default, "false");
  assert.equal(
    template.Rules.BackupVerificationIsExclusive.Assertions[0].Assert["Fn::Equals"][1],
    "false",
  );
  assert.equal(
    template.Rules.BackupVerificationIsExclusive.Assertions[1].Assert["Fn::Equals"][1],
    "false",
  );
  assert.equal(
    template.Rules.ProjectErasureIsExclusive.Assertions.slice(0, 3).every(
      ({ Assert }) => Assert["Fn::Equals"][1] === "false",
    ),
    true,
  );
  assert.equal(
    template.Rules.ProjectErasureIsExclusive.Assertions[3].Assert["Fn::Not"][0]["Fn::Equals"][0]
      .Ref,
    "ErasureImageUri",
  );
  const temporaryResources = [
    "MigrationEndpointSecurityGroup",
    "MigrationEcrApiEndpoint",
    "MigrationEcrDkrEndpoint",
    "MigrationLogsEndpoint",
    "MigrationSecretsEndpoint",
    "MigrationCluster",
    "MigrationLogGroup",
    "MigrationExecutionRole",
    "MigrationTaskDefinition",
  ];
  assert.equal(temporaryResources.length, 9);
  for (const name of temporaryResources) {
    assert.equal(resources[name].Condition, "PrivateDatabaseTaskEnabled");
  }
  for (const name of temporaryResources.slice(1, 5)) {
    assert.equal(resources[name].Properties.VpcEndpointType, "Interface");
  }
  const task = resources.MigrationTaskDefinition;
  assert.equal(task.Condition, "PrivateDatabaseTaskEnabled");
  assert.deepEqual(task.Properties.RequiresCompatibilities, ["FARGATE"]);
  assert.equal(task.Properties.RuntimePlatform.CpuArchitecture, "ARM64");
  const container = task.Properties.ContainerDefinitions[0];
  assert.deepEqual(container.Image["Fn::If"], [
    "ProjectErasureEnabled",
    { Ref: "ErasureImageUri" },
    {
      "Fn::If": ["BackupVerificationEnabled", { Ref: "BackupImageUri" }, { Ref: "ImageUri" }],
    },
  ]);
  assert.deepEqual(container.Command["Fn::If"], [
    "ProjectErasureEnabled",
    ["npm", "run", "project:erase:container"],
    {
      "Fn::If": [
        "BackupVerificationEnabled",
        ["npm", "run", "db:backup:verify:container"],
        ["npm", "run", "db:migrate:container"],
      ],
    },
  ]);
  assert.deepEqual(container.TaskRoleArn, undefined);
  assert.deepEqual(task.Properties.TaskRoleArn["Fn::If"], [
    "ProjectErasureEnabled",
    { "Fn::GetAtt": ["ProjectErasureTaskRole", "Arn"] },
    { Ref: "AWS::NoValue" },
  ]);
  const [condition, backupSecrets, migrationSecrets] = container.Secrets["Fn::If"];
  assert.equal(condition, "PrivilegedDatabaseOperatorEnabled");
  assert.deepEqual(
    backupSecrets.map(({ Name }) => Name),
    ["ALICE_MIGRATION_DATABASE_PASSWORD"],
  );
  assert.deepEqual(migrationSecrets.map(({ Name }) => Name).sort(), [
    "ALICE_APPLICATION_DATABASE_PASSWORD",
    "ALICE_MIGRATION_DATABASE_PASSWORD",
  ]);
  assert.ok(
    container.Environment.some(
      ({ Name, Value }) =>
        Name === "PGSSLROOTCERT" && Value === "/app/certs/eu-central-1-bundle.pem",
    ),
  );
  assert.equal(
    container.Environment.some(({ Name }) => Name?.toLowerCase().includes("password")),
    false,
  );
  const secretResources =
    resources.MigrationExecutionRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource[
      "Fn::If"
    ];
  assert.equal(secretResources[0], "PrivilegedDatabaseOperatorEnabled");
  assert.equal(secretResources[1].length, 1);
  assert.equal(secretResources[2].length, 2);
  assert.doesNotMatch(JSON.stringify(template), /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);

  const erasureRole = resources.ProjectErasureTaskRole;
  assert.equal(erasureRole.Condition, "ProjectErasureEnabled");
  const erasureStatements = erasureRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.equal(erasureStatements[0].Action, "s3:ListBucketVersions");
  assert.deepEqual(erasureStatements[0].Condition.StringLike["s3:prefix"], [
    "objects/*",
    "staging/*",
  ]);
  assert.equal(erasureStatements[1].Action, "s3:DeleteObjectVersion");
  assert.equal(
    container.Environment.some(({ "Fn::If": conditional }: any) =>
      conditional?.some?.((value) => value?.Name === "ALICE_S3_BUCKET"),
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(container.Environment),
    /ALICE_PROJECT_ERASURE_(?:PROJECT_ID|REQUEST_ID|EXPECTED_PREVIEW)/,
  );
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
