import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, pathToFileURL } from "node:url";

export const PRIVATE_ALPHA_REGION = "eu-central-1";
export const PRIVATE_ALPHA_STACK = "alice-private-alpha";
export const PRIVATE_ALPHA_TEMPLATE = "infra/aws/private-files.template.json";
export const CLOUDFORMATION_TEMPLATE_BODY_LIMIT = 51_200;

const MODES = new Set([
  "private-runtime",
  "hosted-proof",
  "invitation-operator",
  "backup-verification",
  "project-erasure",
  "safe-stop",
]);
const PLACEHOLDER_IMAGE =
  "000000000000.dkr.ecr.eu-central-1.amazonaws.com/pending@sha256:0000000000000000000000000000000000000000000000000000000000000000";

function requireOrigin(name, value) {
  let url;
  try {
    url = new URL(value || "");
  } catch {
    throw new Error(`${name} must be an HTTPS Function URL origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".lambda-url.eu-central-1.on.aws")
  ) {
    throw new Error(`${name} must be an HTTPS Function URL origin.`);
  }
  return url.origin;
}

function requireImage(name, value) {
  if (
    !/^[0-9]{12}\.dkr\.ecr\.eu-central-1\.amazonaws\.com\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(
      value || "",
    ) ||
    value === PLACEHOLDER_IMAGE
  ) {
    throw new Error(`${name} must be an immutable Frankfurt ECR image digest.`);
  }
  return value;
}

export function createPrivateAlphaChangeSetPlan({
  backupImage,
  erasureImage,
  mode,
  name,
  webOrigin,
  mcpOrigin,
  operatorImage,
}) {
  if (!MODES.has(mode)) {
    throw new Error(`mode must be one of: ${[...MODES].join(", ")}.`);
  }
  if (!/^[A-Za-z0-9-]+$/.test(name || "")) {
    throw new Error("name must contain only letters, numbers, and hyphens.");
  }

  const parameters = [
    "ParameterKey=BucketName,UsePreviousValue=true",
    "ParameterKey=ImageUri,UsePreviousValue=true",
    "ParameterKey=OperatorImageUri,UsePreviousValue=true",
    `ParameterKey=BackupImageUri,ParameterValue=${PLACEHOLDER_IMAGE}`,
    `ParameterKey=ErasureImageUri,ParameterValue=${PLACEHOLDER_IMAGE}`,
    "ParameterKey=ResourcePrefix,UsePreviousValue=true",
    "ParameterKey=RunMigration,ParameterValue=false",
    "ParameterKey=RunBackupVerification,ParameterValue=false",
    "ParameterKey=RunProjectErasure,ParameterValue=false",
    "ParameterKey=RunInvitationOperator,ParameterValue=false",
  ];
  let description;

  if (mode === "private-runtime") {
    parameters.push(
      "ParameterKey=DeployServices,ParameterValue=true",
      "ParameterKey=OriginsConfigured,ParameterValue=false",
      "ParameterKey=WebPublicUrl,UsePreviousValue=true",
      "ParameterKey=McpPublicUrl,UsePreviousValue=true",
    );
    description =
      "Review-only private runtime: add services without public Function URL permissions or CORS.";
  } else if (mode === "hosted-proof") {
    const exactWebOrigin = requireOrigin("webOrigin", webOrigin);
    const exactMcpOrigin = requireOrigin("mcpOrigin", mcpOrigin);
    parameters.push(
      "ParameterKey=DeployServices,ParameterValue=true",
      "ParameterKey=OriginsConfigured,ParameterValue=true",
      `ParameterKey=WebPublicUrl,ParameterValue=${exactWebOrigin}`,
      `ParameterKey=McpPublicUrl,ParameterValue=${exactMcpOrigin}`,
    );
    description =
      "Review-only temporary hosted proof: exact-origin CORS and public Function URL permissions; do not execute without explicit approval.";
  } else if (mode === "invitation-operator") {
    const exactOperatorImage = requireImage("operatorImage", operatorImage);
    parameters[2] = `ParameterKey=OperatorImageUri,ParameterValue=${exactOperatorImage}`;
    parameters[9] = "ParameterKey=RunInvitationOperator,ParameterValue=true";
    parameters.push(
      "ParameterKey=DeployServices,ParameterValue=true",
      "ParameterKey=OriginsConfigured,ParameterValue=true",
      "ParameterKey=WebPublicUrl,UsePreviousValue=true",
      "ParameterKey=McpPublicUrl,UsePreviousValue=true",
    );
    description =
      "Review-only private direct-invoke invitation operator: three temporary resources, no Function URL or public permission; remove immediately after one use.";
  } else if (mode === "backup-verification") {
    const exactBackupImage = requireImage("backupImage", backupImage);
    parameters[3] = `ParameterKey=BackupImageUri,ParameterValue=${exactBackupImage}`;
    parameters[7] = "ParameterKey=RunBackupVerification,ParameterValue=true";
    parameters.push(
      "ParameterKey=DeployServices,ParameterValue=false",
      "ParameterKey=OriginsConfigured,ParameterValue=false",
      "ParameterKey=WebPublicUrl,UsePreviousValue=true",
      "ParameterKey=McpPublicUrl,UsePreviousValue=true",
    );
    description =
      "Review-only private backup/restore verifier: nine temporary resources, no runtime services; remove immediately after one successful run.";
  } else if (mode === "project-erasure") {
    const exactErasureImage = requireImage("erasureImage", erasureImage);
    parameters[4] = `ParameterKey=ErasureImageUri,ParameterValue=${exactErasureImage}`;
    parameters[8] = "ParameterKey=RunProjectErasure,ParameterValue=true";
    parameters.push(
      "ParameterKey=DeployServices,ParameterValue=true",
      "ParameterKey=OriginsConfigured,ParameterValue=true",
      "ParameterKey=WebPublicUrl,UsePreviousValue=true",
      "ParameterKey=McpPublicUrl,UsePreviousValue=true",
    );
    description =
      "Review-only two-phase private project erasure: ten temporary private resources, unchanged hosted services, exact IDs supplied only as ECS task overrides; remove immediately after verified completion.";
  } else {
    parameters.push(
      "ParameterKey=DeployServices,ParameterValue=false",
      "ParameterKey=OriginsConfigured,ParameterValue=false",
      "ParameterKey=WebPublicUrl,UsePreviousValue=true",
      "ParameterKey=McpPublicUrl,UsePreviousValue=true",
    );
    description =
      "Safe-stop: remove all runtime, Function URL, public-permission, and log resources; retain private foundation data.";
  }

  return { description, mode, name, parameters, public: mode === "hosted-proof" };
}

export function minifyCloudFormationTemplate(templateText) {
  const minified = JSON.stringify(JSON.parse(templateText));
  if (Buffer.byteLength(minified, "utf8") > CLOUDFORMATION_TEMPLATE_BODY_LIMIT) {
    throw new Error(
      `Minified CloudFormation template exceeds ${CLOUDFORMATION_TEMPLATE_BODY_LIMIT} bytes.`,
    );
  }
  return minified;
}

export function createChangeSetCommand(plan, { templatePath = PRIVATE_ALPHA_TEMPLATE } = {}) {
  return [
    "cloudformation",
    "create-change-set",
    "--region",
    PRIVATE_ALPHA_REGION,
    "--stack-name",
    PRIVATE_ALPHA_STACK,
    "--change-set-name",
    plan.name,
    "--change-set-type",
    "UPDATE",
    "--template-body",
    `file://${templatePath}`,
    "--parameters",
    ...plan.parameters,
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--description",
    plan.description,
    "--no-cli-pager",
  ];
}

function runAws(args) {
  const result = spawnSync("aws", args, { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
  return result.status === 0;
}

function parseArguments(argumentsList) {
  const [mode, ...flags] = argumentsList;
  const valueAfter = (flag) => {
    const index = flags.indexOf(flag);
    return index === -1 ? undefined : flags[index + 1];
  };
  return {
    create: flags.includes("--create"),
    mcpOrigin: valueAfter("--mcp-origin"),
    backupImage: valueAfter("--backup-image"),
    erasureImage: valueAfter("--erasure-image"),
    mode,
    name: valueAfter("--name") || `runtime-${mode}-${Date.now()}`,
    operatorImage: valueAfter("--operator-image"),
    webOrigin: valueAfter("--web-origin"),
  };
}

function usage() {
  console.error(
    "Usage: node scripts/private-alpha-change-set.mjs <private-runtime|hosted-proof|invitation-operator|backup-verification|project-erasure|safe-stop> [--name NAME] [--web-origin URL --mcp-origin URL] [--operator-image DIGEST_URI] [--backup-image DIGEST_URI] [--erasure-image DIGEST_URI] [--create]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  if (!options.mode) {
    usage();
    process.exitCode = 1;
  } else {
    try {
      const plan = createPrivateAlphaChangeSetPlan(options);
      const command = createChangeSetCommand(plan);
      console.log(JSON.stringify({ ...plan, command: ["aws", ...command] }, null, 2));
      if (options.create) {
        const temporaryDirectory = mkdtempSync(join(tmpdir(), "alice-cloudformation-"));
        const temporaryTemplate = join(temporaryDirectory, "private-files.template.min.json");
        try {
          writeFileSync(
            temporaryTemplate,
            minifyCloudFormationTemplate(readFileSync(PRIVATE_ALPHA_TEMPLATE, "utf8")),
            { mode: 0o600 },
          );
          const created = runAws(createChangeSetCommand(plan, { templatePath: temporaryTemplate }));
          if (created) {
            runAws([
              "cloudformation",
              "wait",
              "change-set-create-complete",
              "--region",
              PRIVATE_ALPHA_REGION,
              "--stack-name",
              PRIVATE_ALPHA_STACK,
              "--change-set-name",
              plan.name,
              "--no-cli-pager",
            ]);
            console.log(
              `Review with: aws cloudformation describe-change-set --region ${PRIVATE_ALPHA_REGION} --stack-name ${PRIVATE_ALPHA_STACK} --change-set-name ${plan.name} --no-cli-pager`,
            );
          }
        } finally {
          rmSync(temporaryDirectory, { recursive: true, force: true });
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to plan change set.");
      process.exitCode = 1;
    }
  }
}
