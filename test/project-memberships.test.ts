import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { issueAlphaInvitation } from "@alice/domain";
import { createApp } from "../apps/web/src/app.ts";

let baseUrl;
let created;
let server;
let ownerCookie;
let recipientCookie;
let intruderCookie;
let declinerCookie;
let projectId;

const identities = {
  owner: { email: "membership-owner@alice.example", password: "membership owner private password" },
  recipient: {
    email: "membership-recipient@alice.example",
    password: "membership recipient private password",
  },
  intruder: {
    email: "membership-intruder@alice.example",
    password: "membership intruder private password",
  },
  decliner: {
    email: "membership-decliner@alice.example",
    password: "membership decliner private password",
  },
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

async function createInvitation(email, role = "editor") {
  const response = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/invitations`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, role }),
  });
  const body = await response.text();
  const token = body.match(/alice_project_invite_[A-Za-z0-9_-]+/)?.[0];
  return { response, body, token };
}

before(async () => {
  created = await createApp({
    database: openSqliteTestDatabase(),
    publicUrl: "http://127.0.0.1",
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ownerCookie = await register(identities.owner);
  recipientCookie = await register(identities.recipient);
  intruderCookie = await register(identities.intruder);
  declinerCookie = await register(identities.decliner);

  const createdProject = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Membership safety project",
      brief: "Exact project access fixture.",
    }),
    redirect: "manual",
  });
  assert.equal(createdProject.status, 303);
  projectId = decodeURIComponent(createdProject.headers.get("location").split("/").at(-1));
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  created.database.close();
});

test("every project receives one protected Owner membership", async () => {
  const owner = created.database
    .prepare(
      `SELECT membership.id, membership.role, membership.ended_at
       FROM project_memberships membership
       WHERE membership.project_id = ?`,
    )
    .get(projectId);
  assert.equal(owner.role, "owner");
  assert.equal(owner.ended_at, null);

  assert.throws(() =>
    created.database
      .prepare("UPDATE project_memberships SET role = 'editor' WHERE id = ?")
      .run(owner.id),
  );
  assert.throws(() =>
    created.database.prepare("DELETE FROM project_memberships WHERE id = ?").run(owner.id),
  );
  assert.equal(
    created.database.prepare("SELECT role FROM project_memberships WHERE id = ?").get(owner.id)
      .role,
    "owner",
  );

  const collaborators = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/collaborators`,
    { headers: { cookie: ownerCookie } },
  );
  assert.equal(collaborators.status, 200);
  const html = await collaborators.text();
  assert.match(html, /membership-owner@alice\.example/);
  assert.match(html, /Ownership transfer is atomic/s);
});

