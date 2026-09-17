import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./storage.ts";
import type {
  AcquisitionFixtureManifest,
  AcquisitionOutcome,
  AcquisitionOutcomeValue,
  AcquisitionRecord,
  FixtureMarkerGroup,
} from "./types.ts";

interface LocatedString {
  path: string;
  value: string;
}

export interface AcquisitionRunScore {
  session_id: string;
  provider: string;
  surface: string;
  acquisition_leg: string;
  call_mode: "single-call-v1";
  trial: number;
  received_at: string;
  argument_sha256: string;
  argument_utf8_bytes: number;
  marker_counts: Record<keyof FixtureMarkerGroup, { recovered: number; expected: number }>;
  recovered_markers: string[];
  missing_markers: string[];
  false_markers_returned: string[];
  duplicate_markers: Array<{ marker: string; occurrences: number }>;
  marker_coverage_percent: number;
  conversation_order_preserved_for_recovered_markers: boolean;
  message_order_preserved_for_recovered_markers: boolean;
  marker_paths: Record<string, string[]>;
  exact_file_bytes: Array<{
    name: string;
    required: boolean;
    sha256: string;
    matched: boolean;
  }>;
  exact_artifact_bytes: boolean;
  outcomes: {
    evidence_captured: "yes";
    provider_observed_success: AcquisitionOutcomeValue;
    additional_call_attempted: AcquisitionOutcomeValue;
    truncation_or_chunking_observed: AcquisitionOutcomeValue;
    payload_ceiling_reached: AcquisitionOutcomeValue;
  };
  bounded_multi_call_triggered: boolean;
  bounded_multi_call_trigger_reasons: string[];
}

export interface AcquisitionScoreReport {
  contract_version: "alice_acquisition_score_v1";
  fixture_id: string;
  generated_at: string;
  runs: AcquisitionRunScore[];
  groups: Array<{
    provider: string;
    surface: string;
    acquisition_leg: string;
    trials: number[];
    marker_recovery_distribution: number[];
    marker_coverage_distribution_percent: number[];
    false_marker_distribution: number[];
    exact_required_file_distribution: number[];
  }>;
  outcomes_without_evidence: AcquisitionOutcome[];
  bounded_multi_call_trigger_session_ids: string[];
  manual_review_required: string[];
}

