import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const contractPath = resolve(import.meta.dirname, "../evals/host-invocation-denominators.json");
const matrixPath = resolve(import.meta.dirname, "../evals/host-surface-compatibility.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

const exactSurfaces = new Set([
  "claude_web",
  "claude_desktop",
  "claude_ios",
  "claude_android",
  "claude_code",
  "chatgpt_web",
  "chatgpt_desktop",
  "codex_desktop",
  "codex_cli",
  "codex_ide_extension",
]);
const outcomes = ["successful_read", "failed_read", "no_call"];
const allowedTrialFields = new Set(["trial_id", "outcome"]);
const allowedCandidateFields = new Set([
  "method",
  "surface_id",
  "user_consent",
  "synthetic_fixture",
  "eligibility_declared_before_turn",
  "isolated_test_connection",
  "retained_trial_fields",
  "trials",
  "counts",
  "invocation_rate_percent",
]);
const allowedCountFields = new Set([
  "eligible_trials",
  "successful_read",
  "failed_read",
  "no_call",
  "observed_call_trials",
]);
const denominatorStatuses = new Set(["measurable", "provider_blocked", "untested"]);
const providerBlockedReasons = new Set([
  "surface_mcp_unavailable",
  "authorization_unavailable",
  "eligible_turn_unavailable",
]);
const forbiddenKeys = new Set([
  "prompt",
  "model_response",
  "conversation",
  "conversation_content",
  "project_content",
  "file_bytes",
  "credential",
  "credentials",
  "authorization_code",
  "access_token",
  "refresh_token",
  "client_secret",
  "inherited_from_surface_id",
]);

function roundPercent(numerator, denominator) {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function findForbiddenKey(value, path = "candidate") {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findForbiddenKey(item, `${path}[${index}]`);
      if (result) return result;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) return `${path}.${key}`;
    const result = findForbiddenKey(child, `${path}.${key}`);
    if (result) return result;
  }
  return null;
}

function scoreCohort(candidate) {
  const failures = [];
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).some((field) => !allowedCandidateFields.has(field))
  ) {
    failures.push("cohort retains fields outside the exact allowlist");
  }
  if (candidate?.method !== contract.method.id) failures.push("unapproved method");
  if (!exactSurfaces.has(candidate?.surface_id)) failures.push("unknown exact surface");
  if (candidate?.user_consent !== true) failures.push("missing explicit user consent");
  if (candidate?.synthetic_fixture !== true) failures.push("cohort is not synthetic");
  if (candidate?.eligibility_declared_before_turn !== true) {
    failures.push("eligibility was not declared before the host turn");
  }
  if (candidate?.isolated_test_connection !== true) {
    failures.push("trial did not use an isolated test connection");
  }
  if (
    !Array.isArray(candidate?.retained_trial_fields) ||
    candidate.retained_trial_fields.length !== allowedTrialFields.size ||
    candidate.retained_trial_fields.some((field) => !allowedTrialFields.has(field))
  ) {
    failures.push("retained trial fields exceed the content-free allowlist");
  }
  const forbiddenPath = findForbiddenKey(candidate);
  if (forbiddenPath) failures.push(`forbidden retained field at ${forbiddenPath}`);

  if (!Array.isArray(candidate?.trials) || candidate.trials.length === 0) {
    failures.push("cohort has no explicit eligible trials");
    return failures;
  }

  const trialIds = new Set();
  const derived = Object.fromEntries(outcomes.map((outcome) => [outcome, 0]));
  for (const trial of candidate.trials) {
    if (
      Object.keys(trial).some((field) => !allowedTrialFields.has(field)) ||
      Object.keys(trial).length !== allowedTrialFields.size
    ) {
      failures.push("trial retains fields outside trial_id and outcome");
    }
    if (typeof trial.trial_id !== "string" || !/^trial_[A-Za-z0-9_-]+$/.test(trial.trial_id)) {
      failures.push("trial ID is missing or not a safe opaque identifier");
    } else if (trialIds.has(trial.trial_id)) {
      failures.push(`duplicate trial ID ${trial.trial_id}`);
    }
    trialIds.add(trial.trial_id);
    if (!outcomes.includes(trial.outcome)) {
      failures.push(`invalid outcome ${trial.outcome}`);
    } else {
      derived[trial.outcome] += 1;
    }
  }

  const counts = candidate.counts || {};
  if (
    counts === null ||
    typeof counts !== "object" ||
    Array.isArray(counts) ||
    Object.keys(counts).length !== allowedCountFields.size ||
    Object.keys(counts).some((field) => !allowedCountFields.has(field))
  ) {
    failures.push("counts retain fields outside the exact aggregate allowlist");
  }
  const eligibleTrials = candidate.trials.length;
  const observedCallTrials = derived.successful_read + derived.failed_read;
  if (counts.eligible_trials !== eligibleTrials) {
    failures.push("denominator does not equal all explicit eligible trials");
  }
  for (const outcome of outcomes) {
    if (counts[outcome] !== derived[outcome]) {
      failures.push(`${outcome} count does not match explicit outcomes`);
    }
  }
  if (counts.observed_call_trials !== observedCallTrials) {
    failures.push("numerator does not equal successful plus failed read trials");
  }
  if (candidate.invocation_rate_percent !== roundPercent(observedCallTrials, eligibleTrials)) {
    failures.push("invocation percentage does not match the explicit cohort");
  }
  return failures;
}

