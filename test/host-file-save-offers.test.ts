import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  acceptProjectInvitation,
  createProjectInvitation,
  createUserSession,
  createWorkContext,
  setActiveConnectionTarget,
  setContextProviderAvailability,
} from "@alice/domain";
import { createApp as createMcpApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { authorize, callMcp, createTestIdentity, getProjectDefaultContext } from "./helpers.ts";

class NoByteFileStore {
  putCount = 0;

  async putObject() {
    this.putCount += 1;
    throw new Error("the save-offer task must not store bytes");
  }

  async getScanResult() {
    return "pending" as const;
  }

  async getObject() {
    throw new Error("the save-offer task must not read bytes");
  }

  async createSignedDownload() {
    throw new Error("the save-offer task must not create a download");
  }
}

let accessToken;
let connection;
let cookie;
let database;
let identity;
let foreignIdentity;
let mcpBaseUrl;
let mcpServer;
let selectedWorkContext;
let target;
let webBaseUrl;
let webServer;
const fileStore = new NoByteFileStore();

before(async () => {
  database = openSqliteTestDatabase();
  identity = await createTestIdentity(database, {
    email: "host-file-owner@alice.example",
    password: "host file owner private password",
    projectId: "project_host_file_offer",
  });
  target = await getProjectDefaultContext(database, identity.project_id);
  selectedWorkContext = await createWorkContext(database, {
    userId: identity.id,
    projectId: identity.project_id,
    input: {
      name: "Chat workstream",
      description: "The active chat context that must receive attachment saves.",
      visibility: "personal",
    },
    providerAvailability: { chatgpt: true, claude: false },
  });

  const web = await createWebApp({
    database,
    fileStore,
    publicUrl: "http://127.0.0.1",
  });
  webServer = web.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => webServer.once("listening", resolve));
  webBaseUrl = `http://127.0.0.1:${webServer.address().port}`;

  const mcp = await createMcpApp({
    database,
    fileStore,
    publicUrl: "http://127.0.0.1",
    reviewUrl: webBaseUrl,
  });
  mcpServer = mcp.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => mcpServer.once("listening", resolve));
  mcpBaseUrl = `http://127.0.0.1:${mcpServer.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(mcpBaseUrl, {
    email: identity.email,
    password: "host file owner private password",
    clientName: "ChatGPT host attachment test",
  }));
  connection = database
    .prepare("SELECT id FROM integration_connections WHERE user_id = ?")
    .get(identity.id);
  const selected = await setActiveConnectionTarget(database, {
    userId: identity.id,
    connectionId: connection.id,
    projectId: identity.project_id,
    contextId: selectedWorkContext.id,
    expectedVersions: { [connection.id]: null },
  });
  assert.equal(selected.conflict, false);
  const session = await createUserSession(database, identity.id);
  cookie = `alice_session=${encodeURIComponent(session.token)}`;
});

after(async () => {
  await Promise.all(
    [mcpServer, webServer]
      .filter(Boolean)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  database?.close();
});

async function offerFile(
  idempotencyKey: string,
  fileName = "alpha-plan.md",
  declaredMediaType = "text/markdown",
) {
  return await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "offer_host_file_save",
    arguments: {
      project_id: identity.project_id,
      file_name: fileName,
      declared_media_type: declaredMediaType,
      declared_byte_size: 128,
      declared_sha256: "a".repeat(64),
      conversation_reference: "conversation.alpha-001",
      idempotency_key: idempotencyKey,
    },
  });
}

test("the MCP contract previews an exact save to the named project", async () => {
  const listed = await callMcp(mcpBaseUrl, accessToken, "tools/list");
  const tool = listed.payload.result.tools.find(({ name }) => name === "offer_host_file_save");
  assert.deepEqual(tool._meta.securitySchemes, [{ type: "oauth2", scopes: ["mcp:write"] }]);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.match(tool.description, /accepts no bytes, host URL, credential, cookie, prompt text/i);
  assert.match(tool.description, /exact unique project name/i);
  assert.equal(tool.inputSchema.required.includes("project_id"), false);
  assert.match(tool.description, /Only the user's Save action can authorize/i);
  assert.equal(tool._meta.ui.resourceUri, "ui://alice/save/v1.html");

  const before = database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM file_objects) AS objects,
        (SELECT COUNT(*) FROM file_context_references) AS file_references,
        (SELECT COUNT(*) FROM accepted_project_state) AS accepted`,
    )
    .get();
  const created = await offerFile("host-file-offer-001");
  assert.equal(created.payload.result.isError, undefined);
  const receipt = created.payload.result.structuredContent;
  assert.equal(receipt.status, "awaiting_save");
  assert.equal(receipt.pre_save_state, "preview_only");
  assert.equal(receipt.file.name, "alpha-plan.md");
  assert.equal(receipt.destination.project_name, "Private project");
  assert.equal(receipt.destination.context_name, undefined);
  assert.equal(receipt.destination.context_id, undefined);
  assert.equal(receipt.destination.access, undefined);
  assert.equal(receipt.source_host, "chatgpt");
  assert.equal(receipt.bytes_received, false);
  assert.equal(receipt.trusted_state_changed, false);
  assert.equal("authorityToken" in receipt, false);
  assert.match(created.payload.result._meta["alice/saveAuthority"].token, /^alice_file_save_/);
  assert.equal(fileStore.putCount, 0);
  assert.deepEqual(
    database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM file_objects) AS objects,
          (SELECT COUNT(*) FROM file_context_references) AS file_references,
          (SELECT COUNT(*) FROM accepted_project_state) AS accepted`,
      )
      .get(),
    before,
  );
  const stored = database
    .prepare(
      `SELECT display_name, source_host, conversation_reference, declared_sha256
       FROM host_file_save_offers WHERE id = ?`,
    )
    .get(receipt.offer_id);
  assert.deepEqual(
    { ...stored },
    {
      display_name: "alpha-plan.md",
      source_host: "chatgpt",
      conversation_reference: "conversation.alpha-001",
      declared_sha256: "a".repeat(64),
    },
  );

  const retried = await offerFile("host-file-offer-001");
  assert.equal(retried.payload.result.structuredContent.offer_id, receipt.offer_id);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM host_file_save_offers").get().count,
    1,
  );
  const mismatched = await offerFile("host-file-offer-001", "different.md");
  assert.equal(mismatched.payload.result.isError, true);
  assert.match(mismatched.payload.result.content[0].text, /different file save offer/i);

  const office = await offerFile(
    "host-file-offer-office-001",
    "analysis.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(office.payload.result.isError, undefined);
  assert.equal(office.payload.result.structuredContent.file.name, "analysis.xlsx");
  assert.equal(
    database
      .prepare("SELECT declared_media_type FROM host_file_save_offers WHERE id = ?")
      .get(office.payload.result.structuredContent.offer_id).declared_media_type,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});

test("only the authenticated owner can choose the single Save action", async () => {
  const receipt = (await offerFile("host-file-offer-002")).payload.result.structuredContent;
  const unauthenticated = await fetch(receipt.confirmation_url, { redirect: "manual" });
  assert.equal(unauthenticated.status, 303);
  assert.match(unauthenticated.headers.get("location"), /^\/auth\/login\?next=/);

  const page = await fetch(receipt.confirmation_url, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Save this file to Private project\?/);
  assert.match(html, /data-app-shell/);
  assert.match(html, /alpha-plan\.md/);
  assert.match(html, /Private project/);
  assert.doesNotMatch(html, /Chat workstream|General|Work context|Personal draft/);
  assert.match(html, /No file has been copied/);
  assert.match(html, />Save</);
  assert.match(html, /name="decision" value="save_file_only"/);
  assert.doesNotMatch(html, /save_and_suggest_context|suggest context/i);
  assert.doesNotMatch(html, /value="cancelled"|>Cancel</i);
  const previewVersion = html.match(/name="preview_version" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(previewVersion);

  const unsupportedSuggestion = await fetch(`${receipt.confirmation_url}/decision`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      preview_version: previewVersion,
      decision: "save_and_suggest_context",
    }),
  });
  assert.equal(unsupportedSuggestion.status, 409);
  assert.match(await unsupportedSuggestion.text(), /only available decision is Save/i);

  const decided = await fetch(`${receipt.confirmation_url}/decision`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      preview_version: previewVersion,
      decision: "save_file_only",
    }),
  });
  assert.equal(decided.status, 200);
  assert.match(decided.url, new RegExp(`/file-save-offers/${receipt.offer_id}$`));
  const decisionHtml = await decided.text();
  assert.match(decisionHtml, /Transfer authorized/);
  assert.match(decisionHtml, /file is not saved yet/i);
  assert.equal(
    database
      .prepare("SELECT decision FROM host_file_save_decisions WHERE offer_id = ?")
      .get(receipt.offer_id).decision,
    "save_file_only",
  );
  assert.equal(fileStore.putCount, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count, 0);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    0,
  );

  const toolRetry = await offerFile("host-file-offer-002");
  assert.equal(toolRetry.payload.result.structuredContent.offer_id, receipt.offer_id);
  assert.equal(toolRetry.payload.result.structuredContent.status, "save_file_only");
  assert.equal(toolRetry.payload.result._meta["alice/saveAuthority"], undefined);
  assert.equal(toolRetry.payload.result._meta["alice/saveState"].status, "save_file_only");
  assert.match(toolRetry.payload.result.content[0].text, /already authorized/i);

  const replay = await fetch(`${receipt.confirmation_url}/decision`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ preview_version: previewVersion, decision: "save_file_only" }),
  });
  assert.equal(replay.status, 409);
  assert.match(await replay.text(), /already decided/i);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions").get().count,
    1,
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE host_file_save_decisions SET decision = 'cancelled' WHERE offer_id = ?")
        .run(receipt.offer_id),
    /immutable/,
  );
});

test("foreign users, read-only tokens, and model-supplied authority fail closed", async () => {
  const offered = await offerFile("host-file-offer-003");
  const receipt = offered.payload.result.structuredContent;
  const forgedSave = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_confirm_host_file_save",
    arguments: {
      offer_id: receipt.offer_id,
      preview_version: receipt.preview_version,
      authority_token: `alice_file_save_${"A".repeat(43)}`,
    },
  });
  assert.equal(forgedSave.payload.result.isError, true);
  assert.match(forgedSave.payload.result.content[0].text, /authority is unavailable/i);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id = ?")
      .get(receipt.offer_id).count,
    0,
  );
  foreignIdentity = await createTestIdentity(database, {
    email: "host-file-foreign@alice.example",
    password: "host file foreign private password",
    projectId: "project_host_file_foreign",
  });
  const foreignSession = await createUserSession(database, foreignIdentity.id);
  const foreignResponse = await fetch(receipt.confirmation_url, {
    headers: { cookie: `alice_session=${encodeURIComponent(foreignSession.token)}` },
  });
  assert.equal(foreignResponse.status, 404);
  assert.doesNotMatch(await foreignResponse.text(), /alpha-plan|Private project|General/i);
  const ownerOffer = database
    .prepare(`SELECT workspace_id, project_id, context_id FROM host_file_save_offers WHERE id = ?`)
    .get(receipt.offer_id);
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO host_file_save_decisions
            (offer_id, workspace_id, project_id, context_id, decided_by_user_id,
             decision, decision_version, decided_at)
           VALUES (?, ?, ?, ?, ?, 'cancelled', ?, ?)`,
        )
        .run(
          receipt.offer_id,
          ownerOffer.workspace_id,
          ownerOffer.project_id,
          ownerOffer.context_id,
          foreignIdentity.id,
          "0".repeat(64),
          new Date().toISOString(),
        ),
    /FOREIGN KEY constraint failed/,
  );

  const before = database
    .prepare("SELECT COUNT(*) AS count FROM host_file_save_offers")
    .get().count;
  for (const unsafe of [
    { confirmed: true },
    { attachment_url: "https://host.example/reusable-secret" },
    { prompt_text: "The user said yes" },
    { content_base64: Buffer.from("secret bytes").toString("base64") },
  ]) {
    const denied = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
      name: "offer_host_file_save",
      arguments: {
        project_id: identity.project_id,
        file_name: "unsafe.txt",
        idempotency_key: `unsafe-${Object.keys(unsafe)[0]}`,
        ...unsafe,
      },
    });
    assert.equal(denied.payload.result.isError, true);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM host_file_save_offers").get().count,
    before,
  );

  const tokenHash = createHash("sha256").update(accessToken).digest("hex");
  database
    .prepare("UPDATE oauth_access_tokens SET scope = 'mcp:read' WHERE token_hash = ?")
    .run(tokenHash);
  try {
    const readOnly = await offerFile("host-file-read-only-001");
    assert.equal(readOnly.payload.result.isError, true);
    assert.match(readOnly.payload.result.content[0].text, /does not grant mcp:write/i);
  } finally {
    database
      .prepare(
        "UPDATE oauth_access_tokens SET scope = 'mcp:read mcp:write offline_access' WHERE token_hash = ?",
      )
      .run(tokenHash);
  }
});

