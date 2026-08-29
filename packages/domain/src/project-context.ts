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

  const taskTerms = normalizedTerms(task);
  const decisions = rows
    .map((row) => ({
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
      },
      relevance: relevanceScore(row, taskTerms),
    }))
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        compareText(left.item.state_key, right.item.state_key) ||
        compareText(
          left.item.provenance.accepted_state_id,
          right.item.provenance.accepted_state_id,
        ),
    )
    .map(({ item }) => item);

  const acceptedDecisions: typeof decisions = [];
  let usedBytes = serializedBytes({ project, task });
  for (const decision of decisions) {
    const decisionBytes = serializedBytes(decision);
    if (usedBytes + decisionBytes > contextBudget) continue;
    acceptedDecisions.push(decision);
    usedBytes += decisionBytes;
  }
  const acceptedStateAsOf = latestTimestamp(rows.map((row) => row.accepted_at));
  const evidenceAsOf = latestTimestamp(rows.map((row) => row.evidence_captured_at));
  const packageHash = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: consumptionContractVersion,
        project,
        task,
        contextBudget,
        acceptedDecisions,
      }),
    )
    .digest("hex");

  const context = {
    contract_version: consumptionContractVersion,
    project,
    task,
    accepted_decisions: acceptedDecisions,
    open_questions: [],
    artifacts: [],
    unresolved_conflicts: [],
    package: {
      version: `context_${packageHash}`,
      selection_strategy: "deterministic_full_text_v1",
      freshness: {
        project_updated_at: project.updated_at,
        accepted_state_as_of: acceptedStateAsOf,
        evidence_as_of: evidenceAsOf,
        state_as_of:
          latestTimestamp([project.updated_at, acceptedStateAsOf, evidenceAsOf]) ||
          project.updated_at,
      },
      budget: { unit: "utf8_bytes", limit: contextBudget, used: 0 },
      omissions: {
        total: decisions.length - acceptedDecisions.length,
        accepted_decisions: decisions.length - acceptedDecisions.length,
        open_questions: 0,
        artifacts: 0,
        unresolved_conflicts: 0,
        reason: decisions.length === acceptedDecisions.length ? "none" : "budget_exhausted",
      },
    },
  };
  return updateBudgetUsed(context);
}
