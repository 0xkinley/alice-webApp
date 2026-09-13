import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity, getProjectDefaultContext } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
let identity;
let server;

const uploadedFixture = Buffer.from("alice workspace upload fixture");

class WorkspacePrivateFileStore {
  uploadOrigins = ["https://alice-private-files.example"];

  async createSignedUpload() {
    return {
      url: "https://alice-private-files.example/staging-upload?signature=component-only",
      headers: { "x-alice-test": "component-only" },
      expiresInSeconds: 600,
    };
  }

  async getScanResult() {
    return "clean";
  }

  async getObject() {
    return uploadedFixture;
  }

  async putObject() {
    return { versionId: "verified-object-version", etag: "fixture-etag" };
  }

  async createSignedDownload() {
    return "https://alice-private-files.example/download";
  }
}

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    fileStore: new WorkspacePrivateFileStore(),
    publicUrl: "http://127.0.0.1",
  });
  identity = await createTestIdentity(created.database, {
    email: "workspace-app@alice.example",
    password: "workspace app private password",
    projectId: "project_workspace_app",
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ({
    tokens: { access_token: accessToken },
  } = await authorize(baseUrl, {
    email: "workspace-app@alice.example",
    password: "workspace app private password",
    clientName: "ChatGPT workspace app test",
  }));
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("advertises portable workspace and Save resources and keeps mutations app-only", async () => {
  const { payload } = await callMcp(baseUrl, accessToken, "tools/list");
  const byName = Object.fromEntries(payload.result.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.open_alice_workspace._meta.ui.resourceUri, "ui://alice/workspace/v3.html");
  assert.deepEqual(byName.open_alice_workspace._meta.ui.visibility, ["model"]);
  assert.equal(
    byName.open_alice_workspace._meta["openai/outputTemplate"],
    "ui://alice/workspace/v3.html",
  );
  for (const name of [
    "alice_workspace_snapshot",
    "alice_create_workspace_project",
    "alice_commit_capture_save",
    "alice_commit_artifact_save",
    "alice_get_save_status",
    "alice_begin_workspace_file_upload",
    "alice_finalize_workspace_file_upload",
    "alice_workspace_file_status",
  ]) {
    assert.deepEqual(byName[name]._meta.ui.visibility, ["app"]);
  }
  for (const removed of [
    "alice_update_context_providers",
    "alice_select_workspace_context",
    "alice_create_workspace_context",
    "alice_attach_workspace_file",
  ]) {
    assert.equal(byName[removed], undefined);
  }

  const resource = await callMcp(baseUrl, accessToken, "resources/read", {
    uri: "ui://alice/workspace/v3.html",
  });
  assert.equal(resource.payload.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.payload.result.contents[0].text, /alice\. workspace/);
  assert.match(resource.payload.result.contents[0].text, /alice_workspace_snapshot/);
  assert.match(resource.payload.result.contents[0].text, /Welcome to alice\./);
  assert.match(resource.payload.result.contents[0].text, /<select id=.?project-select/);
  assert.match(resource.payload.result.contents[0].text, /Now you.*working in/);
  assert.match(resource.payload.result.contents[0].text, /data-view=.files/);
  assert.match(resource.payload.result.contents[0].text, /type=.file. multiple/);
  assert.match(
    resource.payload.result.contents[0].text,
    /cannot automatically pass an already-attached file/,
  );
  assert.match(resource.payload.result.contents[0].text, /Bytes reached Alice staging storage/);
  assert.match(resource.payload.result.contents[0].text, /Retry this file/);
  assert.match(resource.payload.result.contents[0].text, /alice\/privateUpload/);
  assert.match(resource.payload.result.contents[0].text, /Open Alice website fallback/);
  assert.match(resource.payload.result.contents[0].text, /updateModelContext/);
  assert.doesNotMatch(resource.payload.result.contents[0].text, /selected_project:\s*\{\s*id:/);
  assert.doesNotMatch(resource.payload.result.contents[0].text, /class=.?project-card/);
  assert.equal(resource.payload.result.contents[0]._meta.ui.domain, undefined);
  assert.equal(resource.payload.result.contents[0]._meta["openai/widgetDomain"], undefined);
  assert.deepEqual(resource.payload.result.contents[0]._meta.ui.csp.connectDomains, [
    "https://alice-private-files.example",
  ]);
  assert.deepEqual(resource.payload.result.contents[0]._meta["openai/widgetCSP"], {
    connect_domains: ["https://alice-private-files.example"],
    resource_domains: [],
    redirect_domains: ["http://127.0.0.1"],
  });

  const opened = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "open_alice_workspace",
    arguments: {},
  });
  assert.equal(opened.payload.result.structuredContent.contract_version, "alice_workspace_app_v5");
  assert.match(opened.payload.result.content[0].text, /Welcome to alice\./);

  const openedFiles = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "open_alice_workspace",
    arguments: { view: "files" },
  });
  assert.equal(openedFiles.payload.result.structuredContent.initial_view, "files");
  assert.deepEqual(openedFiles.payload.result.structuredContent.selected_project, {
    name: "Private project",
  });
  assert.match(openedFiles.payload.result.content[0].text, /select the exact file there/);

  const saveResource = await callMcp(baseUrl, accessToken, "resources/read", {
    uri: "ui://alice/save/v2.html",
  });
  assert.equal(saveResource.payload.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(saveResource.payload.result.contents[0].text, /alice_commit_capture_save/);
  assert.match(saveResource.payload.result.contents[0].text, /alice_get_save_status/);
  assert.match(saveResource.payload.result.contents[0].text, /Choose what to save/);
  assert.match(saveResource.payload.result.contents[0].text, /Save selected/);
  assert.match(saveResource.payload.result.contents[0].text, /data-claim-index/);
  assert.match(saveResource.payload.result.contents[0].text, /Confirmed receipt/);
  assert.match(saveResource.payload.result.contents[0].text, /alice_confirm_host_files_save/);
  assert.match(saveResource.payload.result.contents[0].text, /<button id=.?save/);
  assert.match(saveResource.payload.result.contents[0].text, /Save all/);
  assert.match(saveResource.payload.result.contents[0].text, /Save these files/);
  assert.match(saveResource.payload.result.contents[0].text, /Continue the exact file transfer/);
  assert.match(saveResource.payload.result.contents[0].text, /data-file-url/);
  assert.match(saveResource.payload.result.contents[0].text, /openLink/);
  assert.match(saveResource.payload.result.contents[0].text, /Authorization alone does not copy/);
  assert.match(
    saveResource.payload.result.contents[0].text,
    /authorized\. Each file becomes available/,
  );
  assert.match(saveResource.payload.result.contents[0].text, /timeZoneName:.?short/);
  assert.doesNotMatch(saveResource.payload.result.contents[0].text, /dateStyle|timeStyle/);
  assert.doesNotMatch(saveResource.payload.result.contents[0].text, />Cancel</);
  assert.doesNotMatch(saveResource.payload.result.contents[0].text, /<pre/i);
});