test("a collaborator offer keeps connection and project workspaces distinct", async () => {
  const invitation = await createProjectInvitation(database, {
    userId: identity.id,
    projectId: identity.project_id,
    email: foreignIdentity.email,
    role: "editor",
  });
  await acceptProjectInvitation(database, foreignIdentity.id, invitation.token);
  const {
    tokens: { access_token: collaboratorToken },
  } = await authorize(mcpBaseUrl, {
    email: foreignIdentity.email,
    password: "host file foreign private password",
    clientName: "Claude collaborator attachment test",
  });
  const collaboratorConnection = database
    .prepare(
      `SELECT id FROM integration_connections
       WHERE user_id = ? AND client_classification = 'claude' ORDER BY first_connected_at DESC`,
    )
    .get(foreignIdentity.id);
  await setContextProviderAvailability(database, {
    userId: foreignIdentity.id,
    projectId: identity.project_id,
    contextId: target.id,
    chatgpt: false,
    claude: true,
    expectedVersions: { chatgpt: null, claude: null },
  });
  const selected = await setActiveConnectionTarget(database, {
    userId: foreignIdentity.id,
    connectionId: collaboratorConnection.id,
    projectId: identity.project_id,
    contextId: target.id,
    expectedVersions: { [collaboratorConnection.id]: null },
  });
  assert.equal(selected.conflict, false);
  const offered = await callMcp(mcpBaseUrl, collaboratorToken, "tools/call", {
    name: "offer_host_file_save",
    arguments: {
      project_id: identity.project_id,
      file_name: "collaborator.txt",
      idempotency_key: "host-file-collaborator-001",
    },
  });
  assert.equal(offered.payload.result.isError, undefined);
  const receipt = offered.payload.result.structuredContent;
  assert.equal(receipt.source_host, "claude");
  assert.equal(receipt.destination.project_id, undefined);
  const stored = database
    .prepare(
      `SELECT workspace_id, connection_workspace_id
       FROM host_file_save_offers WHERE id = ?`,
    )
    .get(receipt.offer_id);
  assert.equal(stored.workspace_id, identity.workspace_id);
  assert.equal(stored.connection_workspace_id, foreignIdentity.workspace_id);
  assert.notEqual(stored.workspace_id, stored.connection_workspace_id);
});

