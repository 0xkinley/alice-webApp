import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createS3PrivateFileStore, createS3ProjectErasureStore } from "@alice/private-files";

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
    assert.deepEqual(store.uploadOrigins, [
      "https://alice-private-files-test.s3.eu-central-1.amazonaws.com",
    ]);
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
    assert.equal(query["x-amz-checksum-sha256"], undefined);
    assert.equal(query["x-amz-meta-alice-sha256"], undefined);
    assert.deepEqual(
      new Set((url.searchParams.get("X-Amz-SignedHeaders") || "").split(";")),
      new Set([
        "content-type",
        "host",
        "x-amz-checksum-sha256",
        "x-amz-meta-alice-sha256",
        "x-amz-server-side-encryption",
      ]),
    );
  } finally {
    if (previousAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previousAccessKey;
    if (previousSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousSecret;
  }
});

test("project erasure inventories and deletes only exact immutable S3 versions", async () => {
  const versions = new Map([
    [
      "objects/exact",
      [
        { Key: "objects/exact", VersionId: "version-2" },
        { Key: "objects/exact", VersionId: "version-1" },
      ],
    ],
    ["objects/exact-other", [{ Key: "objects/exact-other", VersionId: "foreign-version" }]],
  ]);
  const markers = new Map([
    ["objects/exact", [{ Key: "objects/exact", VersionId: "delete-marker-1" }]],
  ]);
  const client = {
    async send(command) {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        const key = command.input.Prefix;
        return {
          Versions: [...(versions.get(key) || []), ...(versions.get(`${key}-other`) || [])],
          DeleteMarkers: markers.get(key) || [],
          IsTruncated: false,
        };
      }
      if (command.constructor.name === "DeleteObjectsCommand") {
        for (const item of command.input.Delete.Objects) {
          versions.set(
            item.Key,
            (versions.get(item.Key) || []).filter(({ VersionId }) => VersionId !== item.VersionId),
          );
          markers.set(
            item.Key,
            (markers.get(item.Key) || []).filter(({ VersionId }) => VersionId !== item.VersionId),
          );
        }
        return { Errors: [] };
      }
      throw new Error("unexpected command");
    },
  };
  const store = createS3ProjectErasureStore({
    bucket: "alice-private-files-test",
    region: "eu-central-1",
    client,
  });
  const inventory = await store.inventory(["objects/exact"]);
  assert.deepEqual(inventory, [
    { key: "objects/exact", versionId: "delete-marker-1", deleteMarker: true },
    { key: "objects/exact", versionId: "version-1", deleteMarker: false },
    { key: "objects/exact", versionId: "version-2", deleteMarker: false },
  ]);
  assert.deepEqual(await store.erase(["objects/exact"], inventory), { deletedVersions: 3 });
  assert.deepEqual(await store.inventory(["objects/exact"]), []);
  assert.equal(versions.get("objects/exact-other").length, 1);
  await assert.rejects(store.inventory(["public/not-permitted"]), /invalid private object key/);
});
