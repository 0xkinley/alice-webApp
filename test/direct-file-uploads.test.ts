import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  ProjectFileUserError,
  createProject,
  createProjectFileUploadIntent,
  createUserSession,
  finalizeProjectFileUpload,
} from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";

class DirectUploadStore {
  objects = new Map<string, { bytes: Buffer; versionId: string }>();
  signedKey = "";
  scanResult = "pending" as "pending" | "clean" | "threats_found";
  getCount = 0;
  putCount = 0;

  async createSignedUpload({ key, expiresInSeconds }) {
    this.signedKey = key;
    return {
      url: `https://private-files.alice.example/${encodeURIComponent(key)}`,
      headers: { "x-alice-test": "signed" },
      expiresInSeconds,
    };
  }

  stage(bytes: Buffer, versionId = "staging-version-1") {
    this.objects.set(this.signedKey, { bytes: Buffer.from(bytes), versionId });
    return versionId;
  }

  async putObject({ key, bytes }) {
    this.putCount += 1;
    const versionId = `final-version-${this.putCount}`;
    this.objects.set(key, { bytes: Buffer.from(bytes), versionId });
    return { versionId, etag: `etag-${this.putCount}` };
  }

  async getScanResult({ key, versionId }) {
    const object = this.objects.get(key);
    if (!object || object.versionId !== versionId) throw new Error("staged object missing");
    return this.scanResult;
  }

  async getObject({ key, versionId }) {
    this.getCount += 1;
    const object = this.objects.get(key);
    if (!object || object.versionId !== versionId) throw new Error("staged object missing");
    return Buffer.from(object.bytes);
  }

  async createSignedDownload() {
    return "https://private-files.alice.example/download";
  }
}

function addPrivateWorkspace(database, userId: string, workspaceId: string, email: string) {
  const now = new Date().toISOString();
  database
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, email, "test-password-hash", now);
  database
    .prepare("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
    .run(workspaceId, userId, "Private workspace", now);
}