test("a tampered preview fails while legacy target changes do not redirect it", async () => {
  const tamperReceipt = (await offerFile("host-file-offer-tamper-001")).payload.result
    .structuredContent;
  const tampered = await fetch(`${tamperReceipt.confirmation_url}/decision`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      preview_version: "0".repeat(64),
      decision: "save_file_only",
    }),
  });
  assert.equal(tampered.status, 409);
  assert.match(await tampered.text(), /preview changed/i);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id = ?")
      .get(tamperReceipt.offer_id).count,
    0,
  );

  const staleReceipt = (await offerFile("host-file-offer-stale-001")).payload.result
    .structuredContent;
  const page = await fetch(staleReceipt.confirmation_url, { headers: { cookie } });
  const previewVersion = (await page.text()).match(
    /name="preview_version" value="([0-9a-f]{64})"/,
  )?.[1];
  const otherContext = await createWorkContext(database, {
    userId: identity.id,
    projectId: identity.project_id,
    input: {
      name: "Other host destination",
      description: "Makes the earlier host file preview stale.",
      visibility: "personal",
    },
    providerAvailability: { chatgpt: true, claude: false },
  });
  const current = database
    .prepare("SELECT selection_version FROM active_connection_targets WHERE connection_id = ?")
    .get(connection.id);
  const changed = await setActiveConnectionTarget(database, {
    userId: identity.id,
    connectionId: connection.id,
    projectId: identity.project_id,
    contextId: otherContext.id,
    expectedVersions: { [connection.id]: current.selection_version },
  });
  assert.equal(changed.conflict, false);
  const stale = await fetch(`${staleReceipt.confirmation_url}/decision`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ preview_version: previewVersion, decision: "save_file_only" }),
  });
  assert.equal(stale.status, 200);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id = ?")
      .get(staleReceipt.offer_id).count,
    1,
  );
});

