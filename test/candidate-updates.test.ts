import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp } from "../apps/mcp/src/app.ts";
import {
  CaptureSavePreviewUserError,
  commitCaptureSavePreview,
  createCaptureSavePreview,
  saveCandidateUpdate,
} from "@alice/domain";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
let initialCaptureResult;
let server;

const update = {
  project_id: "project_switchboard_launch",
  summary: "Save canonical decisions A-C",
  candidate_claims: [
    { state_key: "launch.icp", value: "Independent product consultants", summary: "ICP" },
    {
      state_key: "launch.product_form",
      value: "Web control plane plus authenticated remote MCP server",
      summary: "Product form",
    },
    { state_key: "launch.monthly_price_usd", value: 24, summary: "Monthly price" },
  ],
  source_note: "Explicitly supplied by the tester",
  idempotency_key: "chatgpt-leg-1-A-C",
};

function captureCounts() {
  return created.database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence,
        (SELECT COUNT(*) FROM candidate_claims) AS candidates,
        (SELECT COUNT(*) FROM accepted_project_state) AS accepted,
        (SELECT COUNT(*) FROM audit_events) AS audit`,
    )
    .get();
}

function authenticatedCaptureSubject() {
  return created.database
    .prepare(
      `SELECT client_id, user_id, connection_id
       FROM oauth_access_tokens WHERE token_hash = ?`,
    )
    .get(createHash("sha256").update(accessToken).digest("hex"));
}

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  await createTestIdentity(created.database);
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(baseUrl));
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

async function prepareAndSave(argumentsValue = update) {
  const prepared = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: argumentsValue,
  });
  const preview = prepared.payload.result.structuredContent;
  const authority = prepared.payload.result._meta["alice/saveAuthority"];
  const saved = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: authority.token,
    },
  });
  return { prepared, preview, saved };
}

test("the initial save call creates only an exact short-lived preview", async () => {
  const before = captureCounts();
  const { response, payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: update,
  });
  assert.equal(response.status, 200);
  const preview = payload.result.structuredContent;
  assert.equal(preview.contract_version, "alice_save_card_v1");
  assert.equal(preview.card_type, "context_capture");
  assert.equal(preview.payload.candidate_claims.length, 3);
  assert.equal(preview.status, "awaiting_save");
  assert.equal(preview.pre_save_state, "preview_only");
  assert.equal(preview.trusted_state_changed, false);
  assert.match(preview.fallback_url, /\/save-previews\/capture_save_preview_/);
  assert.equal("authority_token" in preview, false);
  assert.match(payload.result._meta["alice/saveAuthority"].token, /^alice_save_/);
  assert.deepEqual(captureCounts(), before);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM capture_save_previews").get().count,
    1,
  );

  const saved = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: payload.result._meta["alice/saveAuthority"].token,
    },
  });
  initialCaptureResult = saved.payload.result.structuredContent;
  assert.equal(initialCaptureResult.status, "saved");
  assert.equal(initialCaptureResult.accepted.length, 3);
  assert.equal(initialCaptureResult.trusted_state_changed, true);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM candidate_claims").get().count,
    3,
  );
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM candidate_claims WHERE status = 'accepted'")
      .get().count,
    3,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    3,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM capture_save_previews").get().count,
    0,
  );
});

test("an idempotent Save retry returns the original accepted evidence", async () => {
  const { saved } = await prepareAndSave();
  assert.equal(
    saved.payload.result.structuredContent.evidence_id,
    initialCaptureResult.evidence_id,
  );
  assert.equal(saved.payload.result.structuredContent.deduplicated, true);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM candidate_claims").get().count,
    3,
  );
  assert.equal(
    created.database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'candidate_update_submitted'",
      )
      .get().count,
    1,
  );
});

test("model-supplied or expired Save authority creates no durable project state", async () => {
  const before = captureCounts();
  const prepared = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: { ...update, idempotency_key: "forged-save-authority" },
  });
  const preview = prepared.payload.result.structuredContent;
  const forged = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: `alice_save_${"A".repeat(43)}`,
    },
  });
  assert.equal(forged.payload.result.isError, true);
  assert.match(forged.payload.result.content[0].text, /authority is unavailable/i);
  assert.deepEqual(captureCounts(), before);

  const subject = authenticatedCaptureSubject();
  const createdAt = new Date("2026-09-07T00:00:00.000Z");
  const expired = await createCaptureSavePreview(created.database, {
    clientId: subject.client_id,
    connectionId: subject.connection_id,
    publicUrl: "http://127.0.0.1",
    userId: subject.user_id,
    payload: { ...update, idempotency_key: "expired-save-authority" },
    now: createdAt,
  });
  await assert.rejects(
    () =>
      commitCaptureSavePreview(created.database, {
        previewId: expired.preview.preview_id,
        previewVersion: expired.preview.preview_version,
        authorityToken: expired.authorityToken,
        authority: "mcp_app",
        publicUrl: "http://127.0.0.1",
        userId: subject.user_id,
        now: new Date(createdAt.getTime() + 31 * 60 * 1_000),
      }),
    CaptureSavePreviewUserError,
  );
  assert.deepEqual(captureCounts(), before);
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM capture_save_previews WHERE id = ?")
      .get(expired.preview.preview_id).count,
    0,
  );
});

test("idempotency-key reuse with different evidence is rejected at Save", async () => {
  const { saved } = await prepareAndSave({ ...update, summary: "Different submitted evidence" });
  assert.equal(saved.payload.result.isError, true);
  assert.match(saved.payload.result.content[0].text, /different payload/i);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
});

test("candidate insertion failure rolls back evidence and audit creation", async () => {
  const beforeFailure = captureCounts();
  created.database.exec(`
    CREATE TRIGGER force_candidate_capture_failure
    BEFORE INSERT ON candidate_claims
    BEGIN
      SELECT RAISE(ABORT, 'forced candidate failure');
    END;
  `);
  try {
    const subject = authenticatedCaptureSubject();
    await assert.rejects(
      () =>
        saveCandidateUpdate(created.database, {
          clientId: subject.client_id,
          connectionId: subject.connection_id,
          publicUrl: "http://127.0.0.1",
          userId: subject.user_id,
          payload: { ...update, idempotency_key: "forced-candidate-failure" },
        }),
      /forced candidate failure/,
    );
  } finally {
    created.database.exec("DROP TRIGGER force_candidate_capture_failure");
  }
  assert.deepEqual(captureCounts(), beforeFailure);
});

test("audit insertion failure rolls back evidence and every candidate", async () => {
  const beforeFailure = captureCounts();
  created.database.exec(`
    CREATE TRIGGER force_capture_audit_failure
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'candidate_update_submitted'
    BEGIN
      SELECT RAISE(ABORT, 'forced capture audit failure');
    END;
  `);
  try {
    const subject = authenticatedCaptureSubject();
    await assert.rejects(
      () =>
        saveCandidateUpdate(created.database, {
          clientId: subject.client_id,
          connectionId: subject.connection_id,
          publicUrl: "http://127.0.0.1",
          userId: subject.user_id,
          payload: { ...update, idempotency_key: "forced-audit-failure" },
        }),
      /forced capture audit failure/,
    );
  } finally {
    created.database.exec("DROP TRIGGER force_capture_audit_failure");
  }
  assert.deepEqual(captureCounts(), beforeFailure);
});

test("database guards prevent evidence update and deletion", () => {
  assert.throws(
    () => created.database.prepare("UPDATE evidence_events SET exact_payload_json = '{}' ").run(),
    /evidence events are immutable/,
  );
  assert.throws(
    () => created.database.prepare("DELETE FROM evidence_events").run(),
    /evidence events are immutable/,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
  assert.throws(
    () => created.database.prepare("UPDATE audit_events SET action = 'rewritten'").run(),
    /audit events are append-only/,
  );
  assert.throws(
    () => created.database.prepare("DELETE FROM audit_events").run(),
    /audit events are append-only/,
  );
});

test("a read-only token cannot call the write tool", async () => {
  created.database
    .prepare("UPDATE oauth_access_tokens SET scope = 'mcp:read' WHERE token_hash = ?")
    .run(createHash("sha256").update(accessToken).digest("hex"));
  const { payload } = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: { ...update, idempotency_key: "read-only-attempt" },
  });
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /does not grant mcp:write/);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count,
    1,
  );
});
