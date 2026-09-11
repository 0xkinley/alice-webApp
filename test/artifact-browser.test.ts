import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  commitArtifactSavePreview,
  createArtifactSavePreview,
  createUserSession,
} from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";
import { createTestIdentity } from "./helpers.ts";

class FakePrivateFileStore {
  objects = new Map();

  async putObject({ key, bytes, mediaType, sha256 }) {
    this.objects.set(key, { bytes: Buffer.from(bytes), mediaType, sha256 });
    return { versionId: `version-${this.objects.size}`, etag: `etag-${this.objects.size}` };
  }

  async getScanResult() {
    return "clean";
  }

  async getObject({ key }) {
    return Buffer.from(this.objects.get(key).bytes);
  }

  async createSignedDownload({ key, versionId }) {
    return `https://private-files.alice.example/${encodeURIComponent(key)}?versionId=${encodeURIComponent(versionId)}`;
  }
}

let artifactId;
let baseUrl;
let cookie;
let database;
let foreignCookie;
let identity;
let revokedCookie;
let server;
const fileStore = new FakePrivateFileStore();
const publicUrl = "http://127.0.0.1";

function snapshot({ title, artifactType, category, tags, content, idempotencyKey }) {
  return {
    project_id: identity.project_id,
    title,
    artifact_type: artifactType,
    category,
    tags,
    content,
    handoff: {
      goal: "Continue the exact cross-host work product.",
      summary: "A <b>saved</b> handoff summary.",
      decisions: ["Keep the evidence visible", "Use the bounded vocabulary"],
      constraints: ["Do not treat AI output as verified"],
      rejected_directions: [
        { direction: "Hide provenance", reason: "The source must remain visible" },
      ],
      open_questions: ["Which example should lead?"],
      next_steps: ["Review the current version"],
      relevant_context: ["This came from an explicit Save"],
    },
    idempotency_key: idempotencyKey,
  };
}

async function saveArtifact({ provider, payload, artifactId: existingArtifactId, now }) {
  const connection = database
    .prepare(
      `SELECT connection.id, connection.client_id
       FROM integration_connections connection
       WHERE connection.user_id = ? AND connection.client_classification = ?`,
    )
    .get(identity.id, provider);
  const prepared = await createArtifactSavePreview(database, {
    userId: identity.id,
    connectionId: connection.id,
    clientId: connection.client_id,
    publicUrl,
    payload,
    ...(existingArtifactId ? { artifactId: existingArtifactId } : {}),
    now,
  });
  assert.ok(!("error" in prepared));
  return await commitArtifactSavePreview(database, {
    previewId: prepared.preview.preview_id,
    previewVersion: prepared.preview.preview_version,
    userId: identity.id,
    authority: "web_session",
    now,
  });
}