function locateStrings(value: unknown, pointer = "$"): LocatedString[] {
  if (typeof value === "string") return [{ path: pointer, value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => locateStrings(entry, `${pointer}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    locateStrings(entry, `${pointer}.${key.replaceAll(".", "\\.")}`),
  );
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function recoveredOrder(raw: string, markers: string[]): boolean {
  const positions = markers
    .map((marker) => raw.indexOf(marker))
    .filter((position) => position >= 0);
  return positions.every(
    (position, index) => index === 0 || position > (positions[index - 1] as number),
  );
}

function decodeBase64Candidate(value: string): Buffer | undefined {
  const dataUrlMatch = /^data:[^;,]+;base64,([A-Za-z0-9+/=_-]+)$/.exec(value);
  const candidate = dataUrlMatch?.[1] || value;
  if (
    candidate.length < 16 ||
    candidate.length % 4 === 1 ||
    !/^[A-Za-z0-9+/=_-]+$/.test(candidate)
  ) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(
      candidate,
      candidate.includes("-") || candidate.includes("_") ? "base64url" : "base64",
    );
    const normalizedInput = candidate.replaceAll("=", "");
    const normalizedRoundTrip = decoded
      .toString(candidate.includes("-") || candidate.includes("_") ? "base64url" : "base64")
      .replaceAll("=", "");
    return normalizedRoundTrip === normalizedInput ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function candidateBuffers(value: unknown): Buffer[] {
  const candidates: Buffer[] = [];
  if (typeof value === "string") {
    candidates.push(Buffer.from(value, "utf8"));
    const decoded = decodeBase64Candidate(value);
    if (decoded) candidates.push(decoded);
    return candidates;
  }
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
    ) {
      candidates.push(Buffer.from(value as number[]));
    }
    for (const entry of value) candidates.push(...candidateBuffers(entry));
    return candidates;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) candidates.push(...candidateBuffers(entry));
  }
  return candidates;
}

function scoreRun(
  manifest: AcquisitionFixtureManifest,
  record: AcquisitionRecord,
  outcomes: AcquisitionOutcome[],
): AcquisitionRunScore {
  const raw = record.received_arguments.exact_json;
  const strings = locateStrings(record.parsed_arguments);
  const markerPaths: Record<string, string[]> = {};
  for (const marker of [...manifest.expected_markers, ...manifest.negative_markers]) {
    markerPaths[marker] = strings
      .filter((entry) => entry.value.includes(marker))
      .map((entry) => entry.path);
  }
  const recoveredMarkers = manifest.expected_markers.filter((marker) => raw.includes(marker));
  const missingMarkers = manifest.expected_markers.filter((marker) => !raw.includes(marker));
  const falseMarkersReturned = manifest.negative_markers.filter((marker) => raw.includes(marker));
  const duplicateMarkers = manifest.expected_markers
    .map((marker) => ({ marker, occurrences: occurrences(raw, marker) }))
    .filter((entry) => entry.occurrences > 1);
  const markerCounts = Object.fromEntries(
    Object.entries(manifest.markers).map(([group, markers]) => [
      group,
      {
        recovered: markers.filter((marker) => raw.includes(marker)).length,
        expected: markers.length,
      },
    ]),
  ) as AcquisitionRunScore["marker_counts"];
  const hashes = new Set(
    candidateBuffers(record.parsed_arguments).map((candidate) => sha256(candidate)),
  );
  const outcomeValue = (kind: AcquisitionOutcome["kind"]): AcquisitionOutcomeValue =>
    outcomes.filter((outcome) => outcome.kind === kind).at(-1)?.value ?? "unknown";
  const providerObservedSuccess = outcomeValue("provider_observed_success");
  const additionalCallAttempted = outcomeValue("additional_call_attempted");
  const truncationObserved = outcomeValue("truncation_or_chunking_observed");
  const payloadCeilingReached = outcomeValue("payload_ceiling_reached");
  const triggerReasons = [
    ...(additionalCallAttempted === "yes" ? ["additional_call_attempted"] : []),
    ...(truncationObserved === "yes" ? ["truncation_or_chunking_observed"] : []),
    ...(payloadCeilingReached === "yes" ? ["payload_ceiling_reached"] : []),
    ...(recoveredMarkers.length < manifest.expected_markers.length
      ? ["single_call_incomplete_requires_operator_packaging_review"]
      : []),
  ];
  return {
    session_id: record.session_id,
    provider: record.run.provider,
    surface: record.run.surface,
    acquisition_leg: record.run.acquisition_leg,
    call_mode: record.run.call_mode,
    trial: record.run.trial,
    received_at: record.received_at,
    argument_sha256: record.received_arguments.sha256,
    argument_utf8_bytes: record.received_arguments.utf8_bytes,
    marker_counts: markerCounts,
    recovered_markers: recoveredMarkers,
    missing_markers: missingMarkers,
    false_markers_returned: falseMarkersReturned,
    duplicate_markers: duplicateMarkers,
    marker_coverage_percent:
      manifest.expected_markers.length === 0
        ? 0
        : Number(((recoveredMarkers.length / manifest.expected_markers.length) * 100).toFixed(2)),
    conversation_order_preserved_for_recovered_markers: recoveredOrder(
      raw,
      manifest.markers.conversations,
    ),
    message_order_preserved_for_recovered_markers: recoveredOrder(raw, manifest.markers.messages),
    marker_paths: markerPaths,
    exact_file_bytes: manifest.files.map((file) => ({
      name: file.name,
      required: file.required,
      sha256: file.sha256,
      matched: hashes.has(file.sha256),
    })),
    exact_artifact_bytes: hashes.has(manifest.artifact.sha256),
    outcomes: {
      evidence_captured: "yes",
      provider_observed_success: providerObservedSuccess,
      additional_call_attempted: additionalCallAttempted,
      truncation_or_chunking_observed: truncationObserved,
      payload_ceiling_reached: payloadCeilingReached,
    },
    bounded_multi_call_triggered: triggerReasons.length > 0,
    bounded_multi_call_trigger_reasons: triggerReasons,
  };
}

export function createScoreReport(
  manifest: AcquisitionFixtureManifest,
  records: AcquisitionRecord[],
  outcomes: AcquisitionOutcome[] = [],
  now = new Date(),
): AcquisitionScoreReport {
  const runs = records
    .filter((record) => record.run.fixture_id === manifest.fixture_id)
    .map((record) =>
      scoreRun(
        manifest,
        record,
        outcomes.filter((outcome) => outcome.session_id === record.session_id),
      ),
    )
    .sort((left, right) =>
      `${left.provider}:${left.surface}:${left.acquisition_leg}:${left.trial}`.localeCompare(
        `${right.provider}:${right.surface}:${right.acquisition_leg}:${right.trial}`,
      ),
    );
  const grouped = new Map<string, AcquisitionRunScore[]>();
  for (const run of runs) {
    const key = `${run.provider}\u0000${run.surface}\u0000${run.acquisition_leg}`;
    grouped.set(key, [...(grouped.get(key) || []), run]);
  }
  const groups = [...grouped.values()].map((groupRuns) => ({
    provider: groupRuns[0]?.provider || "",
    surface: groupRuns[0]?.surface || "",
    acquisition_leg: groupRuns[0]?.acquisition_leg || "",
    trials: groupRuns.map((run) => run.trial),
    marker_recovery_distribution: groupRuns.map((run) => run.recovered_markers.length),
    marker_coverage_distribution_percent: groupRuns.map((run) => run.marker_coverage_percent),
    false_marker_distribution: groupRuns.map((run) => run.false_markers_returned.length),
    exact_required_file_distribution: groupRuns.map(
      (run) => run.exact_file_bytes.filter((file) => file.required && file.matched).length,
    ),
  }));
  const scoredSessionIds = new Set(runs.map((run) => run.session_id));
  const outcomesWithoutEvidence = outcomes.filter(
    (outcome) => !scoredSessionIds.has(outcome.session_id),
  );
  const outcomeTriggeredSessionIds = outcomes
    .filter(
      (outcome) =>
        outcome.value === "yes" &&
        [
          "additional_call_attempted",
          "truncation_or_chunking_observed",
          "payload_ceiling_reached",
        ].includes(outcome.kind),
    )
    .map((outcome) => outcome.session_id);
  return {
    contract_version: "alice_acquisition_score_v1",
    fixture_id: manifest.fixture_id,
    generated_at: now.toISOString(),
    runs,
    groups,
    outcomes_without_evidence: outcomesWithoutEvidence,
    bounded_multi_call_trigger_session_ids: [
      ...new Set([
        ...runs.filter((run) => run.bounded_multi_call_triggered).map((run) => run.session_id),
        ...outcomeTriggeredSessionIds,
      ]),
    ].sort(),
    manual_review_required: [
      "Confirm message roles, identifiers, timestamps, and project/conversation/file relationships from the recorded JSON paths.",
      "Distinguish provider-supplied metadata from model-authored labels or reconstructions.",
      "Record every user and host action, warning, truncation, transformation, and failure observed during the run.",
      "Treat an exact hash match as original bytes only when the matching value was actually supplied in the tool arguments.",
      "For every incomplete single-call run, decide whether the gap could reflect packaging; if yes, bounded multi-call testing is required before an acquisition-path conclusion.",
    ],
  };
}

export async function readFixtureManifest(filePath: string): Promise<AcquisitionFixtureManifest> {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8")) as AcquisitionFixtureManifest;
}

export function scoreReportMarkdown(report: AcquisitionScoreReport): string {
  const lines = [
    `# Provider acquisition score — ${report.fixture_id}`,
    "",
    `Generated: ${report.generated_at}`,
    "",
  ];
  for (const run of report.runs) {
    const requiredFiles = run.exact_file_bytes.filter((file) => file.required);
    lines.push(
      `## ${run.provider} ${run.surface} — ${run.acquisition_leg} — run ${run.trial}`,
      "",
      `- Conversations recovered: ${run.marker_counts.conversations.recovered}/${run.marker_counts.conversations.expected}`,
      `- Messages recovered: ${run.marker_counts.messages.recovered}/${run.marker_counts.messages.expected}`,
      `- Files identified by exact marker: ${run.marker_counts.files.recovered}/${run.marker_counts.files.expected}`,
      `- Required file bytes matched: ${requiredFiles.filter((file) => file.matched).length}/${requiredFiles.length}`,
      `- Marker coverage: ${run.marker_coverage_percent}%`,
      `- False markers returned: ${run.false_markers_returned.length}`,
      `- Provider observed success: ${run.outcomes.provider_observed_success}`,
      `- Additional call attempted: ${run.outcomes.additional_call_attempted}`,
      `- Truncation or chunking observed: ${run.outcomes.truncation_or_chunking_observed}`,
      `- Bounded multi-call trigger: ${run.bounded_multi_call_triggered ? "yes" : "no"}`,
      `- Recovered conversation-marker order preserved: ${run.conversation_order_preserved_for_recovered_markers ? "yes" : "no"}`,
      `- Recovered message-marker order preserved: ${run.message_order_preserved_for_recovered_markers ? "yes" : "no"}`,
      "",
    );
  }
  if (report.outcomes_without_evidence.length > 0) {
    lines.push(
      "## Outcomes without captured evidence",
      "",
      ...report.outcomes_without_evidence.map(
        (outcome) =>
          `- ${outcome.session_id}: ${outcome.kind}=${outcome.value} (${outcome.detail_code})`,
      ),
      "",
    );
  }
  for (const group of report.groups) {
    lines.push(
      `## Reliability — ${group.provider} ${group.surface} — ${group.acquisition_leg}`,
      "",
      `- Trials: ${group.trials.join(", ")}`,
      `- Marker recovery distribution: ${group.marker_recovery_distribution.join(", ")}`,
      `- Marker coverage distribution: ${group.marker_coverage_distribution_percent.map((value) => `${value}%`).join(", ")}`,
      `- False-marker distribution: ${group.false_marker_distribution.join(", ")}`,
      `- Exact required-file distribution: ${group.exact_required_file_distribution.join(", ")}`,
      "",
    );
  }
  lines.push(
    "## Manual review required",
    "",
    ...report.manual_review_required.map((item) => `- ${item}`),
    "",
  );
  return lines.join("\n");
}
