import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "@alice/database";
import { getProjectContext, registerUser } from "@alice/domain";

const fixturePath = resolve(import.meta.dirname, "../evals/cross-host-context.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const timestamp = "2026-08-30T10:00:00.000Z";

function seedCase(evaluationCase) {
  const database = openDatabase(":memory:");
  const identity = registerUser(database, {
    email: `${evaluationCase.host}@context-eval.alice.example`,
    password: "context evaluation fixture password",
  });
  database
    .prepare(
      `INSERT INTO projects (id, workspace_id, name, brief, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.project.id,
      identity.workspace_id,
      fixture.project.name,
      fixture.project.brief,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('evaluation-client', ?, '[]', 'none', ?)`,
    )
    .run(`${evaluationCase.host} context evaluation`, timestamp);
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('evaluation-connection', ?, ?, 'evaluation-client', ?, 'mcp:read mcp:write', ?, ?)`,
    )
    .run(identity.id, identity.workspace_id, evaluationCase.host, timestamp, timestamp);

  const acceptedIds = new Set(evaluationCase.accepted_ids);
  for (const decision of fixture.accepted_state) {
    if (!acceptedIds.has(decision.id)) continue;
    const evidenceId = `evidence_${decision.id}`;
    const candidateId = `candidate_${decision.id}`;
    database
      .prepare(
        `INSERT INTO evidence_events
          (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
           client_id, client_classification, tool_name, idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, ?, 'mcp_host', 'evaluation-connection', 'evaluation-client', ?,
                 'save_project_update', ?, ?, ?)`,
      )
      .run(
        evidenceId,
        identity.workspace_id,
        fixture.project.id,
        JSON.stringify({ fixture_decision: decision.id, value: decision.value }),
        evaluationCase.host,
        `accepted-${decision.id}`,
        `payload-hash-${decision.id}`,
        timestamp,
      );
    database
      .prepare(
        `INSERT INTO candidate_claims
          (id, workspace_id, project_id, evidence_id, state_key, value_json, summary,
           status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
      )
      .run(
        candidateId,
        identity.workspace_id,
        fixture.project.id,
        evidenceId,
        decision.state_key,
        JSON.stringify(decision.value),
        `Canonical decision ${decision.id}`,
        timestamp,
      );
    database
      .prepare(
        `INSERT INTO accepted_project_state
          (id, workspace_id, project_id, candidate_id, evidence_id, state_key,
           value_json, version, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        `accepted_${decision.id}`,
        identity.workspace_id,
        fixture.project.id,
        candidateId,
        evidenceId,
        decision.state_key,
        JSON.stringify(decision.value),
        timestamp,
      );
  }

  for (const pending of fixture.pending_candidates) {
    const evidenceId = `evidence_${pending.id}`;
    database
      .prepare(
        `INSERT INTO evidence_events
          (id, workspace_id, project_id, exact_payload_json, actor_type, connection_id,
           client_id, client_classification, tool_name, idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, ?, 'mcp_host', 'evaluation-connection', 'evaluation-client', ?,
                 'save_project_update', ?, ?, ?)`,
      )
      .run(
        evidenceId,
        identity.workspace_id,
        fixture.project.id,
        JSON.stringify({ fixture_pending: pending.id, value: pending.value }),
        evaluationCase.host,
        pending.id,
        `payload-hash-${pending.id}`,
        timestamp,
      );
    database
      .prepare(
        `INSERT INTO candidate_claims
          (id, workspace_id, project_id, evidence_id, state_key, value_json, summary,
           status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        `candidate_${pending.id}`,
        identity.workspace_id,
        fixture.project.id,
        evidenceId,
        pending.state_key,
        JSON.stringify(pending.value),
        `Retained failed-run candidate ${pending.id}`,
        timestamp,
      );
  }

  return { database, identity };
}

function scoreCase(evaluationCase) {
  const failures = [];
  const { database, identity } = seedCase(evaluationCase);
  const request = {
    userId: identity.id,
    projectId: fixture.project.id,
    task: evaluationCase.prompt,
    contextBudget: 16_000,
  };
  const context = getProjectContext(database, request);
  const repeated = getProjectContext(database, request);
  const acceptedByKey = new Map(
    context.accepted_decisions.map((decision) => [decision.state_key, decision]),
  );

  if (evaluationCase.manually_restated_decision_ids.length !== 0) {
    failures.push("The continuation prompt manually restated canonical decisions.");
  }
  if (
    evaluationCase.alice_tool_calls[0] !== "list_projects" ||
    evaluationCase.alice_tool_calls[1] !== "get_project_context"
  ) {
    failures.push("The host did not discover the project and retrieve context first.");
  }
  if (JSON.stringify(context) !== JSON.stringify(repeated)) {
    failures.push("Repeated context assembly was not deterministic.");
  }
  if (context.package.budget.used > context.package.budget.limit) {
    failures.push("The context package exceeded its declared budget.");
  }
  if (context.package.omissions.total !== 0) {
    failures.push("The canonical context package omitted required fixture state.");
  }

  for (const stateKey of evaluationCase.required_state_keys) {
    const accepted = acceptedByKey.get(stateKey);
    if (!accepted) {
      failures.push(`Required accepted state was missing: ${stateKey}.`);
      continue;
    }
    const used = evaluationCase.response.used_project_state[stateKey];
    try {
      assert.deepEqual(used, accepted.value);
    } catch {
      failures.push(`The host response did not use the accepted value for ${stateKey}.`);
    }
    if (
      !accepted.provenance.accepted_state_id ||
      !accepted.provenance.candidate_id ||
      !accepted.provenance.evidence_id ||
      !accepted.provenance.evidence_payload_hash
    ) {
      failures.push(`Accepted provenance was incomplete for ${stateKey}.`);
    }
  }

  const serializedContext = JSON.stringify(context);
  for (const pending of fixture.pending_candidates) {
    if (serializedContext.includes(pending.value)) {
      failures.push(`Pending candidate value leaked into context: ${pending.id}.`);
    }
  }

  return failures;
}

const structuralErrors = [];
if (!fixture.version || fixture.canonical_fixture !== "docs/spike/round-trip-fixture.md") {
  structuralErrors.push("The cross-host evaluation must version and name the canonical fixture.");
}
if (fixture.cases.length !== 2) {
  structuralErrors.push("The cross-host evaluation must contain exactly two target-host cases.");
}
if (new Set(fixture.cases.map(({ host }) => host)).size !== 2) {
  structuralErrors.push("The cross-host evaluation must cover distinct ChatGPT and Claude cases.");
}

const results = fixture.cases.map((evaluationCase) => ({
  host: evaluationCase.host,
  id: evaluationCase.id,
  failures: scoreCase(evaluationCase),
}));
const failed = results.filter(({ failures }) => failures.length > 0);
if (structuralErrors.length > 0 || failed.length > 0) {
  for (const error of structuralErrors) console.error(`Fixture error: ${error}`);
  for (const result of failed) {
    console.error(`${result.id}: ${result.failures.join(" ")}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Cross-host context evaluation passed: ${results.length}/${results.length} canonical continuation traces (Claude A-C, ChatGPT A-D) used accepted state without manual restatement.`,
  );
}
