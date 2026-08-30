import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMcpConfig, loadWebConfig } from "@alice/config";
import { findingsForText } from "../scripts/check-secrets.mjs";

test("loads bounded server-only configuration for both deployables", () => {
  const mcp = loadMcpConfig({
    ALICE_PUBLIC_URL: "https://mcp.alice.example",
    ALICE_WEB_URL: "https://app.alice.example",
    ALICE_DATABASE_URL: "postgresql://alice:test@database.example/alice?sslmode=require",
    PORT: "9000",
  });
  assert.equal(mcp.port, 9000);
  assert.equal(mcp.publicUrl, "https://mcp.alice.example");
  assert.equal(mcp.reviewUrl, "https://app.alice.example");
  assert.equal(mcp.fileStorage, null);

  const mcpWithFiles = loadMcpConfig({
    ALICE_PUBLIC_URL: "https://mcp.alice.example",
    ALICE_WEB_URL: "https://app.alice.example",
    ALICE_DATABASE_URL: "postgresql://alice:test@database.example/alice?sslmode=require",
    ALICE_FILE_STORAGE: "aws_s3",
    ALICE_S3_BUCKET: "alice-private-files",
    ALICE_S3_REGION: "eu-central-1",
  });
  assert.deepEqual(mcpWithFiles.fileStorage, {
    provider: "aws_s3",
    bucket: "alice-private-files",
    region: "eu-central-1",
  });

  const web = loadWebConfig({
    ALICE_WEB_URL: "http://127.0.0.1:8788",
    ALICE_MCP_URL: "https://mcp.alice.example",
    ALICE_DATABASE_URL: "postgresql://alice:test@127.0.0.1/alice",
  });
  assert.equal(web.publicUrl, "http://127.0.0.1:8788");
  assert.equal(web.mcpPublicUrl, "https://mcp.alice.example");
  assert.equal(web.port, 8788);
  assert.equal(web.fileStorage, null);

  const webWithFiles = loadWebConfig({
    ALICE_WEB_URL: "https://app.alice.example",
    ALICE_MCP_URL: "https://mcp.alice.example",
    ALICE_DATABASE_URL: "postgresql://alice:test@database.example/alice?sslmode=require",
    ALICE_FILE_STORAGE: "aws_s3",
    ALICE_S3_BUCKET: "alice-private-files",
    ALICE_S3_REGION: "eu-central-1",
  });
  assert.deepEqual(webWithFiles.fileStorage, {
    provider: "aws_s3",
    bucket: "alice-private-files",
    region: "eu-central-1",
  });
});

test("rejects insecure server configuration", () => {
  assert.throws(
    () =>
      loadMcpConfig({
        ALICE_PUBLIC_URL: "http://mcp.alice.example",
        ALICE_DATABASE_URL: "postgresql://alice:test@database.example/alice?sslmode=require",
      }),
    /HTTPS/i,
  );
  assert.throws(
    () =>
      loadWebConfig({
        ALICE_WEB_URL: "https://app.alice.example",
        ALICE_DATABASE_URL: "postgresql://alice:test@database.example/alice?sslmode=require",
        ALICE_S3_BUCKET: "partially-configured-bucket",
      }),
    /ALICE_FILE_STORAGE/,
  );
  assert.throws(
    () =>
      loadMcpConfig({
        ALICE_PUBLIC_URL: "https://mcp.alice.example",
        ALICE_DATABASE_URL: "postgresql://alice:test@database.example/alice?sslmode=require",
        ALICE_S3_REGION: "eu-central-1",
      }),
    /ALICE_FILE_STORAGE/,
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