function validateContract() {
  const errors = [];
  if (
    !contract.version ||
    !contract.as_of_date ||
    contract.contract !== "alice.host-invocation-denominator.v1"
  ) {
    errors.push("The denominator contract must be dated, versioned, and use the v1 contract ID.");
  }
  if (contract.method?.id !== "consented_synthetic_trials_v1") {
    errors.push("The denominator method must be consented_synthetic_trials_v1.");
  }
  if (JSON.stringify(contract.method?.outcomes) !== JSON.stringify(outcomes)) {
    errors.push("The method must distinguish successful_read, failed_read, and no_call.");
  }
  if (
    [...denominatorStatuses].some(
      (status) =>
        typeof contract.status_definitions?.[status] !== "string" ||
        contract.status_definitions[status].length === 0,
    )
  ) {
    errors.push("Every denominator status must have a non-empty definition.");
  }
  if (matrix.invocation_denominator_contract !== "evals/host-invocation-denominators.json") {
    errors.push("The host matrix must link to the denominator contract.");
  }

  const matrixSurfaces = new Map(matrix.surfaces.map((surface) => [surface.id, surface]));
  const denominatorSurfaces = new Set();
  const liveRuns = new Map();
  for (const run of contract.live_runs || []) {
    if (!run.id || liveRuns.has(run.id)) {
      errors.push(`Denominator live-run IDs must be present and unique: ${run.id || "missing"}.`);
    }
    liveRuns.set(run.id, run);
  }
  let measurableCount = 0;
  let untestedCount = 0;

  for (const surface of contract.surface_denominators || []) {
    if (!surface.surface_id || denominatorSurfaces.has(surface.surface_id)) {
      errors.push(`Denominator surface IDs must be present and unique: ${surface.surface_id}.`);
    }
    denominatorSurfaces.add(surface.surface_id);
    if (!exactSurfaces.has(surface.surface_id)) {
      errors.push(`Unexpected denominator surface ${surface.surface_id}.`);
    }
    if (!denominatorStatuses.has(surface.status)) {
      errors.push(`${surface.surface_id} has invalid denominator status ${surface.status}.`);
    }
    if (surface.status === "measurable") {
      measurableCount += 1;
      if (!surface.live_run_id || !liveRuns.has(surface.live_run_id)) {
        errors.push(`${surface.surface_id} is measurable without a durable live run.`);
      } else if (
        liveRuns.get(surface.live_run_id).surface_id !== surface.surface_id ||
        liveRuns.get(surface.live_run_id).status !== "measurable"
      ) {
        errors.push(`${surface.surface_id} references the wrong measurable live run.`);
      }
    } else if (surface.status === "untested") {
      untestedCount += 1;
      if (surface.live_run_id !== null) {
        errors.push(`${surface.surface_id} is untested but references a live run.`);
      }
    } else if (!surface.live_run_id || !liveRuns.has(surface.live_run_id)) {
      errors.push(`${surface.surface_id} is provider-blocked without a durable live run.`);
    } else if (
      liveRuns.get(surface.live_run_id).surface_id !== surface.surface_id ||
      liveRuns.get(surface.live_run_id).status !== "provider_blocked"
    ) {
      errors.push(`${surface.surface_id} references the wrong provider-blocked live run.`);
    }

    const matrixSurface = matrixSurfaces.get(surface.surface_id);
    if (matrixSurface?.advertised && surface.status !== "measurable") {
      errors.push(`${surface.surface_id} is advertised without a measurable denominator.`);
    }
  }
  if (
    denominatorSurfaces.size !== exactSurfaces.size ||
    [...exactSurfaces].some((surface) => !denominatorSurfaces.has(surface))
  ) {
    errors.push("The contract must contain each required host surface exactly once.");
  }
  if (
    matrixSurfaces.size !== exactSurfaces.size ||
    [...matrixSurfaces.keys()].some((surface) => !denominatorSurfaces.has(surface))
  ) {
    errors.push("The denominator registry and compatibility matrix surfaces must match exactly.");
  }

  for (const run of liveRuns.values()) {
    for (const field of [
      "id",
      "surface_id",
      "date",
      "provider_client_version",
      "account_type",
      "region",
      "deployment_commit",
      "evidence",
      "status",
    ]) {
      if (run[field] === undefined || run[field] === null || run[field] === "") {
        errors.push(`Denominator live run ${run.id || "missing"} lacks ${field}.`);
      }
    }
    if (!denominatorSurfaces.has(run.surface_id)) {
      errors.push(`Denominator live run ${run.id} refers to unknown surface ${run.surface_id}.`);
    }
    if (run.candidate?.surface_id !== run.surface_id) {
      if (run.status === "measurable") {
        errors.push(`Denominator live run ${run.id} candidate targets a different surface.`);
      }
    }
    if (run.status === "measurable") {
      for (const failure of scoreCohort(run.candidate)) {
        errors.push(`Denominator live run ${run.id}: ${failure}.`);
      }
    } else if (run.status === "provider_blocked") {
      if (!providerBlockedReasons.has(run.provider_blocked_reason)) {
        errors.push(`Denominator live run ${run.id} lacks a bounded provider-blocked reason.`);
      }
      if (run.candidate !== undefined) {
        errors.push(`Provider-blocked live run ${run.id} must not claim a measured cohort.`);
      }
    } else {
      errors.push(`Denominator live run ${run.id} has invalid status ${run.status}.`);
    }
  }

  return { errors, measurableCount, untestedCount };
}

