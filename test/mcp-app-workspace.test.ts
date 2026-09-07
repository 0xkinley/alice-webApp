import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { setContextProviderAvailability } from "@alice/domain";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity } from "./helpers.ts";

let accessToken;
let baseUrl;
let created;
let identity;
let server;

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
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
  assert.equal(byName.open_alice_workspace._meta.ui.resourceUri, "ui://alice/workspace/v1.html");
  assert.deepEqual(byName.open_alice_workspace._meta.ui.visibility, ["model"]);
  assert.equal(
    byName.open_alice_workspace._meta["openai/outputTemplate"],
    "ui://alice/workspace/v1.html",
  );
  for (const name of [
    "alice_workspace_snapshot",
    "alice_update_context_providers",
    "alice_select_workspace_context",
    "alice_create_workspace_project",
    "alice_create_workspace_context",
    "alice_attach_workspace_file",
    "alice_commit_capture_save",
  ]) {
    assert.deepEqual(byName[name]._meta.ui.visibility, ["app"]);
  }

  const resource = await callMcp(baseUrl, accessToken, "resources/read", {
    uri: "ui://alice/workspace/v1.html",
  });
  assert.equal(resource.payload.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.payload.result.contents[0].text, /alice\. workspace/);
  assert.match(resource.payload.result.contents[0].text, /alice_workspace_snapshot/);

  const saveResource = await callMcp(baseUrl, accessToken, "resources/read", {
    uri: "ui://alice/save/v1.html",
  });
  assert.equal(saveResource.payload.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(saveResource.payload.result.contents[0].text, /alice_commit_capture_save/);
  assert.doesNotMatch(saveResource.payload.result.contents[0].text, />Cancel</);
});

test("provider availability is independent, deny-by-default, and filters discovery", async () => {
  const general = created.database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE project_id = ? AND context_kind = 'work' AND name = 'General'`,
    )
    .get(identity.project_id);
  const projectWide = created.database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE project_id = ? AND context_kind = 'project_wide'`,
    )
    .get(identity.project_id);
  for (const contextId of [general.id, projectWide.id]) {
    const current = created.database
      .prepare(
        `SELECT provider, version FROM context_provider_authorizations
         WHERE user_id = ? AND context_id = ? ORDER BY provider`,
      )
      .all(identity.id, contextId);
    const versions = Object.fromEntries(current.map((row) => [row.provider, row.version]));
    const changed = await setContextProviderAvailability(created.database, {
      userId: identity.id,
      projectId: identity.project_id,
      contextId,
      chatgpt: false,
      claude: true,
      expectedVersions: versions,
    });
    assert.equal(changed.conflict, false);
  }

  const discovery = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.deepEqual(discovery.payload.result.structuredContent.projects, []);

  const snapshot = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_workspace_snapshot",
    arguments: {},
  });
  assert.equal(snapshot.payload.result.structuredContent.projects[0].id, identity.project_id);
  assert.equal(
    snapshot.payload.result.structuredContent.projects[0].contexts[0].provider_availability.chatgpt,
    false,
  );
  assert.equal(snapshot.payload.result.structuredContent.routing.scope, "connection");
  assert.match(snapshot.payload.result.structuredContent.routing.warning, /every conversation/);

  const deniedRead = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "get_project_context",
    arguments: {
      project_id: identity.project_id,
      context_id: general.id,
      task: "Provider denial",
      context_budget: 4_000,
    },
  });
  assert.equal(deniedRead.payload.result.isError, true);

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
      summary: "This provider-disabled capture must not persist",
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
  assert.equal(deniedCapture.payload.result.isError, true);
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

test("the app creates human/provider-scoped work and selects only an enabled provider", async () => {
  const createdProject = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_create_workspace_project",
    arguments: {
      name: "MCP App Project",
      brief: "Created from exact in-chat settings.",
      context_visibility: "personal",
      chatgpt: true,
      claude: false,
    },
  });
  assert.equal(createdProject.payload.result.structuredContent.name, "MCP App Project");
  const projectId = createdProject.payload.result.structuredContent.id;
  const general = created.database
    .prepare(
      `SELECT id, visibility FROM work_contexts
       WHERE project_id = ? AND context_kind = 'work' AND name = 'General'`,
    )
    .get(projectId);
  assert.equal(general.visibility, "personal");

  const selected = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_select_workspace_context",
    arguments: {
      project_id: projectId,
      context_id: general.id,
      expected_selection_version: null,
    },
  });
  assert.equal(selected.payload.result.structuredContent.context_id, general.id);

  const createdContext = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_create_workspace_context",
    arguments: {
      project_id: projectId,
      name: "Friends",
      description: "Visible to selected project members.",
      visibility: "selected_members",
      chatgpt: false,
      claude: true,
    },
  });
  assert.equal(createdContext.payload.result.structuredContent.visibility, "selected_members");
  const deniedSelection = await callMcp(baseUrl, accessToken, "tools/call", {
    name: "alice_select_workspace_context",
    arguments: {
      project_id: projectId,
      context_id: createdContext.payload.result.structuredContent.id,
      expected_selection_version: selected.payload.result.structuredContent.selection_version,
    },
  });
  assert.equal(deniedSelection.payload.result.isError, true);
});
