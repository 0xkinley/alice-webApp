import assert from "node:assert/strict";
import { test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import { alphaInvitationForToken } from "@alice/domain";
import { invitationOperatorResponse } from "../scripts/alpha-invitation-operator.mjs";

function createTestOperator() {
  const database = openSqliteTestDatabase();
  return {
    database,
    request: (request) =>
      invitationOperatorResponse({
        database,
        request,
        webUrl: new URL("https://web.alice.example"),
      }),
  };
}

test("the direct-invoke operator issues one no-store invitation response", async (context) => {
  const operator = createTestOperator();
  context.after(() => operator.database.close());

  const response = await operator.request({
    method: "POST",
    url: "/invite",
    contentType: "application/json",
    body: JSON.stringify({ email: "Friend@Alice.Example" }),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.body;
  assert.equal(body.email, "friend@alice.example");
  const invitationUrl = new URL(body.invitation_url);
  assert.equal(invitationUrl.origin, "https://web.alice.example");
  assert.equal(invitationUrl.pathname, "/auth/register");
  const token = invitationUrl.searchParams.get("invite");
  assert.ok(token);
  assert.equal((await alphaInvitationForToken(operator.database, token))?.email, body.email);
});

test("the operator rejects non-invitation and over-broad requests", async (context) => {
  const operator = createTestOperator();
  context.after(() => operator.database.close());

  const notFound = await operator.request({ method: "GET", url: "/health", body: "" });
  assert.equal(notFound.statusCode, 404);
  const wrongMethod = await operator.request({ method: "GET", url: "/invite", body: "" });
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
  const unexpectedField = await operator.request({
    method: "POST",
    url: "/invite",
    contentType: "application/json",
    body: JSON.stringify({ email: "friend@alice.example", role: "admin" }),
  });
  assert.equal(unexpectedField.statusCode, 400);
  assert.deepEqual(unexpectedField.body, {
    error: "Only an email address may be supplied.",
  });
});