test("dismissal and a forged Cancel create no transfer authority or project state", async () => {
  const receipt = (await offerFile("host-file-offer-004", "cancelled.txt")).payload.result
    .structuredContent;
  const page = await fetch(receipt.confirmation_url, { headers: { cookie } });
  const html = await page.text();
  const previewVersion = html.match(/name="preview_version" value="([0-9a-f]{64})"/)?.[1];
  const cancelled = await fetch(`${receipt.confirmation_url}/decision`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ preview_version: previewVersion, decision: "cancelled" }),
  });
  assert.equal(cancelled.status, 409);
  assert.match(await cancelled.text(), /only available decision is Save/i);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id = ?")
      .get(receipt.offer_id).count,
    0,
  );
  assert.equal(fileStore.putCount, 0);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    0,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM candidate_claims").get().count, 0);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    0,
  );
});

test("legacy provider toggles do not block a permission-authorized attachment offer", async () => {
  const mappedDefault = await getProjectDefaultContext(database, identity.project_id);
  const active = {
    project_id: mappedDefault.project_id,
    context_id: mappedDefault.id,
  };
  const currentRows = database
    .prepare(
      `SELECT provider, version FROM context_provider_authorizations
       WHERE user_id = ? AND context_id = ? ORDER BY provider`,
    )
    .all(identity.id, active.context_id);
  const versions = Object.fromEntries(
    currentRows.map(({ provider, version }) => [provider, version]),
  );
  const disabled = await setContextProviderAvailability(database, {
    userId: identity.id,
    projectId: active.project_id,
    contextId: active.context_id,
    chatgpt: false,
    claude: false,
    expectedVersions: versions,
  });
  assert.equal(disabled.conflict, false);
  const before = database.prepare("SELECT COUNT(*) AS count FROM host_file_save_offers").get();
  const offered = await offerFile("host-file-offer-provider-disabled-001");
  assert.equal(offered.payload.result.isError, undefined);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM host_file_save_offers").get().count,
    before.count + 1,
  );
});