const contractResult = validateContract();
const caseIds = new Set();
const results = [];
const structuralErrors = [];
for (const policyCase of contract.policy_cases || []) {
  if (!policyCase.id || caseIds.has(policyCase.id)) {
    structuralErrors.push(`Policy case IDs must be present and unique: ${policyCase.id}.`);
  }
  caseIds.add(policyCase.id);
  if (!new Set(["pass", "fail"]).has(policyCase.expected_policy_result)) {
    structuralErrors.push(`${policyCase.id} has an invalid expected policy result.`);
  }
  const failures = scoreCohort(policyCase.candidate);
  results.push({ ...policyCase, failures, policyResult: failures.length === 0 ? "pass" : "fail" });
}
if (results.length === 0) structuralErrors.push("The contract must include policy cases.");

const mismatches = results.filter(
  ({ expected_policy_result: expected, policyResult }) => expected !== policyResult,
);
if (structuralErrors.length > 0 || contractResult.errors.length > 0 || mismatches.length > 0) {
  for (const error of structuralErrors) console.error(`Fixture error: ${error}`);
  for (const error of contractResult.errors) console.error(`Contract error: ${error}`);
  for (const mismatch of mismatches) {
    console.error(
      `${mismatch.id}: expected ${mismatch.expected_policy_result}, scored ${mismatch.policyResult}; ${mismatch.failures.join("; ")}`,
    );
  }
  process.exitCode = 1;
} else {
  const passing = results.filter(({ policyResult }) => policyResult === "pass").length;
  const rejected = results.length - passing;
  console.log(
    `Invocation-denominator evaluation passed: ${results.length}/${results.length} expected outcomes (${passing} valid cohort fixtures, ${rejected} correctly rejected fixtures).`,
  );
  console.log(
    `Surface denominator registry valid: ${contract.surface_denominators.length} surfaces, ${contractResult.measurableCount} measurable, ${contractResult.untestedCount} untested.`,
  );
}
