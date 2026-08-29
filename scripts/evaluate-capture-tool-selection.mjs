import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixturePath = resolve(import.meta.dirname, "../evals/capture-tool-selection.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const supportedAliceTools = new Set([
  "list_projects",
  "get_project_context",
  "save_project_update",
]);
const requiredScenarios = new Set([
  "correct_explicit_save",
  "correct_no_save",
  "incorrect_false_positive",
  "incorrect_false_negative",
  "incorrect_forbidden_review",
  "incorrect_duplicate_save",
]);
const structuralErrors = [];
const results = [];

if (!fixture.version || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
  structuralErrors.push("The capture evaluation fixture must be versioned and contain cases.");
}

const caseIds = new Set();
const coveredHosts = new Set();
const coveredScenarios = new Set();
for (const evaluationCase of fixture.cases || []) {
  if (!evaluationCase.id || caseIds.has(evaluationCase.id)) {
    structuralErrors.push(
      `Case IDs must be present and unique: ${evaluationCase.id || "missing"}.`,
    );
  }
  caseIds.add(evaluationCase.id);
  coveredHosts.add(evaluationCase.host);
  coveredScenarios.add(evaluationCase.scenario);

  const calls = Array.isArray(evaluationCase.alice_tool_calls)
    ? evaluationCase.alice_tool_calls
    : [];
  const saveCallCount = calls.filter((name) => name === "save_project_update").length;
  const unsupportedCalls = calls.filter((name) => !supportedAliceTools.has(name));
  const failures = [];

  if (evaluationCase.explicit_save_requested && saveCallCount !== 1) {
    failures.push("An explicit save must select save_project_update exactly once.");
  }
  if (!evaluationCase.explicit_save_requested && saveCallCount !== 0) {
    failures.push("Non-capture activity must not select save_project_update.");
  }
  if (unsupportedCalls.length > 0) {
    failures.push(`Unsupported alice. tool call(s): ${unsupportedCalls.join(", ")}.`);
  }

  const policyResult = failures.length === 0 ? "pass" : "fail";
  results.push({
    id: evaluationCase.id,
    expected: evaluationCase.expected_policy_result,
    failures,
    policyResult,
  });
}

for (const requiredHost of ["chatgpt", "claude", "provider-neutral"]) {
  if (!coveredHosts.has(requiredHost))
    structuralErrors.push(`Missing host coverage: ${requiredHost}.`);
}
for (const scenario of requiredScenarios) {
  if (!coveredScenarios.has(scenario))
    structuralErrors.push(`Missing scenario coverage: ${scenario}.`);
}

const mismatches = results.filter(({ expected, policyResult }) => expected !== policyResult);
if (structuralErrors.length > 0 || mismatches.length > 0) {
  for (const error of structuralErrors) console.error(`Fixture error: ${error}`);
  for (const mismatch of mismatches) {
    console.error(
      `${mismatch.id}: expected ${mismatch.expected}, scored ${mismatch.policyResult}; ${mismatch.failures.join(" ")}`,
    );
  }
  process.exitCode = 1;
} else {
  const passingTraces = results.filter(({ policyResult }) => policyResult === "pass").length;
  const rejectedTraces = results.length - passingTraces;
  console.log(
    `Capture tool-selection evaluation passed: ${results.length}/${results.length} expected outcomes (${passingTraces} compliant traces, ${rejectedTraces} correctly rejected traces).`,
  );
}
