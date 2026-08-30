import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const secretPatterns = [
  { label: "private key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "OpenAI-style secret", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "Anthropic secret", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

const publicSecretName =
  /\b(?:NEXT_PUBLIC|VITE|PUBLIC)_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b/;

export function findingsForText(filename, text) {
  const findings = [];
  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(text)) findings.push(`${filename}: possible ${label}`);
  }
  if (publicSecretName.test(text)) {
    findings.push(`${filename}: secret-like configuration uses a browser-public prefix`);
  }
  return findings;
}

function repositoryFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function scanRepository() {
  const findings = [];
  for (const filename of repositoryFiles()) {
    if (/^\.env(?:\.|$)/.test(filename) && filename !== ".env.example") {
      findings.push(`${filename}: environment files must not be tracked`);
      continue;
    }
    let text;
    try {
      const buffer = readFileSync(filename);
      if (buffer.includes(0)) continue;
      text = buffer.toString("utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      findings.push(`${filename}: could not scan file (${String(error)})`);
      continue;
    }
    findings.push(...findingsForText(filename, text));
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = scanRepository();
  if (findings.length > 0) {
    console.error(["Secret-leak check failed:", ...findings.map((item) => `- ${item}`)].join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Secret-leak check passed.");
  }
}