test("the App uploads exact bytes privately and exposes files only after clean scans", async () => {
  const digest = createHash("sha256").update(uploadedFixture).digest("hex");
  const begun = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_begin_workspace_file_upload",
    arguments: {
      project_id: identity.project_id,
      file_name: "workspace-note.txt",
      claimed_media_type: "text/plain",
      byte_size: uploadedFixture.length,
      sha256: digest,
    },
  });
  assert.equal(begun.payload.result.isError, undefined);
  assert.deepEqual(begun.payload.result.content, []);
  assert.equal(begun.payload.result.structuredContent.status, "ready");
  assert.equal(begun.payload.result.structuredContent.project.name, "Private project");
  assert.equal(
    JSON.stringify(begun.payload.result.structuredContent).includes("signature=component-only"),
    false,
  );
  assert.equal(
    begun.payload.result._meta["alice/privateUpload"].upload_url,
    "https://alice-private-files.example/staging-upload?signature=component-only",
  );

  const finalized = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_finalize_workspace_file_upload",
    arguments: {
      project_id: identity.project_id,
      intent_id: begun.payload.result._meta["alice/privateUpload"].intent_id,
      storage_version_id: "staging-version-1",
    },
  });
  assert.equal(finalized.payload.result.structuredContent.status, "completed");
  assert.equal(finalized.payload.result.structuredContent.scan_status, "scanning");

  const status = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_workspace_file_status",
    arguments: {
      project_id: identity.project_id,
      file_reference_id: finalized.payload.result.structuredContent.file_reference_id,
    },
  });
  assert.equal(status.payload.result.structuredContent.status, "available");

  const context = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: {
      project_id: "Private project",
      task: "List the uploaded files",
      context_budget: 4_000,
    },
  });
  assert.equal(context.payload.result.structuredContent.file_artifacts.length, 1);
  assert.equal(
    context.payload.result.structuredContent.file_artifacts[0].display_name,
    "workspace-note.txt",
  );
  assert.equal(
    context.payload.result.structuredContent.file_artifacts[0].source_host,
    "alice_mcp_app",
  );

  const denied = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_begin_workspace_file_upload",
    arguments: {
      project_id: "project_not_accessible",
      file_name: "guessed.txt",
      claimed_media_type: "text/plain",
      byte_size: uploadedFixture.length,
      sha256: digest,
    },
  });
  assert.equal(denied.payload.result.isError, true);
  assert.equal(denied.payload.result.content[0].text, "The upload destination is unavailable.");
  assert.equal(JSON.stringify(denied.payload.result).includes("Private project"), false);
});

