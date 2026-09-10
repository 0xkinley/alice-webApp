import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  createWorkContext,
  createUserSession,
  finalizeHostFileSaveTransfer,
  finalizeProjectFileUpload,
  setActiveConnectionTarget,
} from "@alice/domain";
import { createApp as createMcpApp } from "../apps/mcp/src/app.ts";
import { createApp as createWebApp } from "../apps/web/src/app.ts";
import { authorize, callMcp, createTestIdentity, getProjectDefaultContext } from "./helpers.ts";

class HostTransferStore {
  objects = new Map<string, { bytes: Buffer; versionId: string }>();
  signedKey = "";
  stagingScan: "pending" | "clean" | "threats_found" = "pending";
  finalScan: "pending" | "clean" | "threats_found" = "pending";
  putCount = 0;

  async createSignedUpload({ key, expiresInSeconds }) {
    this.signedKey = key;
    return {
      url: `https://private-files.alice.example/${encodeURIComponent(key)}`,
      headers: { "x-alice-exact-transfer": "signed" },
      expiresInSeconds,
    };
  }

  stage(bytes: Buffer, versionId: string) {
    this.objects.set(this.signedKey, { bytes: Buffer.from(bytes), versionId });
    return versionId;
  }

  async putObject({ key, bytes }) {
    this.putCount += 1;
    const versionId = `final-host-version-${this.putCount}`;
    this.objects.set(key, { bytes: Buffer.from(bytes), versionId });
    return { versionId, etag: `final-host-etag-${this.putCount}` };
  }

  async getScanResult({ key, versionId }) {
    const object = this.objects.get(key);
    if (!object || object.versionId !== versionId) throw new Error("exact object version missing");
    return key.startsWith("staging/") ? this.stagingScan : this.finalScan;
  }

  async getObject({ key, versionId }) {
    const object = this.objects.get(key);
    if (!object || object.versionId !== versionId) throw new Error("exact object version missing");
    return Buffer.from(object.bytes);
  }

  async createSignedDownload() {
    return "https://private-files.alice.example/exact-download";
  }
}

let accessToken;
let connection;
let cookie;
let database;
let identity;
let mcpBaseUrl;
let mcpServer;
let selectedWorkContext;
let target;
let webBaseUrl;
let webServer;
const publicUrl = "http://127.0.0.1";
const store = new HostTransferStore();

