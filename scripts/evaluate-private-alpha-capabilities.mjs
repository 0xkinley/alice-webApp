import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixturePath = resolve(import.meta.dirname, "../evals/private-alpha-capabilities.json");
const matrixPath = resolve(import.meta.dirname, "../evals/host-surface-compatibility.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

const exactSurfaces = new Set([
  "claude_web",
  "claude_desktop",
  "claude_ios",
  "claude_android",
  "claude_code",
  "chatgpt_web",
  "chatgpt_desktop",
]);
const matrixStatuses = new Set(["pass", "fail", "provider_blocked", "untested"]);
const forbiddenHostAuthority =
  /^host\.[^.]+\.(select_target|confirm_save|cancel_save|confirm_file_only|confirm_removal|grant_context|revoke_connection)$/;
const mutationEvents = new Set([
  "state.active_target_changed",
  "state.evidence_created",
  "state.candidate_created",
  "state.accepted_created",
  "state.file_reference_created",
  "state.exclusion_created",
  "state.project_membership_created",
  "state.context_grant_created",
  "state.connection_revoked",
]);

function indexAfter(trace, event, after = -1) {
  return trace.indexOf(event, after + 1);
}

function scoreAssertions(evaluationCase) {
  const failures = [];
  const trace = evaluationCase.trace;
  const assertions = evaluationCase.assertions || {};

  for (const event of assertions.required || []) {
    if (!trace.includes(event)) failures.push(`Required event is missing: ${event}.`);
  }
  for (const event of assertions.absent || []) {
    if (trace.includes(event)) failures.push(`Forbidden event is present: ${event}.`);
  }
  let previous = -1;
  for (const event of assertions.ordered || []) {
    const current = indexAfter(trace, event, previous);
    if (current === -1) {
      failures.push(`Ordered event is missing or out of order: ${event}.`);
      break;
    }
    previous = current;
  }
  for (const [event, exactCount] of Object.entries(assertions.exact_counts || {})) {
    const observed = trace.filter((candidate) => candidate === event).length;
    if (observed !== exactCount) {
      failures.push(`Event ${event} occurred ${observed} time(s), expected ${exactCount}.`);
    }
  }
  return failures;
}

function scoreTrustInvariants(evaluationCase) {
  const failures = [];
  const trace = evaluationCase.trace;
  const first = (event) => trace.indexOf(event);

  const forbiddenAuthorityEvent = trace.find((event) => forbiddenHostAuthority.test(event));
  if (forbiddenAuthorityEvent) {
    failures.push(`A host attempted a human-only action: ${forbiddenAuthorityEvent}.`);
  }

  if (
    trace.includes("state.active_target_changed") &&
    (first("human.select_target") === -1 ||
      first("human.select_target") > first("state.active_target_changed"))
  ) {
    failures.push("An active target changed without prior authenticated human selection.");
  }

  if (trace.includes("state.accepted_created")) {
    const confirmedAt = first("human.confirm_save");
    const acceptedAt = first("state.accepted_created");
    if (confirmedAt === -1 || confirmedAt > acceptedAt) {
      failures.push("Trusted context activated without a prior exact human confirmation.");
    }
  }

  if (trace.includes("state.candidate_created")) {
    const candidateAt = first("state.candidate_created");
    const eligibleSource = trace.findIndex(
      (event) =>
        event.endsWith(".save_project_update") ||
        event.endsWith(".suggest_project_updates_from_file") ||
        event === "concurrency.capture_same_idempotency_key",
    );
    if (eligibleSource === -1 || eligibleSource > candidateAt) {
      failures.push("A candidate appeared without prior evidence-producing capture.");
    }
  }

  if (trace.includes("state.file_reference_created")) {
    const referenceAt = first("state.file_reference_created");
    const confirmationAt = first("human.confirm_file_only");
    const stagingCleanAt = first("security.staging_scan_clean");
    const finalCleanAt = first("security.final_scan_clean");
    const transferAt = trace.findIndex(
      (event) =>
        event === "human.direct_upload" ||
        event === "human.fallback_upload" ||
        event.endsWith(".finalize_host_file_transfer"),
    );
    if (
      confirmationAt === -1 ||
      transferAt === -1 ||
      stagingCleanAt === -1 ||
      finalCleanAt === -1 ||
      confirmationAt > transferAt ||
      stagingCleanAt > finalCleanAt ||
      transferAt > finalCleanAt ||
      finalCleanAt > referenceAt
    ) {
      failures.push(
        "A file reference appeared without confirmation, transfer, and ordered staging/final clean gates.",
      );
    }
  }

  if (
    trace.includes("state.exclusion_created") &&
    (first("human.confirm_removal") === -1 ||
      first("human.confirm_removal") > first("state.exclusion_created"))
  ) {
    failures.push("Active context was removed without prior authenticated human confirmation.");
  }

  if (
    trace.includes("state.connection_revoked") &&
    (first("human.revoke_connection") === -1 ||
      first("human.revoke_connection") > first("state.connection_revoked"))
  ) {
    failures.push("A connection changed state without a prior human revocation action.");
  }

  const revokedAt = first("state.connection_revoked");
  if (revokedAt !== -1) {
    const successfulReadAfterRevocation = trace.findIndex(
      (event, index) => index > revokedAt && event === "state.accepted_context_returned",
    );
    if (successfulReadAfterRevocation !== -1) {
      failures.push("A revoked connection still returned accepted context.");
    }
  }

  if (
    evaluationCase.capability === "permission_non_disclosure" &&
    trace.some(
      (event) =>
        event.startsWith("state.") &&
        event.endsWith("_disclosed") &&
        event !== "state.no_metadata_disclosed",
    )
  ) {
    failures.push("A denied request disclosed restricted metadata.");
  }

  if (trace.includes("state.no_mutation")) {
    const noMutationAt = first("state.no_mutation");
    const laterMutation = trace.find(
      (event, index) => index > noMutationAt && mutationEvents.has(event),
    );
    if (laterMutation) failures.push(`A mutation followed a no-mutation result: ${laterMutation}.`);
  }

  if (
    trace.includes("state.accepted_used_without_restatement") &&
    (first("state.accepted_created") === -1 ||
      first("state.accepted_created") > first("state.accepted_used_without_restatement"))
  ) {
    failures.push("Cross-host accepted context was used before human-confirmed state existed.");
  }

  return failures;
}

function validateFixture() {
  const structuralErrors = [];
  const expectedCapabilities = new Set(fixture.capabilities || []);
  if (!fixture.version || !fixture.policy || expectedCapabilities.size === 0) {
    structuralErrors.push("The capability fixture must be versioned and declare its policy.");
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    structuralErrors.push("The capability fixture must contain cases.");
  }

  const ids = new Set();
  const passingCoverage = new Set();
  const hosts = new Set();
  const results = [];
  for (const evaluationCase of fixture.cases || []) {
    if (!evaluationCase.id || ids.has(evaluationCase.id)) {
      structuralErrors.push(
        `Case IDs must be present and unique: ${evaluationCase.id || "missing"}.`,
      );
    }
    ids.add(evaluationCase.id);
    hosts.add(evaluationCase.host);
    if (!expectedCapabilities.has(evaluationCase.capability)) {
      structuralErrors.push(
        `${evaluationCase.id} uses undeclared capability ${evaluationCase.capability}.`,
      );
    }
    if (!Array.isArray(evaluationCase.trace) || evaluationCase.trace.length === 0) {
      structuralErrors.push(`${evaluationCase.id} must contain a non-empty trace.`);
    }
    const failures = [...scoreAssertions(evaluationCase), ...scoreTrustInvariants(evaluationCase)];
    const policyResult = failures.length === 0 ? "pass" : "fail";
    if (evaluationCase.expected_policy_result === "pass") {
      passingCoverage.add(evaluationCase.capability);
    }
    results.push({ ...evaluationCase, failures, policyResult });
  }

  for (const capability of expectedCapabilities) {
    if (!passingCoverage.has(capability)) {
      structuralErrors.push(`Missing passing trace coverage for ${capability}.`);
    }
    const paths = fixture.runtime_evidence?.[capability];
    if (!Array.isArray(paths) || paths.length === 0) {
      structuralErrors.push(`Missing runtime evidence paths for ${capability}.`);
      continue;
    }
    for (const path of paths) {
      if (!existsSync(resolve(import.meta.dirname, "..", path))) {
        structuralErrors.push(`Runtime evidence path does not exist: ${path}.`);
      }
    }
  }
  for (const host of ["chatgpt", "claude", "provider-neutral", "cross-host"]) {
    if (!hosts.has(host)) structuralErrors.push(`Missing trace host coverage: ${host}.`);
  }

  const mismatches = results.filter(
    ({ expected_policy_result: expected, policyResult }) => expected !== policyResult,
  );
  return { structuralErrors, results, mismatches };
}

function validateMatrix() {
  const errors = [];
  if (!matrix.version || !matrix.as_of_date || !matrix.matrix_contract) {
    errors.push("The host-surface matrix must be dated and versioned.");
  }
  const capabilities = new Set(matrix.capabilities || []);
  if (capabilities.size !== 7) errors.push("The host-surface matrix must declare seven gates.");
  const liveRuns = new Map((matrix.live_runs || []).map((run) => [run.id, run]));
  const surfaceIds = new Set();
  let explicitResultCount = 0;
  let advertisedCount = 0;

  for (const surface of matrix.surfaces || []) {
    if (!surface.id || surfaceIds.has(surface.id)) {
      errors.push(`Surface IDs must be present and unique: ${surface.id || "missing"}.`);
    }
    surfaceIds.add(surface.id);
    if (!exactSurfaces.has(surface.id)) errors.push(`Unexpected surface: ${surface.id}.`);
    const resultKeys = new Set(Object.keys(surface.results || {}));
    if (
      resultKeys.size !== capabilities.size ||
      [...capabilities].some((capability) => !resultKeys.has(capability))
    ) {
      errors.push(`${surface.id} must record every capability explicitly.`);
    }
    for (const [capability, result] of Object.entries(surface.results || {})) {
      explicitResultCount += 1;
      const status = typeof result === "string" ? result : result?.status;
      const runId = typeof result === "string" ? undefined : result?.live_run_id;
      if (!matrixStatuses.has(status)) {
        errors.push(`${surface.id}/${capability} has invalid status ${status}.`);
      }
      if (status !== "untested" && (!runId || !liveRuns.has(runId))) {
        errors.push(`${surface.id}/${capability} lacks a durable live-run record.`);
      }
    }
    if (surface.advertised) {
      advertisedCount += 1;
      if (
        surface.overall_status !== "pass" ||
        Object.values(surface.results).some(
          (result) => (typeof result === "string" ? result : result?.status) !== "pass",
        )
      ) {
        errors.push(`${surface.id} is advertised without every capability passing.`);
      }
    }
  }
  if (
    surfaceIds.size !== exactSurfaces.size ||
    [...exactSurfaces].some((surface) => !surfaceIds.has(surface))
  ) {
    errors.push("The matrix must contain each required host surface exactly once.");
  }
  for (const run of liveRuns.values()) {
    for (const field of [
      "id",
      "surface_id",
      "date",
      "provider_client_version",
      "account_type",
      "region",
      "transport",
      "authorization_scopes",
      "deployment_commit",
      "evidence",
    ]) {
      if (run[field] === undefined || run[field] === null || run[field] === "") {
        errors.push(`Live run ${run.id || "missing"} lacks ${field}.`);
      }
    }
    if (!surfaceIds.has(run.surface_id)) {
      errors.push(`Live run ${run.id} refers to unknown surface ${run.surface_id}.`);
    }
  }
  return { errors, explicitResultCount, advertisedCount };
}

const fixtureResult = validateFixture();
const matrixResult = validateMatrix();
if (
  fixtureResult.structuralErrors.length > 0 ||
  fixtureResult.mismatches.length > 0 ||
  matrixResult.errors.length > 0
) {
  for (const error of fixtureResult.structuralErrors) console.error(`Fixture error: ${error}`);
  for (const mismatch of fixtureResult.mismatches) {
    console.error(
      `${mismatch.id}: expected ${mismatch.expected_policy_result}, scored ${mismatch.policyResult}; ${mismatch.failures.join(" ")}`,
    );
  }
  for (const error of matrixResult.errors) console.error(`Matrix error: ${error}`);
  process.exitCode = 1;
} else {
  const passing = fixtureResult.results.filter(
    ({ policyResult }) => policyResult === "pass",
  ).length;
  const rejected = fixtureResult.results.length - passing;
  console.log(
    `Private-alpha capability evaluation passed: ${fixtureResult.results.length}/${fixtureResult.results.length} expected outcomes (${passing} compliant traces, ${rejected} correctly rejected traces).`,
  );
  console.log(
    `Host-surface matrix valid: ${matrix.surfaces.length} surfaces, ${matrixResult.explicitResultCount} explicit capability results, ${matrixResult.advertisedCount} advertised surfaces.`,
  );
}
