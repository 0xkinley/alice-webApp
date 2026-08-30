import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createS3PrivateFileStore } from "@alice/private-files";

test("S3 direct uploads bind checksum, metadata, encryption, and expiry", async () => {
  const previousAccessKey = process.env.AWS_ACCESS_KEY_ID;
  const previousSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = "alice-test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "alice-test-secret-key";
  try {
    const store = createS3PrivateFileStore({
      bucket: "alice-private-files-test",
      region: "eu-central-1",
    });
    assert.ok(store.createSignedUpload);
    const sha256 = createHash("sha256").update("signed upload fixture").digest("hex");
    const signed = await store.createSignedUpload({
      key: "staging/fixture",
      byteSize: 21,
      mediaType: "text/plain",
      sha256,
      expiresInSeconds: 600,
    });
    assert.equal(signed.expiresInSeconds, 600);
    assert.equal(signed.headers["content-type"], "text/plain");
    assert.equal(
      signed.headers["x-amz-checksum-sha256"],
      Buffer.from(sha256, "hex").toString("base64"),
    );
    assert.equal(signed.headers["x-amz-meta-alice-sha256"], sha256);
    assert.equal(signed.headers["x-amz-server-side-encryption"], "AES256");
    const url = new URL(signed.url);
    const query = Object.fromEntries(
      [...url.searchParams.entries()].map(([name, value]) => [name.toLowerCase(), value]),
    );
    assert.equal(url.hostname, "alice-private-files-test.s3.eu-central-1.amazonaws.com");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
    assert.equal(query["x-amz-checksum-sha256"], signed.headers["x-amz-checksum-sha256"]);
    assert.equal(query["x-amz-meta-alice-sha256"], sha256);
    assert.match(url.searchParams.get("X-Amz-SignedHeaders") || "", /x-amz-server-side-encryption/);
  } finally {
    if (previousAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previousAccessKey;
    if (previousSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousSecret;
  }
});
