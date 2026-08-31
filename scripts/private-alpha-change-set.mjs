import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PRIVATE_ALPHA_REGION = "eu-central-1";
export const PRIVATE_ALPHA_STACK = "alice-private-alpha";
export const PRIVATE_ALPHA_TEMPLATE = "infra/aws/private-files.template.json";

const MODES = new Set(["private-runtime", "hosted-proof", "safe-stop"]);

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

export function createPrivateAlphaChangeSetPlan({ mode, name, webOrigin, mcpOrigin }) {
  if (!MODES.has(mode)) {
    throw new Error(`mode must be one of: ${[...MODES].join(", ")}.`);
  }
  if (!/^[A-Za-z0-9-]+$/.test(name || "")) {
    throw new Error("name must contain only letters, numbers, and hyphens.");
  }

  const parameters = [
    "ParameterKey=BucketName,UsePreviousValue=true",
    "ParameterKey=ImageUri,UsePreviousValue=true",
    "ParameterKey=ResourcePrefix,UsePreviousValue=true",
    "ParameterKey=RunMigration,ParameterValue=false",
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

export function createChangeSetCommand(plan) {
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
    `file://${PRIVATE_ALPHA_TEMPLATE}`,
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
    mode,
    name: valueAfter("--name") || `runtime-${mode}-${Date.now()}`,
    webOrigin: valueAfter("--web-origin"),
  };
}

function usage() {
  console.error(
    "Usage: node scripts/private-alpha-change-set.mjs <private-runtime|hosted-proof|safe-stop> [--name NAME] [--web-origin URL --mcp-origin URL] [--create]",
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
        if (!runAws(command)) process.exit();
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
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to plan change set.");
      process.exitCode = 1;
    }
  }
}
