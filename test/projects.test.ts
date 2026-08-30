import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { issueAlphaInvitation } from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";

let baseUrl;
let created;
let ownerCookie;
let ownerProjectId;
let server;

const owner = {
  email: "project-owner@alice.example",
  password: "project owner private password",
};

async function register(identity) {
  const invitation = await issueAlphaInvitation(created.database, { email: identity.email });
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...identity, invitationToken: invitation.token }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ownerCookie = await register(owner);
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("creates and revisits a project in the authenticated private workspace", async () => {
  const createResponse = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: {
      cookie: ownerCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: "Launch Plan", brief: "Plan the private alpha." }),
    redirect: "manual",
  });
  assert.equal(createResponse.status, 303);
  const location = createResponse.headers.get("location");
  assert.match(location, /^\/projects\/project_/);
  ownerProjectId = decodeURIComponent(location.split("/").at(-1));

  const detail = await fetch(`${baseUrl}${location}`, { headers: { cookie: ownerCookie } });
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Plan the private alpha\./);
  assert.match(detailHtml, /Project-wide/);
  assert.match(detailHtml, /General/);
  assert.match(detailHtml, /Preview host package/);

  const projectWidePreview = await fetch(`${baseUrl}${location}/context-preview`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(projectWidePreview.status, 200);

  const generalContext = created.database
    .prepare(
      `SELECT id FROM work_contexts
       WHERE project_id = ? AND context_kind = 'work' AND name = 'General'`,
    )
    .get(ownerProjectId);
  const receiptsBeforePreview = created.database
    .prepare("SELECT COUNT(*) AS count FROM context_read_events")
    .get().count;
  const packagePreview = await fetch(`${baseUrl}${location}/context-preview`, {
    method: "POST",
    headers: {
      cookie: ownerCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      context_id: generalContext.id,
      task: "Plan the private alpha",
      context_budget: "16000",
    }),
  });
  assert.equal(packagePreview.status, 200);
  const packageHtml = await packagePreview.text();
  assert.match(packageHtml, /Exact host package preview/);
  assert.match(packageHtml, /does not create a host-read receipt/);
  assert.match(packageHtml, /&quot;version&quot;/);
  assert.match(packageHtml, /&quot;freshness&quot;/);
  assert.equal(
    created.database.prepare("SELECT COUNT(*) AS count FROM context_read_events").get().count,
    receiptsBeforePreview,
  );

  const preview = await fetch(`${baseUrl}${location}/contexts/preview`, {
    method: "POST",
    headers: {
      cookie: ownerCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Launch planning",
      description: "Plan launch positioning and rollout.",
    }),
  });
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Confirm new work context/);

  const createContext = await fetch(`${baseUrl}${location}/contexts`, {
    method: "POST",
    headers: {
      cookie: ownerCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Launch planning",
      description: "Plan launch positioning and rollout.",
    }),
    redirect: "manual",
  });
  assert.equal(createContext.status, 303);
  assert.match(createContext.headers.get("location"), /#context_/);

  const similar = await fetch(`${baseUrl}${location}/contexts/preview`, {
    method: "POST",
    headers: {
      cookie: ownerCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Launch plan",
      description: "Prepare rollout positioning.",
    }),
  });
  assert.equal(similar.status, 200);
  assert.match(await similar.text(), /Similar contexts/);
  assert.match(
    await (await fetch(`${baseUrl}${location}`, { headers: { cookie: ownerCookie } })).text(),
    /Launch planning/,
  );

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...owner, next: "/" }),
    redirect: "manual",
  });
  const revisitingCookie = login.headers.get("set-cookie").split(";")[0];
  const workspace = await fetch(baseUrl, { headers: { cookie: revisitingCookie } });
  assert.equal(workspace.status, 200);
  const workspaceHtml = await workspace.text();
  assert.match(workspaceHtml, new RegExp(ownerProjectId));
  assert.match(workspaceHtml, /Alpha signals/);
  const signals = await fetch(`${baseUrl}/signals`, { headers: { cookie: revisitingCookie } });
  assert.equal(signals.status, 200);
  const signalsHtml = await signals.text();
  assert.match(signalsHtml, /Private alpha signals/);
  assert.match(signalsHtml, /cannot observe host turns where the host never called alice/);
  assert.match(signalsHtml, /do not inspect prompts, model responses, candidate values/);
});

test("does not reveal a guessed project identifier to another user", async () => {
  const otherCookie = await register({
    email: "other-project-owner@alice.example",
    password: "other project owner private password",
  });
  const guessed = await fetch(`${baseUrl}/projects/${encodeURIComponent(ownerProjectId)}`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(guessed.status, 404);
  assert.doesNotMatch(await guessed.text(), /Launch Plan|private alpha/);

  const guessedContext = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(ownerProjectId)}/contexts`,
    {
      method: "POST",
      headers: {
        cookie: otherCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ name: "Stolen", description: "Must not be created." }),
      redirect: "manual",
    },
  );
  assert.equal(guessedContext.status, 404);

  const createSameName = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: {
      cookie: otherCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: "Launch Plan", brief: "Another private project." }),
    redirect: "manual",
  });
  assert.equal(createSameName.status, 303);
  assert.equal(created.database.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 2);
});
