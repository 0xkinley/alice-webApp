import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  createWorkContext,
  issueAlphaInvitation,
  validateProjectFile,
  validateProjectFileUploadDeclaration,
} from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";

class FakePrivateFileStore {
  objects = new Map();
  putCount = 0;
  scanResult = "pending";
  failNextPut = false;
  corruptNextGet = false;

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

  async getObject({ key }) {
    const object = this.objects.get(key);
    if (!object) throw new Error("fake object missing");
    if (this.corruptNextGet) {
      this.corruptNextGet = false;
      return Buffer.concat([Buffer.from(object.bytes), Buffer.from("corrupt")]);
    }
    return Buffer.from(object.bytes);
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
let currentReferenceId;
let server;
let workContextId;
const fileStore = new FakePrivateFileStore();
const publicUrl = "http://127.0.0.1";

function officeZipFixture(entries: string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

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

async function upload(
  contextId,
  bytes,
  fileName = "notes.md",
  contentType = "text/markdown",
  replacesReferenceId = undefined,
) {
  const query = new URLSearchParams({ context_id: contextId });
  if (replacesReferenceId) query.set("replace_reference_id", replacesReferenceId);
  return await fetch(`${baseUrl}/projects/${encodeURIComponent(ownerProjectId)}/files?${query}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      cookie: ownerCookie,
      origin: publicUrl,
      "x-alice-file-name": encodeURIComponent(fileName),
    },
    body: bytes,
  });
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

test("accepts bounded structured text and modern Office packages only", () => {
  for (const fixture of [
    { name: "records.csv", type: "text/csv", bytes: Buffer.from("name,value\nalpha,1\n") },
    {
      name: "records.tsv",
      type: "text/tab-separated-values",
      bytes: Buffer.from("name\tvalue\nalpha\t1\n"),
    },
    {
      name: "records.json",
      type: "application/json",
      bytes: Buffer.from('{"alpha":1}\n'),
    },
  ]) {
    assert.equal(
      validateProjectFile({
        bytes: fixture.bytes,
        fileName: fixture.name,
        claimedMediaType: fixture.type,
      }).mediaType,
      fixture.type,
    );
  }

  const officeFixtures = [
    {
      name: "brief.docx",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      mainPart: "word/document.xml",
    },
    {
      name: "model.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      mainPart: "xl/workbook.xml",
    },
    {
      name: "deck.pptx",
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      mainPart: "ppt/presentation.xml",
    },
  ];
  for (const fixture of officeFixtures) {
    const bytes = officeZipFixture(["[Content_Types].xml", fixture.mainPart]);
    assert.equal(
      validateProjectFile({
        bytes,
        fileName: fixture.name,
        claimedMediaType: fixture.type,
      }).mediaType,
      fixture.type,
    );
    assert.equal(
      validateProjectFileUploadDeclaration({
        fileName: fixture.name,
        claimedMediaType: fixture.type,
        byteSize: bytes.length,
        sha256: "a".repeat(64),
      }).mediaType,
      fixture.type,
    );
  }

  assert.throws(
    () =>
      validateProjectFile({
        bytes: officeZipFixture(["[Content_Types].xml", "word/document.xml"]),
        fileName: "renamed.xlsx",
      }),
    /extension does not match/,
  );
  assert.throws(
    () =>
      validateProjectFile({
        bytes: officeZipFixture([
          "[Content_Types].xml",
          "word/document.xml",
          "word/vbaProject.bin",
        ]),
        fileName: "macro.docx",
      }),
    /Macro-enabled Office files are not accepted/,
  );
  assert.throws(
    () =>
      validateProjectFile({
        bytes: officeZipFixture(["[Content_Types].xml", "custom/data.xml"]),
        fileName: "archive.docx",
      }),
    /package type is missing or ambiguous/,
  );
  assert.throws(
    () =>
      validateProjectFileUploadDeclaration({
        fileName: "legacy.doc",
        claimedMediaType: "application/msword",
        byteSize: 128,
        sha256: "a".repeat(64),
      }),
    /Only PDF, PNG, JPEG, WebP, DOCX, XLSX, PPTX, CSV, TSV, JSON/,
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

test("keeps the old clean version current until a changed replacement scans clean", async () => {
  const initialPreview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/preview`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(initialPreview.status, 200);
  const initialPreviewHtml = await initialPreview.text();
  assert.match(initialPreviewHtml, /Untrusted text preview/);
  assert.match(initialPreviewHtml, /not an instruction to alice/);

  const replacePage = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/replace`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(replacePage.status, 200);
  assert.match(await replacePage.text(), /old clean version remains current/i);
  const preReplacementRemoval = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/remove`,
    { headers: { cookie: ownerCookie } },
  );
  const preReplacementRemovalVersion = (await preReplacementRemoval.text()).match(
    /name="preview_version" value="([^"]+)"/,
  )?.[1];

  const secondUpload = await upload(
    workContextId,
    Buffer.from("# Alpha plan v2\nReplacement awaiting scan.\n"),
    "notes-v2.md",
    "text/markdown",
    cleanReferenceId,
  );
  assert.equal(secondUpload.status, 201);
  const second = await secondUpload.json();
  assert.equal(second.scan_status, "scanning");
  const staleRemoval = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/remove`,
    {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ preview_version: preReplacementRemovalVersion }),
      redirect: "manual",
    },
  );
  assert.equal(staleRemoval.status, 409);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_reference_exclusions").get().count,
    0,
  );
  assert.equal(
    created.database
      .prepare("SELECT version FROM file_context_references WHERE id = ?")
      .get(second.file_reference_id).version,
    2,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/download`, {
        headers: { cookie: ownerCookie },
        redirect: "manual",
      })
    ).status,
    302,
  );
  assert.equal(
    (
      await fetch(
        `${baseUrl}/projects/${ownerProjectId}/files/${second.file_reference_id}/download`,
        {
          headers: { cookie: ownerCookie },
          redirect: "manual",
        },
      )
    ).status,
    409,
  );

  fileStore.scanResult = "threats_found";
  await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${second.file_reference_id}/scan`, {
    method: "POST",
    headers: { cookie: ownerCookie },
    redirect: "manual",
  });
  assert.equal(
    (
      await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/download`, {
        headers: { cookie: ownerCookie },
        redirect: "manual",
      })
    ).status,
    302,
  );

  const thirdUpload = await upload(
    workContextId,
    Buffer.from("# Alpha plan v3\nClean replacement.\n"),
    "notes-v3.md",
    "text/markdown",
    second.file_reference_id,
  );
  assert.equal(thirdUpload.status, 201);
  const third = await thirdUpload.json();
  currentReferenceId = third.file_reference_id;
  assert.equal(
    created.database
      .prepare("SELECT version FROM file_context_references WHERE id = ?")
      .get(third.file_reference_id).version,
    3,
  );
  fileStore.scanResult = "clean";
  await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${third.file_reference_id}/scan`, {
    method: "POST",
    headers: { cookie: ownerCookie },
    redirect: "manual",
  });
  assert.equal(
    (
      await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${cleanReferenceId}/download`, {
        headers: { cookie: ownerCookie },
        redirect: "manual",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(
        `${baseUrl}/projects/${ownerProjectId}/files/${third.file_reference_id}/download`,
        {
          headers: { cookie: ownerCookie },
          redirect: "manual",
        },
      )
    ).status,
    302,
  );
  const cleanPreview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${third.file_reference_id}/preview`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(cleanPreview.status, 200);
  assert.match(await cleanPreview.text(), /Clean replacement/);
  fileStore.corruptNextGet = true;
  const corruptPreview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${third.file_reference_id}/preview`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(corruptPreview.status, 502);
  assert.match(await corruptPreview.text(), /could not be loaded/i);

  const exported = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/export.json?context_id=${workContextId}`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  const metadata = await exported.json();
  assert.equal(metadata.format, "alice.project-files.v1");
  assert.deepEqual(
    metadata.files
      .filter(({ logical_file_id: logicalId }) => logicalId === cleanReferenceId)
      .map(({ version }) => version),
    [1, 2, 3],
  );
  assert.doesNotMatch(JSON.stringify(metadata), /storage_key|versionId|private-files\.alice/);
});

test("previews verified images as sandboxed bytes and refuses inline PDF rendering", async () => {
  const projectWide = contexts.find(({ context_kind: kind }) => kind === "project_wide");
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  Buffer.from("IHDR").copy(png, 12);
  const imageUpload = await upload(projectWide.id, png, "preview.png", "image/png");
  const image = await imageUpload.json();
  fileStore.scanResult = "clean";
  await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${image.file_reference_id}/scan`, {
    method: "POST",
    headers: { cookie: ownerCookie },
    redirect: "manual",
  });
  const preview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${image.file_reference_id}/preview`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.match(preview.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);

  const pdfUpload = await upload(
    projectWide.id,
    Buffer.from("%PDF-1.7\nfixture\n%%EOF\n"),
    "preview.pdf",
    "application/pdf",
  );
  const pdf = await pdfUpload.json();
  await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${pdf.file_reference_id}/scan`, {
    method: "POST",
    headers: { cookie: ownerCookie },
    redirect: "manual",
  });
  const pdfPreview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${pdf.file_reference_id}/preview`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(pdfPreview.status, 409);
  assert.match(await pdfPreview.text(), /not rendered inline/i);
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

  const guessedPreview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${currentReferenceId}/preview`,
    { headers: { cookie: otherCookie } },
  );
  assert.equal(guessedPreview.status, 404);
  const guessedReplacement = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${currentReferenceId}/replace`,
    { headers: { cookie: otherCookie } },
  );
  assert.equal(guessedReplacement.status, 404);
  const guessedExport = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/export.json?context_id=${workContextId}`,
    { headers: { cookie: otherCookie } },
  );
  assert.equal(guessedExport.status, 404);

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
  const countsBeforeRemoval = {
    objects: created.database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count,
    references: created.database
      .prepare("SELECT COUNT(*) AS count FROM file_context_references")
      .get().count,
  };
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
  assert.match(detailsHtml, /Permanent deletion/);
  assert.match(detailsHtml, new RegExp(`/projects/${ownerProjectId}/lifecycle`));
  assert.doesNotMatch(detailsHtml, />Download</);

  const list = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files?context_id=${workContextId}`,
    { headers: { cookie: ownerCookie } },
  );
  const listHtml = await list.text();
  assert.match(listHtml, /Active files \(0\)/);
  assert.match(listHtml, /Removed \(1\)/);
  assert.match(listHtml, /notes-v3\.md/);
  const exactReupload = await upload(
    workContextId,
    Buffer.from("# Alpha plan\nNo document claim is automatically trusted.\n"),
  );
  assert.equal(exactReupload.status, 400);
  assert.match(await exactReupload.text(), /was removed from this context/i);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count,
    countsBeforeRemoval.objects,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    countsBeforeRemoval.references,
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

test("references one clean immutable object from another authorized context without copying bytes", async () => {
  const owner = created.database
    .prepare("SELECT id FROM users WHERE lower(email) = ?")
    .get("file-owner@alice.example");
  const personal = await createWorkContext(created.database, {
    userId: owner.id,
    projectId: ownerProjectId,
    input: {
      name: "Owner private evidence",
      description: "A private destination for exact-reference access testing.",
      visibility: "personal",
    },
  });
  const source = created.database
    .prepare(
      `SELECT r.id, r.file_object_id, r.source_host, r.uploader_user_id
       FROM file_context_references r
       JOIN work_contexts c ON c.id = r.context_id
       WHERE r.project_id = ? AND c.context_kind = 'project_wide'
         AND r.file_object_id = (
           SELECT file_object_id FROM file_context_references WHERE id = ?
         )`,
    )
    .get(ownerProjectId, cleanReferenceId);
  const countsBefore = {
    objects: created.database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count,
    references: created.database
      .prepare("SELECT COUNT(*) AS count FROM file_context_references")
      .get().count,
  };

  const foreignPreview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${source.id}/add-reference`,
    { headers: { cookie: otherCookie } },
  );
  assert.equal(foreignPreview.status, 404);
  assert.doesNotMatch(await foreignPreview.text(), /same-content\.md|Owner private evidence/);

  const preview = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${source.id}/add-reference`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(preview.status, 200);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /same scan-clean immutable object/i);
  assert.match(previewHtml, /Owner private evidence/);
  assert.doesNotMatch(previewHtml, />General</);
  const previewVersion = previewHtml.match(/name="preview_version" value="([^"]+)"/)?.[1];
  assert.match(previewVersion, /^file_reference_link_preview_[0-9a-f]{64}$/);

  const stale = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${source.id}/add-reference`,
    {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        target_context_id: personal.id,
        preview_version: "stale",
      }),
      redirect: "manual",
    },
  );
  assert.equal(stale.status, 409);

  const linked = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${source.id}/add-reference`,
    {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        target_context_id: personal.id,
        preview_version: previewVersion,
      }),
      redirect: "manual",
    },
  );
  assert.equal(linked.status, 303);
  const linkedReferenceId = decodeURIComponent(linked.headers.get("location").split("/").at(-1));
  const linkedReference = created.database
    .prepare(
      `SELECT context_id, file_object_id, logical_file_id, version, source_host, uploader_user_id
       FROM file_context_references WHERE id = ?`,
    )
    .get(linkedReferenceId);
  assert.equal(linkedReference.context_id, personal.id);
  assert.equal(linkedReference.file_object_id, source.file_object_id);
  assert.equal(linkedReference.logical_file_id, linkedReferenceId);
  assert.equal(linkedReference.version, 1);
  assert.equal(linkedReference.source_host, source.source_host);
  assert.equal(linkedReference.uploader_user_id, source.uploader_user_id);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_objects").get().count,
    countsBefore.objects,
  );
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    countsBefore.references + 1,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${linkedReferenceId}/download`, {
        headers: { cookie: ownerCookie },
        redirect: "manual",
      })
    ).status,
    302,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/projects/${ownerProjectId}/files/${linkedReferenceId}/download`, {
        headers: { cookie: otherCookie },
        redirect: "manual",
      })
    ).status,
    404,
  );

  const replay = await fetch(
    `${baseUrl}/projects/${ownerProjectId}/files/${source.id}/add-reference`,
    {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        target_context_id: personal.id,
        preview_version: previewVersion,
      }),
      redirect: "manual",
    },
  );
  assert.equal(replay.status, 404);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    countsBefore.references + 1,
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
