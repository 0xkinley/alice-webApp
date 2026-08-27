import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMcpConfig, loadWebConfig } from "@alice/config";
import { findingsForText } from "../scripts/check-secrets.mjs";

test("loads bounded server-only configuration for both deployables", () => {
  const mcp = loadMcpConfig({
    ALICE_PUBLIC_URL: "https://mcp.alice.example",
    ALICE_WEB_URL: "https://app.alice.example",
    PORT: "9000",
  });
  assert.equal(mcp.port, 9000);
  assert.equal(mcp.publicUrl, "https://mcp.alice.example");
  assert.equal(mcp.reviewUrl, "https://app.alice.example");

  const web = loadWebConfig({
    ALICE_WEB_URL: "http://127.0.0.1:8788",
  });
  assert.equal(web.publicUrl, "http://127.0.0.1:8788");
  assert.equal(web.port, 8788);
});

test("rejects insecure server configuration", () => {
  assert.throws(
    () =>
      loadMcpConfig({
        ALICE_PUBLIC_URL: "http://mcp.alice.example",
      }),
    /HTTPS/i,
  );
});

test("secret detector flags credentials and browser-public secret names", () => {
  const githubToken = `gh${"p"}_${"a".repeat(40)}`;
  assert.deepEqual(findingsForText("fixture.txt", githubToken), [
    "fixture.txt: possible GitHub token",
  ]);
  const publicSecret = ["VITE_PROVIDER", "TOKEN"].join("_");
  assert.deepEqual(findingsForText("fixture.env", `${publicSecret}=placeholder`), [
    "fixture.env: secret-like configuration uses a browser-public prefix",
  ]);
  assert.deepEqual(findingsForText("safe.txt", "ALICE_PUBLIC_URL=https://alice.example"), []);
});
