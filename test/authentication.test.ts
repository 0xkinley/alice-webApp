import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { issueAlphaInvitation } from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";

let baseUrl;
let created;
let invitationToken;
let server;

const email = "Owner@Alice.Example";
const password = "a sufficiently long private password";

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  invitationToken = (await issueAlphaInvitation(created.database, { email })).token;
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("requires a live single-email alpha invitation", async () => {
  const missing = await fetch(`${baseUrl}/auth/register`);
  assert.equal(missing.status, 403);
  assert.match(await missing.text(), /invite-only/);

  const registration = await fetch(
    `${baseUrl}/auth/register?invite=${encodeURIComponent(invitationToken)}`,
  );
  assert.equal(registration.status, 200);
  const html = await registration.text();
  assert.match(html, /owner@alice\.example/i);
  assert.match(html, /name="email"[^>]*readonly/);
  assert.equal(
    created.database.prepare("SELECT accepted_at FROM alpha_invitations").get().accepted_at,
    null,
  );

  const mismatch = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "different@alice.example",
      password,
      invitationToken,
    }),
    redirect: "manual",
  });
  assert.equal(mismatch.status, 400);
  assert.equal(created.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("registers one user and atomically provisions one private workspace", async () => {
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, invitationToken }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^alice_session=/);
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM alpha_invitations WHERE accepted_at IS NOT NULL")
      .get().count,
    1,
  );

  const user = created.database.prepare("SELECT * FROM users").get();
  assert.equal(user.email, email.toLowerCase());
  assert.doesNotMatch(user.password_hash, new RegExp(password));
  assert.match(user.password_hash, /^scrypt-v1\$/);
  const workspaces = created.database
    .prepare("SELECT * FROM workspaces WHERE user_id = ?")
    .all(user.id);
  assert.equal(workspaces.length, 1);

  const home = await fetch(baseUrl, { headers: { cookie } });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Private workspace/);
  assert.match(html, /owner@alice\.example/);
});

test("rejects duplicate identities and invalid credentials", async () => {
  const duplicateInvitation = await issueAlphaInvitation(created.database, { email });
  const duplicate = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: email.toLowerCase(),
      password,
      invitationToken: duplicateInvitation.token,
    }),
    redirect: "manual",
  });
  assert.equal(duplicate.status, 400);
  assert.equal(created.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  assert.equal(created.database.prepare("SELECT COUNT(*) AS count FROM workspaces").get().count, 1);

  const denied = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "wrong password" }),
    redirect: "manual",
  });
  assert.equal(denied.status, 403);
});

test("revisits the same workspace after signing in again", async () => {
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, next: "/" }),
    redirect: "manual",
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const home = await fetch(baseUrl, { headers: { cookie } });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /owner@alice\.example/);
  assert.equal(created.database.prepare("SELECT COUNT(*) AS count FROM workspaces").get().count, 1);
});