before(async () => {
  database = openSqliteTestDatabase();
  identity = await createTestIdentity(database, {
    email: "artifact-browser-owner@alice.example",
    password: "artifact browser owner password",
    projectId: "project_artifact_browser",
  });
  const foreign = await createTestIdentity(database, {
    email: "artifact-browser-foreign@alice.example",
    password: "artifact browser foreign password",
    projectId: "project_artifact_browser_foreign",
  });
  const revocableMember = await createTestIdentity(database, {
    email: "artifact-browser-member@alice.example",
    password: "artifact browser member password",
    projectId: "project_artifact_browser_member",
  });
  const createdAt = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO project_memberships
        (id, workspace_id, project_id, user_id, role, created_by_user_id, created_at, updated_at)
       VALUES ('membership_artifact_browser_member', ?, ?, ?, 'viewer', ?, ?, ?)`,
    )
    .run(
      identity.workspace_id,
      identity.project_id,
      revocableMember.id,
      identity.id,
      createdAt,
      createdAt,
    );
  for (const [provider, clientId] of [
    ["chatgpt", "artifact-browser-chatgpt"],
    ["claude", "artifact-browser-claude"],
  ]) {
    database
      .prepare(
        `INSERT INTO oauth_clients
          (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
         VALUES (?, ?, '[]', 'none', ?)`,
      )
      .run(clientId, `${provider} artifact browser fixture`, createdAt);
    database
      .prepare(
        `INSERT INTO integration_connections
          (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
           first_connected_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, 'mcp:read mcp:write', ?, ?)`,
      )
      .run(
        `connection-${provider}-artifact-browser`,
        identity.id,
        identity.workspace_id,
        clientId,
        provider,
        createdAt,
        createdAt,
      );
  }

  const current = new Date();
  const versionOne = new Date(current.getTime() - 10 * 24 * 60 * 60 * 1_000);
  const first = await saveArtifact({
    provider: "chatgpt",
    payload: snapshot({
      title: "Cross-host launch narrative",
      artifactType: "article",
      category: "content",
      tags: ["content", "research", "audience"],
      content: "Version one opening.",
      idempotencyKey: "artifact-browser-v1",
    }),
    now: versionOne,
  });
  artifactId = first.artifact_id;
  await saveArtifact({
    provider: "claude",
    artifactId,
    payload: snapshot({
      title: "Cross-host launch narrative",
      artifactType: "article",
      category: "content",
      tags: ["content", "research", "audience"],
      content: 'Version two opening.\n<script>alert("artifact")</script>\nFinal & exact line.',
      idempotencyKey: "artifact-browser-v2",
    }),
    now: current,
  });
  await saveArtifact({
    provider: "chatgpt",
    payload: snapshot({
      title: "Archived campaign email",
      artifactType: "email_draft",
      category: "marketing",
      tags: ["campaign", "messaging"],
      content: "An older complete email draft.",
      idempotencyKey: "artifact-browser-old",
    }),
    now: new Date(current.getTime() - 400 * 24 * 60 * 60 * 1_000),
  });

  const ownerSession = await createUserSession(database, identity.id);
  const foreignSession = await createUserSession(database, foreign.id);
  const revocableSession = await createUserSession(database, revocableMember.id);
  cookie = `alice_session=${encodeURIComponent(ownerSession.token)}`;
  foreignCookie = `alice_session=${encodeURIComponent(foreignSession.token)}`;
  revokedCookie = `alice_session=${encodeURIComponent(revocableSession.token)}`;
  const created = await createApp({ database, fileStore, publicUrl });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const upload = await fetch(`${baseUrl}/projects/${identity.project_id}/files`, {
    method: "POST",
    headers: {
      "content-type": "text/markdown",
      cookie,
      origin: publicUrl,
      "x-alice-file-name": encodeURIComponent("upload-not-an-artifact.md"),
    },
    body: "# Uploaded file\n",
  });
  assert.equal(upload.status, 201, await upload.clone().text());
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  database.close();
});

test("the project has a separate clickable Artifacts tab and result list", async () => {
  const project = await fetch(`${baseUrl}/projects/${identity.project_id}`, {
    headers: { cookie },
  });
  const projectHtml = await project.text();
  assert.match(projectHtml, new RegExp(`/projects/${identity.project_id}/artifacts`));
  assert.match(projectHtml, />Artifacts<\/a>/);

  const response = await fetch(`${baseUrl}/projects/${identity.project_id}/artifacts`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /aria-current="page"[^>]*>Artifacts<\/a>/);
  assert.match(html, />Change log<\/a>/);
  assert.match(html, />Files<\/a>/);
  assert.match(html, /Search artifacts/);
  assert.match(html, /Category/);
  assert.match(html, /Tag/);
  assert.match(html, /Source AI/);
  assert.match(html, /Time period/);
  assert.doesNotMatch(html, /name="type"|All artifact types/);
  assert.match(
    html,
    new RegExp(
      `/projects/${identity.project_id}/artifacts/${artifactId}[^"]*">Cross-host launch narrative`,
    ),
  );
  assert.match(html, /Archived campaign email/);
  assert.match(html, /Uploaded files remain in the separate Files tab/);
  assert.doesNotMatch(html, /upload-not-an-artifact\.md/);

  const files = await fetch(`${baseUrl}/projects/${identity.project_id}/files`, {
    headers: { cookie },
  });
  const filesHtml = await files.text();
  assert.match(filesHtml, /upload-not-an-artifact\.md/);
  assert.doesNotMatch(filesHtml, /Cross-host launch narrative/);
});

test("search and every requested filter combine over current artifact metadata", async () => {
  const query = new URLSearchParams({
    q: "cross-host",
    category: "content",
    tag: "research",
    source: "claude",
    period: "past_7_days",
  });
  const response = await fetch(`${baseUrl}/projects/${identity.project_id}/artifacts?${query}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /1 result/);
  assert.match(html, /Cross-host launch narrative/);
  assert.doesNotMatch(html, /Archived campaign email/);
  assert.match(html, /value="content" selected/);
  assert.match(html, /value="research" selected/);
  assert.match(html, /value="claude" selected/);
  assert.match(html, /value="past_7_days" selected/);

  const none = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts?source=chatgpt&period=past_7_days`,
    { headers: { cookie } },
  );
  const noneHtml = await none.text();
  assert.match(noneHtml, /No artifacts found/);
  assert.doesNotMatch(noneHtml, /Cross-host launch narrative|Archived campaign email/);

  const invalid = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts?tag=host-invented-tag`,
    { headers: { cookie } },
  );
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Choose filters shown in the artifact browser/);
});

