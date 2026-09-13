import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp as createMcpApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let cookie;
let database;
let identity;
let mcpBaseUrl;
let mcpServer;
let webBaseUrl;
let webServer;

function projectStateCounts() {
  return database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence,
        (SELECT COUNT(*) FROM candidate_claims) AS candidates,
        (SELECT COUNT(*) FROM accepted_project_state) AS accepted`,
    )
    .get();
}

before(async () => {
  database = openSqliteTestDatabase();
  identity = await createTestIdentity(database, {
    email: "single-save@alice.example",
    password: "single save private password",
    projectId: "project_single_save",
  });
  const mcp = await createMcpApp({ database, publicUrl: "http://127.0.0.1" });
  mcpServer = mcp.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => mcpServer.once("listening", resolve));
  mcpBaseUrl = `http://127.0.0.1:${mcpServer.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(mcpBaseUrl, {
    email: identity.email,
    password: "single save private password",
    clientName: "ChatGPT single Save card test",
  }));
  const web = await createWebApp({ database, publicUrl: "http://127.0.0.1" });
  webServer = web.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => webServer.once("listening", resolve));
  webBaseUrl = `http://127.0.0.1:${webServer.address().port}`;
  const login = await fetch(`${webBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: identity.email,
      password: "single save private password",
      next: "/",
    }),
    redirect: "manual",
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  await Promise.all(
    [mcpServer, webServer].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  database.close();
});

async function prepare(key: string, value: string) {
  return callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: identity.project_id,
      summary: "Save the exact launch message",
      candidate_claims: [{ state_key: "launch.message", value, summary: "Launch message" }],
      source_context: `The exact proposed message is ${value}.`,
      idempotency_key: key,
    },
  });
}

test("the authenticated web fallback has one Save action and atomically accepts it", async () => {
  const before = projectStateCounts();
  const prepared = await prepare("single-save-web-001", "Keep the plot");
  const preview = prepared.payload.result.structuredContent;
  assert.equal(preview.source_host, "chatgpt");
  assert.ok(Date.parse(preview.created_at));
  assert.deepEqual(projectStateCounts(), before);

  const unauthenticated = await fetch(
    `${webBaseUrl}/save-previews/${encodeURIComponent(preview.preview_id)}`,
    { redirect: "manual" },
  );
  assert.equal(unauthenticated.status, 303);

  const page = await fetch(
    `${webBaseUrl}/save-previews/${encodeURIComponent(preview.preview_id)}`,
    {
      headers: { cookie },
    },
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Save this to Private project\?/);
  assert.match(html, /data-app-shell/);
  assert.match(html, /Keep the plot/);
  assert.doesNotMatch(html, /General|Work context/);
  assert.match(html, />Save</);
  assert.doesNotMatch(html, />Cancel|value="cancelled"/i);
  assert.deepEqual(projectStateCounts(), before);

  const saved = await fetch(
    `${webBaseUrl}/save-previews/${encodeURIComponent(preview.preview_id)}`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ preview_version: preview.preview_version }),
    },
  );
  assert.equal(saved.status, 200);
  assert.match(saved.url, new RegExp(`/projects/${identity.project_id}/changes$`));
  const savedHtml = await saved.text();
  assert.match(savedHtml, /Latest changes/);
  assert.deepEqual({ ...projectStateCounts() }, { evidence: 1, candidates: 1, accepted: 1 });
});

test("the embedded app can recover from a bad selection, save chosen items, and restore a receipt", async () => {
  const before = projectStateCounts();
  const prepared = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "project_information",
      record_type: "project_update",
      project_id: identity.project_id,
      summary: "Choose the useful conversation outcomes",
      candidate_claims: [
        {
          state_key: "launch.keep",
          value: "Keep this exact decision",
          summary: "Keep decision",
        },
        {
          state_key: "launch.skip",
          value: "Do not save this chat fragment",
          summary: "Skip fragment",
        },
      ],
      source_context: "PRIVATE UNSELECTED SUPPORTING CHAT",
      idempotency_key: "selected-save-receipt-001",
    },
  });
  assert.match(prepared.payload.result.content[0].text, /2 host-presented project items/);
  assert.match(prepared.payload.result.content[0].text, /Save selected/);
  const preview = prepared.payload.result.structuredContent;
  const authority = prepared.payload.result._meta["alice/saveAuthority"];

  const beforeSaveStatus = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_get_save_status",
    arguments: { preview_id: preview.preview_id },
  });
  assert.deepEqual(beforeSaveStatus.payload.result.structuredContent, {
    contract_version: "alice_save_confirmation_status_v1",
    status: "not_saved",
  });
  assert.doesNotMatch(JSON.stringify(beforeSaveStatus.payload.result), /Saved to Alice/);

  const invalid = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: authority.token,
      selected_claim_indices: [9],
    },
  });
  assert.equal(invalid.payload.result.isError, true);
  assert.match(invalid.payload.result.content[0].text, /selected project items/i);
  assert.deepEqual(projectStateCounts(), before);

  const saved = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: authority.token,
      selected_claim_indices: [0],
    },
  });
  const receipt = saved.payload.result.structuredContent;
  assert.equal(receipt.contract_version, "alice_save_confirmation_receipt_v1");
  assert.equal(receipt.status, "saved");
  assert.equal(receipt.selected_count, 1);
  assert.equal(receipt.destination.project_name, "Private project");
  assert.equal(receipt.destination.project_id, undefined);
  assert.deepEqual(
    { ...projectStateCounts() },
    {
      evidence: Number(before.evidence) + 1,
      candidates: Number(before.candidates) + 1,
      accepted: Number(before.accepted) + 1,
    },
  );
  const evidence = database
    .prepare("SELECT exact_payload_json FROM evidence_events WHERE id = ?")
    .get(receipt.evidence_id);
  const exact = JSON.parse(evidence.exact_payload_json);
  assert.deepEqual(
    exact.candidate_claims.map((claim) => claim.state_key),
    ["launch.keep"],
  );
  assert.equal(exact.source_context, undefined);
  assert.doesNotMatch(evidence.exact_payload_json, /PRIVATE UNSELECTED|launch\.skip|Do not save/);

  const restored = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_get_save_status",
    arguments: { preview_id: preview.preview_id },
  });
  assert.deepEqual(restored.payload.result.structuredContent, receipt);

  const intruder = await createTestIdentity(database, {
    email: "save-receipt-intruder@alice.example",
    password: "save receipt intruder password",
    projectId: "project_save_receipt_intruder",
  });
  assert.ok(intruder.id);
  const {
    tokens: { access_token: intruderToken },
  } = await authorize(mcpBaseUrl, {
    email: "save-receipt-intruder@alice.example",
    password: "save receipt intruder password",
    clientName: "Claude receipt non-disclosure test",
  });
  const hidden = await callMcp(mcpBaseUrl, intruderToken, "tools/call", {
    name: "alice_get_save_status",
    arguments: { preview_id: preview.preview_id },
  });
  assert.deepEqual(hidden.payload.result.structuredContent, {
    contract_version: "alice_save_confirmation_status_v1",
    status: "not_saved",
  });
  assert.doesNotMatch(JSON.stringify(hidden.payload.result), /Private project|launch\.keep/);

  const next = await prepare("selected-save-checkpoint-002", "Next decision");
  assert.equal(next.payload.result.structuredContent.last_saved.save_kind, "project_information");
  assert.ok(Date.parse(next.payload.result.structuredContent.last_saved.saved_at));
});

test("an ignored or stale card creates no additional project state", async () => {
  const ignored = await prepare("single-save-ignored-001", "Ignored value");
  assert.equal(ignored.payload.result.structuredContent.status, "awaiting_save");
  const before = projectStateCounts();

  const stale = await prepare("single-save-stale-001", "Stale value");
  const stalePreview = stale.payload.result.structuredContent;
  const denied = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_commit_capture_save",
    arguments: {
      preview_id: stalePreview.preview_id,
      preview_version: "0".repeat(64),
      authority_token: stale.payload.result._meta["alice/saveAuthority"].token,
    },
  });
  assert.equal(denied.payload.result.isError, true);
  assert.match(denied.payload.result.content[0].text, /preview changed/i);
  assert.deepEqual(projectStateCounts(), before);
});