before(async () => {
  database = openSqliteTestDatabase();
  identity = await createTestIdentity(database, {
    email: "host-transfer-owner@alice.example",
    password: "host transfer owner private password",
    projectId: "project_host_transfer",
  });
  target = await getProjectDefaultContext(database, identity.project_id);
  selectedWorkContext = await createWorkContext(database, {
    userId: identity.id,
    projectId: identity.project_id,
    input: {
      name: "Chat transfer workstream",
      description: "The active chat context that must receive transferred attachments.",
      visibility: "personal",
    },
    providerAvailability: { chatgpt: true, claude: false },
  });
  const web = await createWebApp({ database, fileStore: store, publicUrl });
  webServer = web.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => webServer.once("listening", resolve));
  webBaseUrl = `http://127.0.0.1:${webServer.address().port}`;
  const mcp = await createMcpApp({
    database,
    fileStore: store,
    publicUrl,
    reviewUrl: webBaseUrl,
  });
  mcpServer = mcp.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => mcpServer.once("listening", resolve));
  mcpBaseUrl = `http://127.0.0.1:${mcpServer.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(mcpBaseUrl, {
    email: identity.email,
    password: "host transfer owner private password",
    clientName: "ChatGPT exact transfer test",
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

async function createOffer(bytes: Buffer, key: string, save = true) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const offered = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "offer_host_file_save",
    arguments: {
      project_id: identity.project_id,
      file_name: `${key}.md`,
      declared_media_type: "text/markdown",
      declared_byte_size: bytes.length,
      declared_sha256: sha256,
      conversation_reference: `conversation.${key}`,
      idempotency_key: `offer-${key}`,
    },
  });
  const receipt = offered.payload.result.structuredContent;
  if (save) {
    const page = await fetch(receipt.confirmation_url, { headers: { cookie } });
    const previewVersion = (await page.text()).match(
      /name="preview_version" value="([0-9a-f]{64})"/,
    )?.[1];
    assert.ok(previewVersion);
    const decided = await fetch(`${receipt.confirmation_url}/decision`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ preview_version: previewVersion, decision: "save_file_only" }),
    });
    assert.equal(decided.status, 200);
  }
  return { receipt, sha256 };
}

test("the host transfer tools require a personal confirmation and exact signed-PUT capability", async () => {
  const listed = await callMcp(mcpBaseUrl, accessToken, "tools/list");
  const begin = listed.payload.result.tools.find(({ name }) => name === "begin_host_file_transfer");
  const finalize = listed.payload.result.tools.find(
    ({ name }) => name === "finalize_host_file_transfer",
  );
  assert.deepEqual(begin._meta.securitySchemes, [{ type: "oauth2", scopes: ["mcp:write"] }]);
  assert.equal(begin.annotations.idempotentHint, true);
  assert.match(begin.description, /only when this exact host surface can securely expose/i);
  assert.match(
    begin.description,
    /never include attachment bytes, host URLs, cookies, credentials/i,
  );
  assert.match(finalize.description, /saved-file receipt only after.*scan-clean/i);

  const bytes = Buffer.from("# Exact host transfer\nOnly confirmed bytes cross this boundary.\n");
  const { receipt, sha256 } = await createOffer(bytes, "native-pending", "");
  const denied = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "begin_host_file_transfer",
    arguments: {
      offer_id: receipt.offer_id,
      transfer_capability: "exact_signed_put_v1",
      file_name: "native-pending.md",
      claimed_media_type: "text/markdown",
      byte_size: bytes.length,
      sha256,
      idempotency_key: "native-pending-transfer",
    },
  });
  assert.equal(denied.payload.result.isError, true);
  assert.match(
    denied.payload.result.content[0].text,
    /authenticated alice\. transfer confirmation/i,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM file_upload_intents").get().count,
    0,
  );
});

test("a confirmed native transfer preserves provenance and completes only after both clean gates", async () => {
  const bytes = Buffer.from(
    "# Native transfer\nPreserve exact source and conversation provenance.\n",
  );
  const { receipt, sha256 } = await createOffer(bytes, "native-clean", "save_file_only");
  const arguments_ = {
    offer_id: receipt.offer_id,
    transfer_capability: "exact_signed_put_v1",
    file_name: "native-clean.md",
    claimed_media_type: "text/markdown",
    byte_size: bytes.length,
    sha256,
    idempotency_key: "native-clean-transfer",
  };
  const mismatched = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "begin_host_file_transfer",
    arguments: { ...arguments_, sha256: "0".repeat(64) },
  });
  assert.equal(mismatched.payload.result.isError, true);
  assert.match(mismatched.payload.result.content[0].text, /hash does not match/i);

  const started = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "begin_host_file_transfer",
    arguments: arguments_,
  });
  const intent = started.payload.result.structuredContent;
  assert.equal(intent.status, "ready");
  assert.equal(intent.transfer_path, "host_capability");
  assert.equal(intent.file.sha256, sha256);
  assert.equal(intent.upload_headers["x-alice-exact-transfer"], "signed");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    0,
  );

  const versionId = store.stage(bytes, "native-staging-version");
  assert.equal(
    await finalizeProjectFileUpload(database, store, {
      userId: identity.id,
      projectId: identity.project_id,
      intentId: intent.intent_id,
      storageVersionId: versionId,
    }),
    undefined,
    "generic direct-upload finalization cannot bypass the confirmed-offer path",
  );
  store.stagingScan = "pending";
  let finalized = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "finalize_host_file_transfer",
    arguments: {
      offer_id: receipt.offer_id,
      intent_id: intent.intent_id,
      storage_version_id: versionId,
    },
  });
  assert.deepEqual(finalized.payload.result.structuredContent, {
    status: "pending",
    stage: "staging_security_scan",
  });
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    0,
  );

  store.stagingScan = "clean";
  store.finalScan = "pending";
  finalized = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "finalize_host_file_transfer",
    arguments: {
      offer_id: receipt.offer_id,
      intent_id: intent.intent_id,
      storage_version_id: versionId,
    },
  });
  assert.equal(
    finalized.payload.result.isError,
    undefined,
    finalized.payload.result.content?.[0]?.text,
  );
  assert.equal(finalized.payload.result.structuredContent.status, "pending");
  assert.equal(finalized.payload.result.structuredContent.stage, "final_security_scan");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM host_file_save_transfer_availability").get()
      .count,
    0,
  );

  store.finalScan = "clean";
  database.exec(`
    CREATE TRIGGER fail_host_file_completion_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'host_file_save_completed'
    BEGIN
      SELECT RAISE(ABORT, 'host file completion audit failure');
    END;
  `);
  await assert.rejects(
    finalizeHostFileSaveTransfer(database, store, {
      userId: identity.id,
      connectionId: connection.id,
      offerId: receipt.offer_id,
      intentId: intent.intent_id,
      transferPath: "host_capability",
      storageVersionId: versionId,
    }),
    /host file completion audit failure/,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM host_file_save_transfer_availability").get()
      .count,
    0,
    "a failed completion audit must roll back scan-clean availability",
  );
  database.exec("DROP TRIGGER fail_host_file_completion_audit");
  finalized = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "finalize_host_file_transfer",
    arguments: {
      offer_id: receipt.offer_id,
      intent_id: intent.intent_id,
      storage_version_id: versionId,
    },
  });
  const completed = finalized.payload.result.structuredContent;
  assert.equal(completed.status, "completed");
  assert.equal(completed.scan_status, "clean");
  assert.equal(completed.source_host, "chatgpt");
  assert.equal(completed.context_id, undefined);
  assert.equal(completed.conversation_provenance_preserved, true);
  assert.equal(completed.suggestions_requested, false);
  assert.equal(completed.trusted_state_changed, false);
  const stored = database
    .prepare(
      `SELECT reference.source_host, reference.uploader_user_id, object.content_sha256,
              transfer.transfer_path, transfer.context_id, offer.conversation_reference
       FROM host_file_save_transfer_completions completion
       JOIN host_file_save_transfer_intents transfer ON transfer.intent_id = completion.intent_id
       JOIN host_file_save_offers offer ON offer.id = completion.offer_id
       JOIN file_context_references reference ON reference.id = completion.file_reference_id
       JOIN file_objects object ON object.id = reference.file_object_id
       WHERE completion.offer_id = ?`,
    )
    .get(receipt.offer_id);
  assert.deepEqual(
    { ...stored },
    {
      source_host: "chatgpt",
      uploader_user_id: identity.id,
      content_sha256: sha256,
      transfer_path: "host_capability",
      context_id: target.id,
      conversation_reference: "conversation.native-clean",
    },
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM candidate_claims").get().count, 0);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM accepted_project_state").get().count,
    0,
  );

  const replay = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "finalize_host_file_transfer",
    arguments: {
      offer_id: receipt.offer_id,
      intent_id: intent.intent_id,
      storage_version_id: "ignored-after-completion",
    },
  });
  assert.equal(
    replay.payload.result.structuredContent.file_reference_id,
    completed.file_reference_id,
  );
  assert.equal(store.putCount, 1);
});

test("batch transfers report each file independently and preserve a successful sibling", async () => {
  const firstBytes = Buffer.from("# Batch first\nThis exact file should complete.\n");
  const secondBytes = Buffer.from(
    "# Batch second\nThis exact file should fail its first attempt.\n",
  );
  const firstHash = createHash("sha256").update(firstBytes).digest("hex");
  const secondHash = createHash("sha256").update(secondBytes).digest("hex");
  const batchArguments = {
    project_id: "Private project",
    files: [
      {
        file_name: "batch-first.md",
        declared_media_type: "text/markdown",
        declared_byte_size: firstBytes.length,
        declared_sha256: firstHash,
      },
      {
        file_name: "batch-second.md",
        declared_media_type: "text/markdown",
        declared_byte_size: secondBytes.length,
        declared_sha256: secondHash,
      },
    ],
    conversation_reference: "conversation.batch-transfer",
    idempotency_key: "batch-transfer-offer-001",
  };
  const offered = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "offer_host_files_save",
    arguments: batchArguments,
  });
  const card = offered.payload.result.structuredContent;
  const confirmed = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "alice_confirm_host_files_save",
    arguments: {
      offers: card.files.map((file) => ({
        offer_id: file.offer_id,
        preview_version: file.preview_version,
      })),
      preview_version: card.preview_version,
      authority_token: offered.payload.result._meta["alice/saveAuthority"].token,
    },
  });
  assert.equal(confirmed.payload.result.structuredContent.status, "save_file_only");
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM host_file_save_decisions WHERE offer_id IN (?, ?)")
      .get(card.files[0].offer_id, card.files[1].offer_id).count,
    2,
  );

  for (const file of card.files) {
    const fallback = await fetch(file.confirmation_url, { headers: { cookie } });
    assert.equal(fallback.status, 200);
    const html = await fallback.text();
    assert.match(html, new RegExp(file.name.replace(".", "\\.")));
    assert.match(html, /Exact confirmed file/);
    assert.match(html, /destination is locked/i);
  }

  const referencesBefore = database
    .prepare("SELECT COUNT(*) AS count FROM file_context_references")
    .get().count;
  const started = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "begin_host_file_transfer",
    arguments: {
      offer_id: card.files[0].offer_id,
      transfer_capability: "exact_signed_put_v1",
      file_name: "batch-first.md",
      claimed_media_type: "text/markdown",
      byte_size: firstBytes.length,
      sha256: firstHash,
      idempotency_key: "batch-first-transfer-001",
    },
  });
  const intent = started.payload.result.structuredContent;
  const versionId = store.stage(firstBytes, "batch-first-staging-version");
  store.stagingScan = "clean";
  store.finalScan = "clean";
  const completed = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "finalize_host_file_transfer",
    arguments: {
      offer_id: card.files[0].offer_id,
      intent_id: intent.intent_id,
      storage_version_id: versionId,
    },
  });
  assert.equal(completed.payload.result.structuredContent.status, "completed");

  const failedSibling = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "begin_host_file_transfer",
    arguments: {
      offer_id: card.files[1].offer_id,
      transfer_capability: "exact_signed_put_v1",
      file_name: "batch-second.md",
      claimed_media_type: "text/markdown",
      byte_size: secondBytes.length,
      sha256: "0".repeat(64),
      idempotency_key: "batch-second-transfer-001",
    },
  });
  assert.equal(failedSibling.payload.result.isError, true);
  assert.match(failedSibling.payload.result.content[0].text, /hash does not match/i);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    referencesBefore + 1,
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM host_file_save_transfer_completions WHERE offer_id = ?",
      )
      .get(card.files[0].offer_id).count,
    1,
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM host_file_save_transfer_completions WHERE offer_id = ?",
      )
      .get(card.files[1].offer_id).count,
    0,
  );

  const status = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "offer_host_files_save",
    arguments: batchArguments,
  });
  assert.equal(status.payload.result.structuredContent.status, "save_file_only");
  assert.equal(status.payload.result.structuredContent.files[0].transfer.status, "completed");
  assert.equal(status.payload.result.structuredContent.files[1].transfer, null);
  assert.match(status.payload.result.content[0].text, /batch-first\.md.*transfer completed/i);
  assert.match(status.payload.result.content[0].text, /saved only when.*completed/i);
});

test("the alice.-controlled fallback is exact-origin, pre-targeted, and scan-gated", async () => {
  const bytes = Buffer.from("# Browser fallback\nProvider attachment transfer is unavailable.\n");
  const { receipt, sha256 } = await createOffer(bytes, "browser-fallback", "save_file_only");
  const page = await fetch(receipt.confirmation_url, { headers: { cookie } });
  const html = await page.text();
  assert.match(html, /Waiting for transfer/);
  assert.doesNotMatch(html, /File saved/);
  assert.match(html, /browser-fallback\.md/);
  assert.match(html, /destination is locked/i);
  assert.match(html, /file-save-offers.*direct\/intents/);
  assert.doesNotMatch(html, /name="context_id"|name="project_id"/);

  const body = {
    file_name: "browser-fallback.md",
    claimed_media_type: "text/markdown",
    byte_size: bytes.length,
    sha256,
    idempotency_key: "browser-fallback-transfer",
  };
  const noOrigin = await fetch(`${receipt.confirmation_url}/direct/intents`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(noOrigin.status, 403);
  const wrongName = await fetch(`${receipt.confirmation_url}/direct/intents`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: publicUrl },
    body: JSON.stringify({ ...body, file_name: "another.md" }),
  });
  assert.equal(wrongName.status, 400);
  assert.match(await wrongName.text(), /name does not match/i);

  const started = await fetch(`${receipt.confirmation_url}/direct/intents`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: publicUrl },
    body: JSON.stringify(body),
  });
  assert.equal(started.status, 201);
  assert.equal(started.headers.get("cache-control"), "no-store");
  const intent = await started.json();
  assert.equal(intent.transfer_path, "browser_fallback");
  const versionId = store.stage(bytes, "browser-staging-version");
  store.stagingScan = "clean";
  store.finalScan = "clean";
  const finalized = await fetch(
    `${receipt.confirmation_url}/direct/intents/${intent.intent_id}/finalize`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: publicUrl },
      body: JSON.stringify({ storage_version_id: versionId }),
    },
  );
  assert.equal(finalized.status, 201, await finalized.clone().text());
  const completed = await finalized.json();
  assert.equal(completed.status, "completed");
  assert.equal(completed.source_host, "chatgpt");
  assert.equal(completed.suggestions_requested, false);
  const linked = database
    .prepare(
      `SELECT transfer_path FROM host_file_save_transfer_intents
       WHERE offer_id = ? AND intent_id = ?`,
    )
    .get(receipt.offer_id, intent.intent_id);
  assert.equal(linked.transfer_path, "browser_fallback");
});

test("an ignored preview and threat verdicts create no available file receipt", async () => {
  const cancelledBytes = Buffer.from("cancelled transfer fixture");
  const cancelled = await createOffer(cancelledBytes, "cancelled", false);
  const cancelledStart = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "begin_host_file_transfer",
    arguments: {
      offer_id: cancelled.receipt.offer_id,
      transfer_capability: "exact_signed_put_v1",
      file_name: "cancelled.md",
      claimed_media_type: "text/markdown",
      byte_size: cancelledBytes.length,
      sha256: cancelled.sha256,
      idempotency_key: "cancelled-transfer",
    },
  });
  assert.equal(cancelledStart.payload.result.isError, true);

  const threatBytes = Buffer.from("threat transfer fixture");
  const threat = await createOffer(threatBytes, "threat");
  const started = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "begin_host_file_transfer",
    arguments: {
      offer_id: threat.receipt.offer_id,
      transfer_capability: "exact_signed_put_v1",
      file_name: "threat.md",
      claimed_media_type: "text/markdown",
      byte_size: threatBytes.length,
      sha256: threat.sha256,
      idempotency_key: "threat-transfer",
    },
  });
  const intent = started.payload.result.structuredContent;
  const versionId = store.stage(threatBytes, "threat-staging-version");
  store.stagingScan = "threats_found";
  const denied = await callMcp(mcpBaseUrl, accessToken, "tools/call", {
    name: "finalize_host_file_transfer",
    arguments: {
      offer_id: threat.receipt.offer_id,
      intent_id: intent.intent_id,
      storage_version_id: versionId,
    },
  });
  assert.equal(denied.payload.result.isError, true);
  assert.match(denied.payload.result.content[0].text, /could not be accepted/i);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM host_file_save_transfer_completions WHERE offer_id = ?",
      )
      .get(threat.receipt.offer_id).count,
    0,
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM host_file_save_transfer_availability WHERE offer_id = ?",
      )
      .get(threat.receipt.offer_id).count,
    0,
  );
});
