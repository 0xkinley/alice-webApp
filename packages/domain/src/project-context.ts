import { createHash } from "node:crypto";
import { consumptionContractVersion } from "@alice/schemas";
import { tenantScopeForUser } from "./authorization.ts";

// Trusted context is assembled only from human-accepted state.

function parseJson(value) {
  return JSON.parse(value);
}

function normalizedTerms(value) {
  return [
    ...new Set(
      String(value)
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ].sort();
}

function relevanceScore(row, taskTerms) {
  const stateKeyTerms = new Set(normalizedTerms(row.state_key));
  const summaryTerms = new Set(normalizedTerms(row.summary));
  const valueTerms = new Set(normalizedTerms(row.value_json));
  return taskTerms.reduce(
    (score, term) =>
      score +
      (stateKeyTerms.has(term) ? 8 : 0) +
      (summaryTerms.has(term) ? 4 : 0) +
      (valueTerms.has(term) ? 2 : 0),
    0,
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function categoryForStateKey(stateKey) {
  if (/^(?:question|questions|open_question|open_questions)[._-]/.test(stateKey)) {
    return "open_questions";
  }
  if (/^(?:artifact|artifacts)[._-]/.test(stateKey)) return "artifacts";
  return "accepted_decisions";
}

const categoryPriority = Object.freeze({
  accepted_decisions: 0,
  unresolved_conflicts: 1,
  open_questions: 2,
  artifacts: 3,
});

function compareRankedEntries(left, right) {
  return (
    right.relevance - left.relevance ||
    categoryPriority[left.category] - categoryPriority[right.category] ||
    compareText(left.item.state_key, right.item.state_key) ||
    compareText(left.stableId, right.stableId)
  );
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function latestTimestamp(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function updateBudgetUsed(context) {
  let previous = -1;
  while (previous !== context.package.budget.used) {
    previous = context.package.budget.used;
    context.package.budget.used = serializedBytes(context);
  }
  return context;
}

function omissionCounts(availableCounts, selected) {
  const counts = Object.fromEntries(
    Object.entries(availableCounts).map(([category, available]) => [
      category,
      Number(available) - selected[category].length,
    ]),
  );
  return {
    total: Object.values(counts).reduce((total, count) => total + count, 0),
    ...counts,
  };
}

function buildContext({
  project,
  task,
  selected,
  freshness,
  contextBudget,
  availableCounts,
  version,
}) {
  const omissions = omissionCounts(availableCounts, selected);
  return updateBudgetUsed({
    contract_version: consumptionContractVersion,
    project,
    task,
    ...selected,
    package: {
      version,
      selection_strategy: "deterministic_full_text_v1",
      freshness,
      budget: { unit: "utf8_bytes", limit: contextBudget, used: 0 },
      omissions: {
        ...omissions,
        reason: omissions.total === 0 ? "none" : "budget_exhausted",
      },
    },
  });
}

export class ContextBudgetError extends Error {}

export function listProjects(database, userId) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return [];
  return database
    .prepare(
      `SELECT project.id, project.name, project.brief, project.created_at, project.updated_at,
              COUNT(accepted.id) AS accepted_state_count,
              MAX(accepted.accepted_at) AS accepted_state_updated_at
       FROM projects project
       LEFT JOIN accepted_project_state accepted
         ON accepted.workspace_id = project.workspace_id
        AND accepted.project_id = project.id
        AND NOT EXISTS (
          SELECT 1 FROM accepted_project_state newer
          WHERE newer.workspace_id = accepted.workspace_id
            AND newer.project_id = accepted.project_id
            AND newer.state_key = accepted.state_key
            AND newer.version > accepted.version
        )
       WHERE project.workspace_id = ?
       GROUP BY project.id, project.name, project.brief, project.created_at, project.updated_at
       ORDER BY project.name, project.id`,
    )
    .all(tenant.workspaceId);
}

export function getProjectContext(database, { userId, projectId, task, contextBudget }) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const project = database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects
       WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, tenant.workspaceId);
  if (!project) return undefined;

  const rows = database
    .prepare(
      `SELECT
         accepted.id AS accepted_state_id,
         accepted.state_key,
         accepted.value_json,
         accepted.version,
         accepted.accepted_at,
         accepted.candidate_id,
         accepted.evidence_id,
         candidate.summary,
         evidence.payload_hash AS evidence_payload_hash,
         evidence.created_at AS evidence_captured_at
       FROM accepted_project_state accepted
       JOIN candidate_claims candidate
         ON candidate.workspace_id = accepted.workspace_id
        AND candidate.project_id = accepted.project_id
        AND candidate.id = accepted.candidate_id
        AND candidate.evidence_id = accepted.evidence_id
       JOIN evidence_events evidence
         ON evidence.workspace_id = accepted.workspace_id
        AND evidence.project_id = accepted.project_id
        AND evidence.id = accepted.evidence_id
       WHERE accepted.project_id = ?
         AND accepted.workspace_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM accepted_project_state newer
           WHERE newer.project_id = accepted.project_id
             AND newer.state_key = accepted.state_key
             AND newer.version > accepted.version
         )
       ORDER BY accepted.state_key`,
    )
    .all(projectId, tenant.workspaceId);

  const conflictRows = database
    .prepare(
      `SELECT
         accepted.id AS accepted_state_id,
         accepted.state_key,
         accepted.value_json,
         accepted.version,
         accepted.accepted_at,
         accepted.candidate_id AS accepted_candidate_id,
         accepted.evidence_id AS accepted_evidence_id,
         accepted_candidate.summary,
         accepted_evidence.payload_hash AS accepted_evidence_payload_hash,
         accepted_evidence.created_at AS accepted_evidence_captured_at,
         alternative.id AS alternative_candidate_id,
         alternative.evidence_id AS alternative_evidence_id,
         alternative_evidence.payload_hash AS alternative_evidence_payload_hash,
         alternative_evidence.created_at AS alternative_evidence_captured_at
       FROM candidate_claims alternative
       JOIN accepted_project_state accepted
         ON accepted.workspace_id = alternative.workspace_id
        AND accepted.project_id = alternative.project_id
        AND accepted.state_key = alternative.state_key
        AND NOT EXISTS (
          SELECT 1 FROM accepted_project_state newer
          WHERE newer.workspace_id = accepted.workspace_id
            AND newer.project_id = accepted.project_id
            AND newer.state_key = accepted.state_key
            AND newer.version > accepted.version
        )
       JOIN candidate_claims accepted_candidate
         ON accepted_candidate.workspace_id = accepted.workspace_id
        AND accepted_candidate.project_id = accepted.project_id
        AND accepted_candidate.id = accepted.candidate_id
        AND accepted_candidate.evidence_id = accepted.evidence_id
       JOIN evidence_events accepted_evidence
         ON accepted_evidence.workspace_id = accepted.workspace_id
        AND accepted_evidence.project_id = accepted.project_id
        AND accepted_evidence.id = accepted.evidence_id
       JOIN evidence_events alternative_evidence
         ON alternative_evidence.workspace_id = alternative.workspace_id
        AND alternative_evidence.project_id = alternative.project_id
        AND alternative_evidence.id = alternative.evidence_id
       WHERE alternative.workspace_id = ?
         AND alternative.project_id = ?
         AND alternative.status = 'pending'
         AND alternative.value_json <> accepted.value_json
       ORDER BY accepted.state_key, alternative.id`,
    )
    .all(tenant.workspaceId, projectId);

  const taskTerms = normalizedTerms(task);
  const rankedAccepted = rows.map((row) => {
    const category = categoryForStateKey(row.state_key);
    return {
      category,
      item: {
        state_key: row.state_key,
        summary: row.summary,
        value: parseJson(row.value_json),
        version: row.version,
        accepted_at: row.accepted_at,
        provenance: {
          accepted_state_id: row.accepted_state_id,
          candidate_id: row.candidate_id,
          evidence_id: row.evidence_id,
          evidence_payload_hash: row.evidence_payload_hash,
          evidence_captured_at: row.evidence_captured_at,
        },
        ...(category === "open_questions" ? { status: "open" } : {}),
        ...(category === "artifacts" ? { handling: "reference_only" } : {}),
      },
      relevance: relevanceScore(row, taskTerms),
      stableId: row.accepted_state_id,
    };
  });

  const conflictsByStateKey = new Map();
  for (const row of conflictRows) {
    let conflict = conflictsByStateKey.get(row.state_key);
    if (!conflict) {
      conflict = {
        category: "unresolved_conflicts",
        item: {
          state_key: row.state_key,
          status: "unresolved",
          trusted_current: {
            version: row.version,
            provenance: {
              accepted_state_id: row.accepted_state_id,
              candidate_id: row.accepted_candidate_id,
              evidence_id: row.accepted_evidence_id,
              evidence_payload_hash: row.accepted_evidence_payload_hash,
              evidence_captured_at: row.accepted_evidence_captured_at,
            },
          },
          unreviewed_alternatives: [],
          notice:
            "Pending alternatives exist for this accepted state key. Their values are excluded and are not alice.-verified.",
        },
        relevance: relevanceScore(row, taskTerms),
        stableId: row.accepted_state_id,
      };
      conflictsByStateKey.set(row.state_key, conflict);
    }
    conflict.item.unreviewed_alternatives.push({
      candidate_id: row.alternative_candidate_id,
      evidence_id: row.alternative_evidence_id,
      evidence_payload_hash: row.alternative_evidence_payload_hash,
      evidence_captured_at: row.alternative_evidence_captured_at,
      review_status: "pending",
    });
  }

  const rankedEntries = [...rankedAccepted, ...conflictsByStateKey.values()].sort(
    compareRankedEntries,
  );
  const selected = {
    accepted_decisions: [],
    open_questions: [],
    artifacts: [],
    unresolved_conflicts: [],
  };
  const acceptedStateAsOf = latestTimestamp(rows.map((row) => row.accepted_at));
  const evidenceAsOf = latestTimestamp([
    ...rows.map((row) => row.evidence_captured_at),
    ...conflictRows.map((row) => row.alternative_evidence_captured_at),
  ]);
  const freshness = {
    project_updated_at: project.updated_at,
    accepted_state_as_of: acceptedStateAsOf,
    evidence_as_of: evidenceAsOf,
    state_as_of:
      latestTimestamp([project.updated_at, acceptedStateAsOf, evidenceAsOf]) || project.updated_at,
  };
  const availableCounts = {
    accepted_decisions: rankedAccepted.filter((entry) => entry.category === "accepted_decisions")
      .length,
    open_questions: rankedAccepted.filter((entry) => entry.category === "open_questions").length,
    artifacts: rankedAccepted.filter((entry) => entry.category === "artifacts").length,
    unresolved_conflicts: conflictsByStateKey.size,
  };

  const placeholderVersion = `context_${"0".repeat(64)}`;
  const emptyContext = buildContext({
    project,
    task,
    selected,
    freshness,
    contextBudget,
    availableCounts,
    version: placeholderVersion,
  });
  if (emptyContext.package.budget.used > contextBudget) {
    throw new ContextBudgetError(
      "The requested context budget is too small for the required package envelope.",
    );
  }

  for (const entry of rankedEntries) {
    const attempted = {
      ...selected,
      [entry.category]: [...selected[entry.category], entry.item],
    };
    const attemptedContext = buildContext({
      project,
      task,
      selected: attempted,
      freshness,
      contextBudget,
      availableCounts,
      version: placeholderVersion,
    });
    if (attemptedContext.package.budget.used <= contextBudget) {
      selected[entry.category] = attempted[entry.category];
    }
  }

  const omissions = omissionCounts(availableCounts, selected);
  const sourceInventory = {
    accepted_state: rows.map((row) => ({
      accepted_state_id: row.accepted_state_id,
      state_key: row.state_key,
      value_json: row.value_json,
      version: row.version,
      accepted_at: row.accepted_at,
      candidate_id: row.candidate_id,
      evidence_id: row.evidence_id,
      evidence_payload_hash: row.evidence_payload_hash,
      evidence_captured_at: row.evidence_captured_at,
    })),
    pending_conflict_alternatives: conflictRows.map((row) => ({
      candidate_id: row.alternative_candidate_id,
      evidence_id: row.alternative_evidence_id,
      evidence_payload_hash: row.alternative_evidence_payload_hash,
      evidence_captured_at: row.alternative_evidence_captured_at,
    })),
  };
  const packageHash = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: consumptionContractVersion,
        project,
        task,
        contextBudget,
        selected,
        freshness,
        omissions,
        sourceInventory,
      }),
    )
    .digest("hex");

  return buildContext({
    project,
    task,
    selected,
    freshness,
    contextBudget,
    availableCounts,
    version: `context_${packageHash}`,
  });
}
