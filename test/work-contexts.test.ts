import assert from "node:assert/strict";
import { test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  acceptCandidate,
  createWorkContext,
  getProjectContext,
  getWorkContextHistory,
  listWorkContexts,
  saveCandidateUpdate,
  suggestSimilarWorkContexts,
} from "@alice/domain";
import { createTestIdentity } from "./helpers.ts";

test("projects have durable project-wide and selectable default work contexts", async () => {
  const database = openSqliteTestDatabase();
  const owner = await createTestIdentity(database);
  const contexts = await listWorkContexts(database, owner.id, owner.project_id);
  assert.deepEqual(
    contexts.map(({ name, context_kind: kind }) => [name, kind]),
    [
      ["Project-wide", "project_wide"],
      ["General", "work"],
    ],
  );

  const created = await createWorkContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input: { name: "Launch planning", description: "Plan launch positioning and rollout." },
  });
  assert.equal(created.context_kind, "work");
  const history = await getWorkContextHistory(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: created.id,
  });
  assert.deepEqual(
    history.map(({ action }) => action),
    ["context_created"],
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE context_history_events SET action = 'rewritten' WHERE context_id = ?")
        .run(created.id),
    /append-only/,
  );
  database.close();
});

test("similarity suggestions are deterministic and never create or group a context", async () => {
  const database = openSqliteTestDatabase();
  const owner = await createTestIdentity(database);
  const launch = await createWorkContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input: { name: "Launch planning", description: "Positioning, rollout, and launch copy." },
  });
  const input = { name: "Launch plan", description: "Prepare rollout positioning." };
  const first = await suggestSimilarWorkContexts(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input,
  });
  const second = await suggestSimilarWorkContexts(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input,
  });
  assert.deepEqual(second, first);
  assert.equal(first[0].id, launch.id);
  assert.ok(first[0].similarity_score > 0);
  assert.equal((await listWorkContexts(database, owner.id, owner.project_id)).length, 3);

  const other = await createTestIdentity(database, {
    email: "context-outsider@alice.example",
    projectId: "project_context_outsider",
  });
  assert.equal(await listWorkContexts(database, other.id, owner.project_id), undefined);
  assert.equal(
    await suggestSimilarWorkContexts(database, {
      userId: other.id,
      projectId: owner.project_id,
      input,
    }),
    undefined,
  );
  database.close();
});

test("candidate and accepted entries retain an immutable context destination", async () => {
  const database = openSqliteTestDatabase();
  const owner = await createTestIdentity(database);
  const launch = await createWorkContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input: { name: "Launch", description: "Launch decisions." },
    providerAvailability: { chatgpt: true, claude: false },
  });
  const pricing = await createWorkContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input: { name: "Pricing", description: "Pricing decisions." },
    providerAvailability: { chatgpt: true, claude: false },
  });
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('context-client', 'Context client', '[]', 'none', ?)`,
    )
    .run(now);
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('context-connection', ?, ?, 'context-client', 'chatgpt',
               'mcp:read mcp:write', ?, ?)`,
    )
    .run(owner.id, owner.workspace_id, now, now);

  async function saveAndAccept(contextId, idempotencyKey, value) {
    const receipt = await saveCandidateUpdate(database, {
      clientId: "context-client",
      connectionId: "context-connection",
      publicUrl: "https://app.alice.example",
      userId: owner.id,
      payload: {
        project_id: owner.project_id,
        context_id: contextId,
        summary: "Context-scoped candidate",
        candidate_claims: [{ state_key: "launch.price", value, summary: "Context-scoped price" }],
        idempotency_key: idempotencyKey,
      },
    });
    const accepted = await acceptCandidate(database, {
      candidateId: receipt.candidate_ids[0],
      userId: owner.id,
    });
    return { accepted, receipt };
  }

  const first = await saveAndAccept(launch.id, "context-launch-price", 24);
  const second = await saveAndAccept(pricing.id, "context-pricing-price", 29);
  assert.equal(first.receipt.context_id, launch.id);
  assert.equal(first.accepted.contextId, launch.id);
  assert.equal(second.accepted.contextId, pricing.id);
  assert.deepEqual(
    database
      .prepare(
        `SELECT context_id FROM accepted_context_entries
         WHERE accepted_state_id IN (?, ?) ORDER BY context_id`,
      )
      .all(first.accepted.acceptedStateId, second.accepted.acceptedStateId)
      .map(({ context_id: contextId }) => contextId),
    [launch.id, pricing.id].sort(),
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE candidate_context_targets SET context_id = ? WHERE candidate_id = ?")
        .run(pricing.id, first.receipt.candidate_ids[0]),
    /immutable/,
  );
  const launchContext = await getProjectContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: launch.id,
    task: "Check the launch price",
    contextBudget: 4_000,
  });
  const pricingContext = await getProjectContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: pricing.id,
    task: "Check the pricing decision",
    contextBudget: 4_000,
  });
  assert.equal(launchContext.accepted_decisions[0].value, 24);
  assert.equal(pricingContext.accepted_decisions[0].value, 29);
  assert.deepEqual(
    launchContext.accepted_decisions.map(({ value }) => value),
    [24],
  );
  assert.deepEqual(
    pricingContext.accepted_decisions.map(({ value }) => value),
    [29],
  );
  database.close();
});
