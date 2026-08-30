import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { issueAlphaInvitation, validateProjectFile } from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";

class FakePrivateFileStore {
  objects = new Map();
  putCount = 0;
  scanResult = "pending";
  failNextPut = false;

  async putObject({ key, bytes, mediaType, sha256 }) {
    this.putCount += 1;
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated private storage failure");
    }
    this.objects.set(key, { bytes: Buffer.from(bytes), mediaType, sha256 });
    return { versionId: `version-${this.putCount}`, etag: `etag-${this.putCount}` };
  }

  async getScanResult() {
    return this.scanResult;
  }

  async createSignedDownload({ key, versionId }) {
    assert.ok(this.objects.has(key));
    return `https://private-files.alice.example/${encodeURIComponent(key)}?versionId=${encodeURIComponent(versionId)}&expires=60`;
  }
}

let baseUrl;
let created;
let ownerCookie;
let otherCookie;
let ownerProjectId;
let contexts;
let cleanReferenceId;
let server;
let workContextId;
const fileStore = new FakePrivateFileStore();
const publicUrl = "http://127.0.0.1";

async function register(email, password) {
  const invitation = await issueAlphaInvitation(created.database, { email });
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, invitationToken: invitation.token }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function upload(contextId, bytes, fileName = "notes.md", contentType = "text/markdown") {
  return await fetch(
    `${baseUrl}/projects/${encodeURIComponent(ownerProjectId)}/files?context_id=${encodeURIComponent(contextId)}`,
    {
      method: "POST",
      headers: {
        "content-type": contentType,
        cookie: ownerCookie,
        origin: publicUrl,
        "x-alice-file-name": encodeURIComponent(fileName),
      },
      body: bytes,
    },
  );
}

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    fileStore,
    publicUrl,
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ownerCookie = await register("file-owner@alice.example", "file owner private password");
  otherCookie = await register("file-other@alice.example", "file other private password");
  const createResponse = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "File project", brief: "Private file test." }),
    redirect: "manual",
  });
  ownerProjectId = decodeURIComponent(createResponse.headers.get("location").split("/").at(-1));
  contexts = created.database
    .prepare(
      "SELECT id, context_kind FROM work_contexts WHERE project_id = ? ORDER BY context_kind, id",
    )
    .all(ownerProjectId);
  workContextId = contexts.find(({ context_kind: kind }) => kind === "work").id;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("validates bounded content rather than trusting extensions or claimed media types", () => {
  const markdown = validateProjectFile({
    bytes: Buffer.from("# Verified UTF-8\n"),
    fileName: "../launch\u0000notes.md",
    claimedMediaType: "text/plain; charset=utf-8",
  });
  assert.equal(markdown.displayName, ".._launch_notes.md");
  assert.equal(markdown.mediaType, "text/markdown");
  assert.match(markdown.sha256, /^[0-9a-f]{64}$/);

  assert.throws(
    () =>
      validateProjectFile({
        bytes: Buffer.from("not actually a png"),
        fileName: "claim.png",
        claimedMediaType: "image/png",
      }),
    /Only PDF, PNG, JPEG, WebP/,
  );
  assert.throws(
    () =>
      validateProjectFile({
        bytes: Buffer.from([0xff, 0xfe, 0xfd]),
        fileName: "invalid.txt",
        claimedMediaType: "text/plain",
      }),
    /valid UTF-8/,
  );

  const pdf = validateProjectFile({
    bytes: Buffer.from("%PDF-1.7\nfixture\n%%EOF\n"),
    fileName: "fixture.pdf",
    claimedMediaType: "application/pdf",
  });
  assert.equal(pdf.mediaType, "application/pdf");
  const pngBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBytes);
  Buffer.from("IHDR").copy(pngBytes, 12);
  assert.equal(
    validateProjectFile({ bytes: pngBytes, fileName: "fixture.png" }).mediaType,
    "image/png",
  );
  assert.equal(
    validateProjectFile({
      bytes: Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]),
      fileName: "fixture.jpeg",
    }).mediaType,
    "image/jpeg",
  );
  const webpBytes = Buffer.alloc(12);
  Buffer.from("RIFF").copy(webpBytes);
  webpBytes.writeUInt32LE(4, 4);
  Buffer.from("WEBP").copy(webpBytes, 8);
  assert.equal(
    validateProjectFile({ bytes: webpBytes, fileName: "fixture.webp" }).mediaType,
    "image/webp",
  );
});

