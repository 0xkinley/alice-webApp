import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "@alice/database";
import { createProject, createUserSession, registerUser, revokeUserSession } from "@alice/domain";

test("appends safe audit history for identity, session, and project actions", () => {
  const database = openDatabase(":memory:");
  const password = "audit history private password";
  const user = registerUser(database, { email: "audit@alice.example", password });
  const session = createUserSession(database, user.id);
  const project = createProject(database, user.id, {
    name: "Audited project",
    brief: "Verify append-only history.",
  });
  revokeUserSession(database, session.token);

  const events = database
    .prepare(
      `SELECT action, workspace_id, project_id, safe_metadata_json
       FROM audit_events ORDER BY created_at, id`,
    )
    .all();
  assert.deepEqual(events.map(({ action }) => action).sort(), [
    "project_created",
    "user_registered",
    "user_session_created",
    "user_session_revoked",
  ]);
  assert.equal(
    events.every(({ workspace_id }) => workspace_id === user.workspace_id),
    true,
  );
  assert.equal(events.find(({ action }) => action === "project_created").project_id, project.id);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /audit@alice\.example/);
  assert.doesNotMatch(serialized, new RegExp(password));
  assert.doesNotMatch(serialized, /alice_session_/);
  database.close();
});

test("database guards reject audit mutation and deletion", () => {
  const database = openDatabase(":memory:");
  const user = registerUser(database, {
    email: "immutable-audit@alice.example",
    password: "immutable audit private password",
  });
  assert.ok(user);
  assert.throws(
    () => database.prepare("UPDATE audit_events SET action = 'rewritten'").run(),
    /audit events are append-only/,
  );
  assert.throws(
    () => database.prepare("DELETE FROM audit_events").run(),
    /audit events are append-only/,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 1);
  database.close();
});