test("the current artifact safely renders full content and complete handoff information", async () => {
  const response = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts/${artifactId}`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /Current artifact/);
  assert.match(html, /Version 2 of 2/);
  assert.match(html, /Version two opening/);
  assert.match(html, /&lt;script&gt;alert\(&quot;artifact&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\("artifact"\)<\/script>/);
  assert.match(html, /Saved after human confirmation, not verified by alice/);
  assert.match(html, /Continue the exact cross-host work product/);
  assert.match(html, /A saved handoff summary/);
  assert.match(html, /Keep the evidence visible/);
  assert.match(html, /Do not treat AI output as verified/);
  assert.match(html, /Hide provenance/);
  assert.match(html, /The source must remain visible/);
  assert.match(html, /Which example should lead/);
  assert.match(html, /Review the current version/);
  assert.match(html, /This came from an explicit Save/);
  assert.doesNotMatch(html, /content_sha256|storage_key|source_connection_id|tags_json/);
});

test("version history links to and renders one exact immutable older version", async () => {
  const response = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts/${artifactId}?version=1`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Earlier artifact version/);
  assert.match(html, /Version 1 of 2/);
  assert.match(html, /You are viewing version 1/);
  assert.match(html, /Version one opening/);
  assert.doesNotMatch(html, /Version two opening/);
  assert.ok(
    html.includes(
      `/projects/${identity.project_id}/artifacts/${artifactId}?version=1" aria-current="page"`,
    ),
  );
  assert.match(html, />Version 2 · Current</);

  const missing = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts/${artifactId}?version=99`,
    { headers: { cookie } },
  );
  assert.equal(missing.status, 404);
});

test("list and detail requests reauthorize and disclose nothing for inaccessible references", async () => {
  const unauthenticated = await fetch(`${baseUrl}/projects/${identity.project_id}/artifacts`, {
    redirect: "manual",
  });
  assert.equal(unauthenticated.status, 303);
  assert.match(unauthenticated.headers.get("location"), /^\/auth\/login/);

  const foreignList = await fetch(`${baseUrl}/projects/${identity.project_id}/artifacts`, {
    headers: { cookie: foreignCookie },
  });
  const guessedList = await fetch(`${baseUrl}/projects/project_guessed/artifacts`, {
    headers: { cookie: foreignCookie },
  });
  assert.equal(foreignList.status, 404);
  assert.equal(guessedList.status, 404);
  assert.equal(await foreignList.text(), await guessedList.text());

  const foreignDetail = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts/${artifactId}`,
    { headers: { cookie: foreignCookie } },
  );
  const guessedDetail = await fetch(
    `${baseUrl}/projects/project_guessed/artifacts/artifact_guessed`,
    { headers: { cookie: foreignCookie } },
  );
  const ownerGuessedDetail = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts/artifact_guessed`,
    { headers: { cookie } },
  );
  assert.equal(foreignDetail.status, 404);
  assert.equal(guessedDetail.status, 404);
  assert.equal(ownerGuessedDetail.status, 404);
  const guessedDetailBody = await guessedDetail.text();
  assert.equal(await foreignDetail.text(), guessedDetailBody);
  assert.equal(await ownerGuessedDetail.text(), guessedDetailBody);

  const beforeRevocation = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts/${artifactId}`,
    { headers: { cookie: revokedCookie } },
  );
  assert.equal(beforeRevocation.status, 200);
  const endedAt = new Date().toISOString();
  database
    .prepare(
      `UPDATE project_memberships
       SET ended_at = ?, ended_by_user_id = ?, updated_at = ?
       WHERE id = 'membership_artifact_browser_member' AND ended_at IS NULL`,
    )
    .run(endedAt, identity.id, endedAt);
  const listAfterRevocation = await fetch(`${baseUrl}/projects/${identity.project_id}/artifacts`, {
    headers: { cookie: revokedCookie },
  });
  const detailAfterRevocation = await fetch(
    `${baseUrl}/projects/${identity.project_id}/artifacts/${artifactId}`,
    { headers: { cookie: revokedCookie } },
  );
  assert.equal(listAfterRevocation.status, 404);
  assert.equal(detailAfterRevocation.status, 404);
  assert.equal(await listAfterRevocation.text(), guessedDetailBody);
  assert.equal(await detailAfterRevocation.text(), guessedDetailBody);
});