test("keeps uploaded bytes unavailable until a clean scan and issues only a short-lived download", async () => {
  const workContext = contexts.find(({ context_kind: kind }) => kind === "work");
  const bytes = Buffer.from("# Alpha plan\nNo document claim is automatically trusted.\n");
  const uploaded = await upload(workContext.id, bytes);
  assert.equal(uploaded.status, 201);
  const receipt = await uploaded.json();
  cleanReferenceId = receipt.file_reference_id;
  assert.equal(receipt.scan_status, "scanning");
  assert.equal(fileStore.putCount, 1);

  const blocked = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${receipt.file_reference_id}/download`,
    { headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(blocked.status, 409);

  fileStore.scanResult = "clean";
  const refreshed = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${receipt.file_reference_id}/scan`,
    { method: "POST", headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(refreshed.status, 303);
  assert.match(refreshed.headers.get("location"), /context_id=/);

  const download = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${receipt.file_reference_id}/download`,
    { headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(download.status, 302);
  assert.match(download.headers.get("location"), /^https:\/\/private-files\.alice\.example\//);
  assert.match(download.headers.get("location"), /expires=60/);
  assert.equal(download.headers.get("cache-control"), "no-store");

  const page = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files?context_id=${workContext.id}`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /notes\.md/);
  assert.match(html, /Ready/);
  assert.match(html, /contents do not become saved assertions/);
});

test("deduplicates exact bytes only inside the workspace while keeping context references distinct", async () => {
  const projectWide = contexts.find(({ context_kind: kind }) => kind === "project_wide");
  const response = await upload(
    projectWide.id,
    Buffer.from("# Alpha plan\nNo document claim is automatically trusted.\n"),
    "same-content.md",
  );
  assert.equal(response.status, 201);
  assert.equal(fileStore.putCount, 1);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count,
    1,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    2,
  );
  const ambiguousType = await upload(
    projectWide.id,
    Buffer.from("# Alpha plan\nNo document claim is automatically trusted.\n"),
    "same-content.txt",
    "text/plain",
  );
  assert.equal(ambiguousType.status, 400);
  assert.equal(fileStore.putCount, 1);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    2,
  );
});

test("foreign identifiers, wrong origins, and malformed file claims fail without disclosure or storage", async () => {
  const reference = created.database
    .prepare("SELECT id FROM file_context_references LIMIT 1")
    .get();
  const guessed = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${reference.id}/download`,
    { headers: { cookie: otherCookie }, redirect: "manual" },
  );
  assert.equal(guessed.status, 404);
  assert.doesNotMatch(await guessed.text(), /notes\.md|Alpha plan/);

  const count = fileStore.putCount;
  const deniedOrigin = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files?context_id=${contexts[0].id}`,
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        cookie: ownerCookie,
        origin: "https://attacker.example",
        "x-alice-file-name": "denied.txt",
      },
      body: "denied",
    },
  );
  assert.equal(deniedOrigin.status, 403);
  assert.equal(fileStore.putCount, count);

  const mismatch = await upload(
    contexts[0].id,
    Buffer.from("plain"),
    "false.pdf",
    "application/pdf",
  );
  assert.equal(mismatch.status, 400);
  assert.equal(fileStore.putCount, count);
});

test("unexpected persistence failures roll back and return no database detail", async () => {
  const beforeObjects = created.database
    .prepare("SELECT COUNT(*) AS count FROM file_objects")
    .get();
  const beforeReferences = created.database
    .prepare("SELECT COUNT(*) AS count FROM file_context_references")
    .get();
  const beforePuts = fileStore.putCount;
  created.database.exec(`
    CREATE TRIGGER file_audit_fixture_failure
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'file_reference_created'
    BEGIN
      SELECT RAISE(ABORT, 'sensitive database fixture detail');
    END;
  `);
  try {
    const failed = await upload(
      contexts[0].id,
      Buffer.from("unique audit rollback fixture"),
      "rollback.txt",
      "text/plain",
    );
    assert.equal(failed.status, 500);
    const body = await failed.text();
    assert.match(body, /could not be completed/i);
    assert.doesNotMatch(body, /sensitive database fixture detail|audit_events/i);
  } finally {
    created.database.exec("DROP TRIGGER file_audit_fixture_failure");
  }
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count,
    beforeObjects.count,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    beforeReferences.count,
  );
  assert.equal(fileStore.putCount, beforePuts);
});