test("project discovery is governed by Alice permissions, not provider toggles", async () => {
  const general = await getProjectDefaultContext(created.database, identity.project_id);
  for (const contextId of [general.id]) {
    const current = created.database
      .prepare(
        `SELECT provider, version FROM context_provider_authorizations
         WHERE user_id = ? AND context_id = ? ORDER BY provider`,
      )
      .all(identity.id, contextId);
    for (const row of current) {
      created.database
        .prepare(
          `UPDATE context_provider_authorizations
           SET enabled = 0, version = ?, updated_at = ?
           WHERE user_id = ? AND context_id = ? AND provider = ?`,
        )
        .run(row.version + 1, new Date().toISOString(), identity.id, contextId, row.provider);
    }
  }

  const discovery = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.deepEqual(
    discovery.payload.result.structuredContent.projects.map(({ name }) => name),
    ["Private project"],
  );
  assert.equal(discovery.payload.result.structuredContent.projects[0].id, undefined);

  const {
    tokens: { access_token: claudeAccessToken },
  } = await authorize(baseUrl, {
    email: "workspace-app@alice.example",
    password: "workspace app private password",
    clientName: "Claude workspace app test",
  });
  const claudeDiscovery = await callMcp(baseUrl, claudeAccessToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.deepEqual(
    claudeDiscovery.payload.result.structuredContent.projects,
    discovery.payload.result.structuredContent.projects,
  );

  const snapshot = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_workspace_snapshot",
    arguments: {},
  });
  assert.equal(snapshot.payload.result.structuredContent.projects[0].id, identity.project_id);
  assert.equal(
    snapshot.payload.result.structuredContent.contract_version,
    "alice_workspace_app_v5",
  );
  assert.equal(
    snapshot.payload.result.structuredContent.projects[0].project_url,
    `http://127.0.0.1/projects/${identity.project_id}`,
  );
  assert.equal(
    snapshot.payload.result.structuredContent.projects[0].files_url,
    `http://127.0.0.1/projects/${identity.project_id}/files`,
  );
  assert.equal(snapshot.payload.result.structuredContent.projects[0].contexts, undefined);
  assert.equal(snapshot.payload.result.structuredContent.routing, undefined);

  const deniedRead = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: {
      project_id: identity.project_id,
      task: "Provider denial",
      context_budget: 4_000,
    },
  });
  assert.equal(deniedRead.payload.result.isError, undefined);

  const beforeCapture = created.database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence,
        (SELECT COUNT(*) FROM candidate_claims) AS candidates`,
    )
    .get();
  const deniedCapture = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: identity.project_id,
      summary: "This permission-governed capture remains preview-only",
      candidate_claims: [
        {
          state_key: "workspace.provider_denial",
          value: true,
          summary: "Provider denial",
        },
      ],
      idempotency_key: "workspace-provider-denial-001",
    },
  });
  assert.equal(deniedCapture.payload.result.isError, undefined);
  assert.deepEqual(
    created.database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM evidence_events) AS evidence,
          (SELECT COUNT(*) FROM candidate_claims) AS candidates`,
      )
      .get(),
    beforeCapture,
  );
});

test("the app creates a name-only project that is immediately discoverable", async () => {
  const beforeRejectedBrief = created.database
    .prepare("SELECT COUNT(*) AS count FROM projects")
    .get().count;
  const rejectedBrief = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_create_workspace_project",
    arguments: {
      name: "Project with removed field",
      brief: "This field is no longer accepted.",
    },
  });
  assert.equal(rejectedBrief.payload.result.isError, true);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM projects").get().count,
    beforeRejectedBrief,
  );

  const createdProject = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_create_workspace_project",
    arguments: {
      name: "MCP App Project",
    },
  });
  assert.equal(createdProject.payload.result.structuredContent.name, "MCP App Project");
  assert.equal(createdProject.payload.result.structuredContent.brief, undefined);
  const projectId = createdProject.payload.result.structuredContent.id;
  const general = await getProjectDefaultContext(created.database, projectId);
  assert.equal(general.visibility, "all_members");

  const discovery = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.ok(
    discovery.payload.result.structuredContent.projects.some(
      ({ name }) => name === "MCP App Project",
    ),
  );

  const projectRequired = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "open_alice_workspace",
    arguments: { view: "files" },
  });
  assert.equal(projectRequired.payload.result.structuredContent.initial_view, "files");
  assert.deepEqual(projectRequired.payload.result.structuredContent.project_required, [
    "MCP App Project",
    "Private project",
  ]);
  assert.equal(projectRequired.payload.result.structuredContent.selected_project, null);

  const unknownProject = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "open_alice_workspace",
    arguments: { view: "files", project_id: "Not a real project" },
  });
  assert.equal(unknownProject.payload.result.isError, true);
  assert.equal(
    unknownProject.payload.result.content[0].text,
    "The named alice. project is unavailable.",
  );
});
