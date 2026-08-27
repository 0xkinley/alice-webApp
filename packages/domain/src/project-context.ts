import { createHash } from "node:crypto";

// Trusted context is assembled only from human-accepted state.

function workspaceIdForUser(database, userId) {
  return database.prepare("SELECT id FROM workspaces WHERE user_id = ?").get(userId)?.id;
}

function parseJson(value) {
  return JSON.parse(value);
}

function approximateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function listProjects(database, userId) {
  return database
    .prepare(
      `SELECT id, name, brief, created_at
       FROM projects
       WHERE workspace_id = ?
       ORDER BY name`,
    )
    .all(workspaceIdForUser(database, userId));
}

export function getProjectContext(database, { userId, projectId, task, contextBudget }) {
  const workspaceId = workspaceIdForUser(database, userId);
  const project = database
    .prepare(
      `SELECT id, name, brief, created_at
       FROM projects
       WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, workspaceId);
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
         accepted.evidence_id
       FROM accepted_project_state accepted
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
    .all(projectId, workspaceId);

  const decisions = rows.map((row) => ({
    accepted_state_id: row.accepted_state_id,
    state_key: row.state_key,
    value: parseJson(row.value_json),
    version: row.version,
    accepted_at: row.accepted_at,
    provenance: {
      candidate_id: row.candidate_id,
      evidence_id: row.evidence_id,
    },
  }));

  const acceptedDecisions: typeof decisions = [];
  let usedTokens = approximateTokens({ project, task });
  for (const decision of decisions) {
    const decisionTokens = approximateTokens(decision);
    if (usedTokens + decisionTokens > contextBudget) continue;
    acceptedDecisions.push(decision);
    usedTokens += decisionTokens;
  }
  const generatedAt = new Date().toISOString();
  const packageHash = createHash("sha256")
    .update(JSON.stringify({ projectId, task, acceptedDecisions }))
    .digest("hex");

  return {
    project,
    task,
    accepted_decisions: acceptedDecisions,
    open_questions: [],
    artifacts: [],
    package: {
      version: packageHash,
      generated_at: generatedAt,
      approximate_tokens: usedTokens,
      budget: contextBudget,
      omission_count: decisions.length - acceptedDecisions.length,
    },
  };
}