test("threat, scan-failure, and storage-failure outcomes remain unavailable", async () => {
  const context = contexts[0];
  fileStore.scanResult = "threats_found";
  const threatened = await upload(
    context.id,
    Buffer.from("unique threat scan fixture"),
    "threat.txt",
    "text/plain",
  );
  assert.equal(threatened.status, 201);
  const threatReceipt = await threatened.json();
  const refresh = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${threatReceipt.file_reference_id}/scan`,
    { method: "POST", headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(refresh.status, 303);
  const blocked = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${threatReceipt.file_reference_id}/download`,
    { headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(blocked.status, 409);
  assert.equal(
    created.database
      .prepare("SELECT scan_status FROM file_objects WHERE id = ?")
      .get(
        created.database
          .prepare("SELECT file_object_id FROM file_context_references WHERE id = ?")
          .get(threatReceipt.file_reference_id).file_object_id,
      ).scan_status,
    "threats_found",
  );

  fileStore.failNextPut = true;
  const failed = await upload(
    context.id,
    Buffer.from("unique storage failure fixture"),
    "retry.txt",
    "text/plain",
  );
  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /failed before scanning/i);
  assert.equal(
    created.database
      .prepare(
        `SELECT o.scan_status FROM file_objects o
         JOIN file_context_references r ON r.file_object_id = o.id
         WHERE r.display_name = 'retry.txt'`,
      )
      .get().scan_status,
    "storage_failed",
  );

  fileStore.scanResult = "failed";
  const retry = await upload(
    context.id,
    Buffer.from("unique storage failure fixture"),
    "retry.txt",
    "text/plain",
  );
  assert.equal(retry.status, 201);
  const retryReceipt = await retry.json();
  await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${retryReceipt.file_reference_id}/scan`,
    {
      method: "POST",
      headers: { cookie: ownerCookie },
      redirect: "manual",
    },
  );
  assert.equal(
    created.database
      .prepare(
        `SELECT o.scan_status FROM file_objects o
         JOIN file_context_references r ON r.file_object_id = o.id WHERE r.id = ?`,
      )
      .get(retryReceipt.file_reference_id).scan_status,
    "scan_failed",
  );
});

test("an exact human removal disables access without erasing file provenance", async () => {
  const foreignPreview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/remove`,
    { headers: { cookie: otherCookie } },
  );
  assert.equal(foreignPreview.status, 404);
  assert.doesNotMatch(await foreignPreview.text(), /notes\.md|Alpha plan/);

  const preview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/remove`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(preview.status, 200);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /not permanent deletion/i);
  const previewVersion = previewHtml.match(/name="preview_version" value="([^"]+)"/)?.[1];
  assert.match(previewVersion, /^file_removal_preview_[0-9a-f]{64}$/);

  const stale = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/remove`,
    {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ preview_version: "stale", reason: "Wrong preview" }),
      redirect: "manual",
    },
  );
  assert.equal(stale.status, 409);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_reference_exclusions").get().count,
    0,
  );

  const removed = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/remove`,
    {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        preview_version: previewVersion,
        reason: "No longer active in this context",
      }),
      redirect: "manual",
    },
  );
  assert.equal(removed.status, 303);
  assert.match(removed.headers.get("location"), /context_id=/);

  const download = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/download`,
    { headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(download.status, 404);
  const details = await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(details.status, 200);
  const detailsHtml = await details.text();
  assert.match(detailsHtml, /Removed from active context/);
  assert.match(detailsHtml, /No longer active in this context/);
  assert.match(detailsHtml, /not permanent erasure/i);
  assert.doesNotMatch(detailsHtml, />Download</);

  const list = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files?context_id=${workContextId}`,
    { headers: { cookie: ownerCookie } },
  );
  const listHtml = await list.text();
  assert.match(listHtml, /Active files \(0\)/);
  assert.match(listHtml, /Removed \(1\)/);
  assert.match(listHtml, /notes\.md/);
  const exactReupload = await upload(
    workContextId,
    Buffer.from("# Alpha plan\nNo document claim is automatically trusted.\n"),
  );
  assert.equal(exactReupload.status, 400);
  assert.match(await exactReupload.text(), /was removed from this context/i);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count,
    3,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    4,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_reference_exclusions").get().count,
    1,
  );
  assert.throws(
    () =>
      created.database.prepare("UPDATE file_reference_exclusions SET reason = 'rewritten'").run(),
    /immutable/,
  );
  assert.throws(
    () => created.database.prepare("DELETE FROM file_reference_exclusions").run(),
    /immutable/,
  );
});

test("audit metadata omits display names, content hashes, and object-storage keys", () => {
  const audits = created.database
    .prepare("SELECT safe_metadata_json FROM audit_events WHERE action LIKE 'file_%'")
    .all();
  assert.ok(audits.length >= 3);
  for (const audit of audits) {
    assert.doesNotMatch(audit.safe_metadata_json, /notes\.md|same-content|objects\/|[0-9a-f]{64}/);
  }
});
