import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../apps/web/src/app.ts";

let baseUrl;
let created;
let server;

const email = "Owner@Alice.Example";
const password = "a sufficiently long private password";

before(async () => {
  created = createApp({ databaseFilename: ":memory:", publicUrl: "http://127.0.0.1" });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("registers one user and atomically provisions one private workspace", async () => {
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^alice_session=/);

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
  const duplicate = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: email.toLowerCase(), password }),
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
