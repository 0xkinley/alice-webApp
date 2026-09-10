import assert from "node:assert/strict";
import { test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  confirmCapturedUpdate,
  getCapturePreview,
  getPrivateAlphaSignals,
  getRemovalPreview,
  removeSavedContextEntry,
  saveCandidateUpdate,
} from "@alice/domain";
import { createTestIdentity, getProjectDefaultContext } from "./helpers.ts";

test("private-alpha signals aggregate workflow metadata without reading project content", async () => {
  const database = openSqliteTestDatabase();
  const owner = await createTestIdentity(database, {
    email: "signals-owner@alice.example",
    projectId: "project_signals",
  });
  const other = await createTestIdentity(database, {
    email: "signals-other@alice.example",
    projectId: "project_signals_other",
  });
  const context = await getProjectDefaultContext(database, owner.project_id);
  const clients = [
    ["signals-chatgpt-client", "ChatGPT test", "chatgpt", "signals-chatgpt-connection"],
    ["signals-claude-client", "Claude test", "claude", "signals-claude-connection"],
  ];
  for (const [clientId, clientName, classification, connectionId] of clients) {
    database
      .prepare(
        `INSERT INTO oauth_clients
          (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
         VALUES (?, ?, '[]', 'none', '2026-08-01T00:00:00.000Z')`,
      )
      .run(clientId, clientName);
    database
      .prepare(
        `INSERT INTO integration_connections
          (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
           first_connected_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, 'mcp:read mcp:write',
                 '2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
      )
      .run(connectionId, owner.id, owner.workspace_id, clientId, classification);
  }
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('signals-other-client', 'Foreign secret host', '[]', 'none',
               '2026-08-01T00:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('signals-other-connection', ?, ?, 'signals-other-client', 'foreign-secret',
               'mcp:read', '2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    )
    .run(other.id, other.workspace_id);
  database
    .prepare(
      `INSERT INTO context_read_events
        (id, user_id, connection_workspace_id, connection_id, client_id, client_name,
         client_classification, requested_via, status, failure_code, created_at)
       VALUES ('read_signals_foreign', ?, ?, 'signals-other-connection',
               'signals-other-client', 'Foreign secret host', 'foreign-secret', 'active_target',
               'failed', 'no_active_target', '2026-08-13T10:00:00.000Z')`,
    )
    .run(other.id, other.workspace_id);

  for (const [id, connectionId, clientId, clientName, classification, createdAt] of [
    [
      "read_signals_chatgpt",
      "signals-chatgpt-connection",
      "signals-chatgpt-client",
      "ChatGPT test",
      "chatgpt",
      "2026-08-03T10:00:00.000Z",
    ],
    [
      "read_signals_claude",
      "signals-claude-connection",
      "signals-claude-client",
      "Claude test",
      "claude",
      "2026-08-05T10:00:00.000Z",
    ],
    [
      "read_signals_second_week",
      "signals-chatgpt-connection",
      "signals-chatgpt-client",
      "ChatGPT test",
      "chatgpt",
      "2026-08-12T10:00:00.000Z",
    ],
  ]) {
    database
      .prepare(
        `INSERT INTO context_read_events
          (id, user_id, connection_workspace_id, connection_id, client_id, client_name,
           client_classification, requested_via, status, project_workspace_id, project_id,
           context_id, package_version, package_utf8_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active_target', 'succeeded', ?, ?, ?,
                 'signals-package', 4096, ?)`,
      )
      .run(
        id,
        owner.id,
        owner.workspace_id,
        connectionId,
        clientId,
        clientName,
        classification,
        owner.workspace_id,
        owner.project_id,
        context.id,
        createdAt,
      );
  }
  database
    .prepare(
      `INSERT INTO context_read_events
        (id, user_id, connection_workspace_id, connection_id, client_id, client_name,
         client_classification, requested_via, status, failure_code, created_at)
       VALUES ('read_signals_failed', ?, ?, 'signals-chatgpt-connection',
               'signals-chatgpt-client', 'ChatGPT test', 'chatgpt', 'active_target',
               'failed', 'no_active_target', '2026-08-13T10:00:00.000Z')`,
    )
    .run(owner.id, owner.workspace_id);

  const confirmedOffer = await saveCandidateUpdate(database, {
    clientId: "signals-chatgpt-client",
    connectionId: "signals-chatgpt-connection",
    publicUrl: "https://app.alice.example",
    userId: owner.id,
    payload: {
      project_id: owner.project_id,
      context_id: context.id,
      summary: "SECRET CONFIRMED OFFER",
      candidate_claims: [
        {
          state_key: "signals.first",
          value: "SECRET CONFIRMED VALUE ONE",
          summary: "Secret one",
        },
        {
          state_key: "signals.second",
          value: "SECRET CONFIRMED VALUE TWO",
          summary: "Secret two",
        },
      ],
      idempotency_key: "signals-confirmed-offer",
    },
  });
  const confirmedPreview = await getCapturePreview(database, {
    evidenceId: confirmedOffer.evidence_id,
    userId: owner.id,
  });
  const confirmation = await confirmCapturedUpdate(database, {
    evidenceId: confirmedOffer.evidence_id,
    expectedPreviewVersion: confirmedPreview.preview_version,
    userId: owner.id,
  });
  const pendingOffer = await saveCandidateUpdate(database, {
    clientId: "signals-claude-client",
    connectionId: "signals-claude-connection",
    publicUrl: "https://app.alice.example",
    userId: owner.id,
    payload: {
      project_id: owner.project_id,
      context_id: context.id,
      summary: "SECRET PENDING OFFER",
      candidate_claims: [
        {
          state_key: "signals.pending",
          value: "SECRET PENDING VALUE",
          summary: "Pending secret",
        },
      ],
      idempotency_key: "signals-pending-offer",
    },
  });
  assert.ok(pendingOffer.evidence_id);

  const repairTarget = confirmation.accepted[0];
  const removalPreview = await getRemovalPreview(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: context.id,
    acceptedStateId: repairTarget.acceptedStateId,
  });
  await removeSavedContextEntry(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: context.id,
    acceptedStateId: repairTarget.acceptedStateId,
    expectedPreviewVersion: removalPreview.preview_version,
    reason: "Stale — signals fixture",
    repairType: "stale",
  });

  const signals = await getPrivateAlphaSignals(database, owner.id);
  assert.deepEqual(signals.consumption, {
    observed_attempts: 4,
    successful_reads: 3,
    failed_reads: 1,
    success_rate_percent: 75,
    successful_host_surfaces: 2,
    active_utc_weeks: 2,
    repeated_weekly_use: true,
    projects_reused_across_hosts_within_7_days: 1,
  });
  assert.equal(signals.saving.offers, 2);
  assert.equal(signals.saving.proposals, 3);
  assert.equal(signals.saving.confirmed_offers, 1);
  assert.equal(signals.saving.cancelled_offers, 0);
  assert.equal(signals.saving.pending_offers, 1);
  assert.equal(signals.saving.completion_rate_percent, 50);
  assert.equal(signals.saving.average_proposals_per_offer, 1.5);
  assert.equal(signals.saving.repairs, 1);
  assert.equal(signals.privacy.content_fields_read, false);
  assert.doesNotMatch(JSON.stringify(signals), /SECRET|signals\.first|signals\.pending/);
  database.close();
});
