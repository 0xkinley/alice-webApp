import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity, getProjectDefaultContext } from "./helpers.ts";

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
    "alice_create_workspace_project",
    "alice_commit_capture_save",
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
    discovery.payload.result.structuredContent.projects.map(({ id }) => id),
    [identity.project_id],
  );

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
  assert.ok(discovery.payload.result.structuredContent.projects.some(({ id }) => id === projectId));
});