test("direct upload intents preserve the scan and immutable-reference boundary", async () => {
  const database = openSqliteTestDatabase();
  const store = new DirectUploadStore();
  try {
    addPrivateWorkspace(database, "user_owner", "workspace_owner", "owner@alice.example");
    addPrivateWorkspace(database, "user_other", "workspace_other", "other@alice.example");
    const project = await createProject(database, "user_owner", {
      name: "Direct upload project",
    });
    const context = database
      .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND context_kind = 'work'")
      .get(project.id);
    const bytes = Buffer.from("# Direct upload\nHost bytes are not alice.-verified.\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const intent = await createProjectFileUploadIntent(database, store, {
      userId: "user_owner",
      projectId: project.id,
      contextId: context.id,
      fileName: "alpha.md",
      claimedMediaType: "text/markdown",
      byteSize: bytes.length,
      sha256,
    });
    assert.match(intent.intent_id, /^file_upload_/);
    assert.equal(intent.upload_headers["x-alice-test"], "signed");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
      0,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE file_upload_intents SET display_name = ? WHERE id = ?")
          .run("changed.md", intent.intent_id),
      /immutable/,
    );

    const versionId = store.stage(bytes);
    assert.equal(
      await finalizeProjectFileUpload(database, store, {
        userId: "user_other",
        projectId: project.id,
        intentId: intent.intent_id,
        storageVersionId: versionId,
      }),
      undefined,
    );
    const pending = await finalizeProjectFileUpload(database, store, {
      userId: "user_owner",
      projectId: project.id,
      intentId: intent.intent_id,
      storageVersionId: versionId,
    });
    assert.deepEqual(pending, { status: "pending" });
    assert.equal(store.getCount, 0, "staging bytes must not be read before a clean scan");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
      0,
    );

    store.scanResult = "clean";
    const completed = await finalizeProjectFileUpload(database, store, {
      userId: "user_owner",
      projectId: project.id,
      intentId: intent.intent_id,
      storageVersionId: versionId,
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.scan_status, "scanning");
    assert.equal(store.getCount, 1);
    assert.equal(store.putCount, 1);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM file_upload_completions").get().count,
      1,
    );

    const replayed = await finalizeProjectFileUpload(database, store, {
      userId: "user_owner",
      projectId: project.id,
      intentId: intent.intent_id,
      storageVersionId: "ignored-after-completion",
    });
    assert.deepEqual(replayed, completed);
    assert.equal(store.getCount, 1);
    assert.equal(store.putCount, 1);

    const mismatchIntent = await createProjectFileUploadIntent(database, store, {
      userId: "user_owner",
      projectId: project.id,
      contextId: context.id,
      fileName: "mismatch.txt",
      claimedMediaType: "text/plain",
      byteSize: 8,
      sha256: createHash("sha256").update("declared").digest("hex"),
    });
    const mismatchVersion = store.stage(Buffer.from("tampered"), "staging-version-2");
    await assert.rejects(
      finalizeProjectFileUpload(database, store, {
        userId: "user_owner",
        projectId: project.id,
        intentId: mismatchIntent.intent_id,
        storageVersionId: mismatchVersion,
      }),
      (error) =>
        error instanceof ProjectFileUserError &&
        /does not match its immutable upload intent/.test(error.message),
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM file_upload_completions").get().count,
      1,
    );

    const threatBytes = Buffer.from("threat fixture");
    const threatIntent = await createProjectFileUploadIntent(database, store, {
      userId: "user_owner",
      projectId: project.id,
      contextId: context.id,
      fileName: "threat.txt",
      claimedMediaType: "text/plain",
      byteSize: threatBytes.length,
      sha256: createHash("sha256").update(threatBytes).digest("hex"),
    });
    const threatVersion = store.stage(threatBytes, "staging-version-3");
    store.scanResult = "threats_found";
    await assert.rejects(
      finalizeProjectFileUpload(database, store, {
        userId: "user_owner",
        projectId: project.id,
        intentId: threatIntent.intent_id,
        storageVersionId: threatVersion,
      }),
      /could not be accepted/,
    );
    assert.equal(store.getCount, 2, "threat-marked staging bytes must never be read");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test("direct upload HTTP routes require the authenticated exact origin", async () => {
  const database = openSqliteTestDatabase();
  const store = new DirectUploadStore();
  let server;
  try {
    addPrivateWorkspace(database, "user_route", "workspace_route", "route@alice.example");
    const project = await createProject(database, "user_route", {
      name: "Route upload project",
    });
    const context = database
      .prepare("SELECT id FROM work_contexts WHERE project_id = ? AND context_kind = 'work'")
      .get(project.id);
    const session = await createUserSession(database, "user_route");
    const publicUrl = "http://127.0.0.1";
    const created = await createApp({ database, fileStore: store, publicUrl });
    server = created.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const cookie = `alice_session=${encodeURIComponent(session.token)}`;
    const home = await fetch(baseUrl, { headers: { cookie } });
    const homeHtml = await home.text();
    assert.match(homeHtml, /await uploadDirect\(files\[index\],createdProject\)/);
    assert.doesNotMatch(homeHtml, /await uploadLegacy\(files\[index\],createdProject\)/);
    const bytes = Buffer.from("route fixture");
    const body = {
      context_id: context.id,
      file_name: "route.txt",
      claimed_media_type: "text/plain",
      byte_size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };

    const denied = await fetch(`${baseUrl}/projects/${project.id}/files/direct/intents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(denied.status, 403);

    const started = await fetch(`${baseUrl}/projects/${project.id}/files/direct/intents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: publicUrl },
      body: JSON.stringify(body),
    });
    assert.equal(started.status, 201);
    assert.equal(started.headers.get("cache-control"), "no-store");
    const intent = await started.json();
    const versionId = store.stage(bytes, "route-staging-version");

    const pending = await fetch(
      `${baseUrl}/projects/${project.id}/files/direct/intents/${intent.intent_id}/finalize`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: publicUrl },
        body: JSON.stringify({ storage_version_id: versionId }),
      },
    );
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { status: "pending" });

    const page = await fetch(`${baseUrl}/projects/${project.id}/files?context_id=${context.id}`, {
      headers: { cookie },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /files\/direct\/intents/);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    database.close();
  }
});