test("only the exact invited account can accept a hash-only project invitation", async () => {
  const invitation = await createInvitation(identities.recipient.email, "editor");
  assert.equal(invitation.response.status, 200);
  assert.ok(invitation.token);
  assert.match(invitation.body, /only time alice\. displays this token/i);

  const stored = created.database
    .prepare(
      `SELECT id, token_hash, accepted_at FROM project_invitations
       WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(identities.recipient.email);
  assert.equal(stored.token_hash, createHash("sha256").update(invitation.token).digest("hex"));
  assert.notEqual(stored.token_hash, invitation.token);

  const signedOut = await fetch(
    `${baseUrl}/project-invitations/${encodeURIComponent(invitation.token)}`,
    { redirect: "manual" },
  );
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.headers.get("location"), null);
  assert.doesNotMatch(await signedOut.text(), new RegExp(invitation.token));

  const duplicate = await createInvitation(identities.recipient.email, "viewer");
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.body, /pending invitation already exists/i);

  const intruderPreview = await fetch(
    `${baseUrl}/project-invitations/${encodeURIComponent(invitation.token)}`,
    { headers: { cookie: intruderCookie } },
  );
  assert.equal(intruderPreview.status, 404);
  assert.doesNotMatch(await intruderPreview.text(), /Membership safety|recipient@/);
  const intruderAccept = await fetch(
    `${baseUrl}/project-invitations/${encodeURIComponent(invitation.token)}/accept`,
    { method: "POST", headers: { cookie: intruderCookie }, redirect: "manual" },
  );
  assert.equal(intruderAccept.status, 404);
  assert.equal(
    created.database
      .prepare("SELECT COUNT(*) AS count FROM project_memberships WHERE project_id = ?")
      .get(projectId).count,
    1,
  );

  const preview = await fetch(
    `${baseUrl}/project-invitations/${encodeURIComponent(invitation.token)}`,
    { headers: { cookie: recipientCookie } },
  );
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Membership safety project/);
  const accepted = await fetch(
    `${baseUrl}/project-invitations/${encodeURIComponent(invitation.token)}/accept`,
    { method: "POST", headers: { cookie: recipientCookie }, redirect: "manual" },
  );
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), `/projects/${projectId}/access`);
  assert.equal(
    created.database
      .prepare(
        `SELECT membership.role FROM project_memberships membership
         JOIN users ON users.id = membership.user_id
         WHERE membership.project_id = ? AND users.email = ? AND membership.ended_at IS NULL`,
      )
      .get(projectId, identities.recipient.email).role,
    "editor",
  );
  assert.notEqual(
    created.database
      .prepare("SELECT accepted_at FROM project_invitations WHERE id = ?")
      .get(stored.id).accepted_at,
    null,
  );

  const reused = await fetch(
    `${baseUrl}/project-invitations/${encodeURIComponent(invitation.token)}`,
    { headers: { cookie: recipientCookie } },
  );
  assert.equal(reused.status, 404);
  const sharedHome = await fetch(baseUrl, { headers: { cookie: recipientCookie } });
  const sharedHtml = await sharedHome.text();
  assert.match(sharedHtml, /Shared with you/);
  assert.match(sharedHtml, /Membership safety project/);
  assert.match(sharedHtml, /editor/);
});

test("only an Owner can change or end a non-owner membership", async () => {
  const membership = created.database
    .prepare(
      `SELECT membership.id FROM project_memberships membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.project_id = ? AND users.email = ? AND membership.ended_at IS NULL`,
    )
    .get(projectId, identities.recipient.email);
  const denied = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/collaborators/${encodeURIComponent(membership.id)}/role`,
    {
      method: "POST",
      headers: { cookie: intruderCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "viewer" }),
      redirect: "manual",
    },
  );
  assert.equal(denied.status, 404);
  assert.doesNotMatch(await denied.text(), /Membership safety project|recipient@/);

  const changed = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/collaborators/${encodeURIComponent(membership.id)}/role`,
    {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "viewer" }),
      redirect: "manual",
    },
  );
  assert.equal(changed.status, 303);
  assert.equal(
    created.database.prepare("SELECT role FROM project_memberships WHERE id = ?").get(membership.id)
      .role,
    "viewer",
  );

  const removed = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/collaborators/${encodeURIComponent(membership.id)}/remove`,
    { method: "POST", headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(removed.status, 303);
  const ended = created.database
    .prepare("SELECT ended_at, ended_by_user_id FROM project_memberships WHERE id = ?")
    .get(membership.id);
  assert.ok(ended.ended_at);
  assert.ok(ended.ended_by_user_id);
  assert.throws(() =>
    created.database
      .prepare("UPDATE project_memberships SET role = 'editor' WHERE id = ?")
      .run(membership.id),
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/access`, {
        headers: { cookie: recipientCookie },
      })
    ).status,
    404,
  );
});

test("replacement, decline, and revoke preserve invitation history", async () => {
  const original = await createInvitation(identities.decliner.email, "viewer");
  assert.equal(original.response.status, 200);
  const originalRow = created.database
    .prepare("SELECT id FROM project_invitations WHERE token_hash = ?")
    .get(createHash("sha256").update(original.token).digest("hex"));
  const replacement = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(originalRow.id)}/resend`,
    { method: "POST", headers: { cookie: ownerCookie } },
  );
  assert.equal(replacement.status, 200);
  const replacementBody = await replacement.text();
  const replacementToken = replacementBody.match(/alice_project_invite_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(replacementToken);
  assert.notEqual(replacementToken, original.token);
  assert.ok(
    created.database
      .prepare("SELECT revoked_at FROM project_invitations WHERE id = ?")
      .get(originalRow.id).revoked_at,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/project-invitations/${encodeURIComponent(original.token)}`, {
        headers: { cookie: declinerCookie },
      })
    ).status,
    404,
  );

  const declined = await fetch(
    `${baseUrl}/project-invitations/${encodeURIComponent(replacementToken)}/decline`,
    { method: "POST", headers: { cookie: declinerCookie }, redirect: "manual" },
  );
  assert.equal(declined.status, 303);
  assert.equal(
    created.database
      .prepare(
        `SELECT COUNT(*) AS count FROM project_memberships membership
         JOIN users ON users.id = membership.user_id
         WHERE membership.project_id = ? AND users.email = ? AND membership.ended_at IS NULL`,
      )
      .get(projectId, identities.decliner.email).count,
    0,
  );

  const unused = await createInvitation("not-registered@alice.example", "viewer");
  const unusedRow = created.database
    .prepare("SELECT id FROM project_invitations WHERE token_hash = ?")
    .get(createHash("sha256").update(unused.token).digest("hex"));
  const revoked = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(unusedRow.id)}/revoke`,
    { method: "POST", headers: { cookie: ownerCookie }, redirect: "manual" },
  );
  assert.equal(revoked.status, 303);
  assert.ok(
    created.database
      .prepare("SELECT revoked_at FROM project_invitations WHERE id = ?")
      .get(unusedRow.id).revoked_at,
  );

  assert.throws(() => created.database.prepare("DELETE FROM project_invitations").run());
  const auditMetadata = created.database
    .prepare("SELECT action, safe_metadata_json FROM audit_events WHERE action LIKE 'project_%'")
    .all();
  assert.ok(auditMetadata.some(({ action }) => action === "project_invitation_accepted"));
  assert.ok(auditMetadata.some(({ action }) => action === "project_member_removed"));
  for (const event of auditMetadata) {
    assert.doesNotMatch(event.safe_metadata_json, /@alice\.example|alice_project_invite_/);
  }
});
