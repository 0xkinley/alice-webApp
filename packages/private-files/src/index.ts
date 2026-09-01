import {
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PrivateFileStore, ProviderScanResult } from "@alice/domain";

const SCAN_TAG = "GuardDutyMalwareScanStatus";
export const PROJECT_ERASURE_KEY_LIMIT = 10_000;
export const PROJECT_ERASURE_VERSION_LIMIT = 50_000;

export type ProjectErasureObjectVersion = Readonly<{
  key: string;
  versionId: string;
  deleteMarker: boolean;
}>;

function validatedErasureKeys(keys: string[]): string[] {
  const unique = [...new Set(keys)].sort();
  if (unique.length > PROJECT_ERASURE_KEY_LIMIT) {
    throw new Error("The project erasure key inventory exceeds its operator limit.");
  }
  if (unique.some((key) => !/^(?:objects|staging)\/[0-9A-Za-z._/-]{1,500}$/.test(key))) {
    throw new Error("The project erasure inventory contains an invalid private object key.");
  }
  return unique;
}

export function createS3ProjectErasureStore({
  bucket,
  region,
  client = new S3Client({ region }),
}: {
  bucket: string;
  region: string;
  client?: Pick<S3Client, "send">;
}) {
  async function inventory(inputKeys: string[]): Promise<ProjectErasureObjectVersion[]> {
    const keys = validatedErasureKeys(inputKeys);
    const versions: ProjectErasureObjectVersion[] = [];
    for (const key of keys) {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      let complete = false;
      while (!complete) {
        const result: any = await client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: key,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        );
        for (const item of [
          ...(result.Versions || []).map((version) => ({ ...version, deleteMarker: false })),
          ...(result.DeleteMarkers || []).map((version) => ({ ...version, deleteMarker: true })),
        ]) {
          if (item.Key !== key || !item.VersionId) continue;
          versions.push({ key, versionId: item.VersionId, deleteMarker: item.deleteMarker });
          if (versions.length > PROJECT_ERASURE_VERSION_LIMIT) {
            throw new Error("The project erasure version inventory exceeds its operator limit.");
          }
        }
        if (!result.IsTruncated) {
          complete = true;
          continue;
        }
        if (!result.NextKeyMarker || !result.NextVersionIdMarker) {
          throw new Error("Private object storage returned an incomplete version cursor.");
        }
        if (result.NextKeyMarker === keyMarker && result.NextVersionIdMarker === versionIdMarker) {
          throw new Error("Private object storage repeated a version cursor.");
        }
        keyMarker = result.NextKeyMarker;
        versionIdMarker = result.NextVersionIdMarker;
      }
    }
    return versions.sort(
      (left, right) =>
        left.key.localeCompare(right.key) ||
        left.versionId.localeCompare(right.versionId) ||
        Number(left.deleteMarker) - Number(right.deleteMarker),
    );
  }

  return {
    inventory,
    async erase(
      keys: string[],
      versions: ProjectErasureObjectVersion[],
    ): Promise<{ deletedVersions: number }> {
      const exactKeys = validatedErasureKeys(keys);
      const permittedKeys = new Set(exactKeys);
      if (
        versions.length > PROJECT_ERASURE_VERSION_LIMIT ||
        versions.some(
          ({ key, versionId }) =>
            !permittedKeys.has(key) || typeof versionId !== "string" || !versionId,
        )
      ) {
        throw new Error("The project erasure version inventory is invalid.");
      }
      for (let offset = 0; offset < versions.length; offset += 1_000) {
        const batch = versions.slice(offset, offset + 1_000);
        const result: any = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Quiet: true,
              Objects: batch.map(({ key, versionId }) => ({ Key: key, VersionId: versionId })),
            },
          }),
        );
        if (result.Errors?.length) {
          throw new Error("Private object storage did not erase every requested object version.");
        }
      }
      if ((await inventory(exactKeys)).length !== 0) {
        throw new Error("Private object version reconciliation found retained project bytes.");
      }
      return { deletedVersions: versions.length };
    },
  };
}

function contentDisposition(displayName: string): string {
  const encoded = encodeURIComponent(displayName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="alice-file"; filename*=UTF-8''${encoded}`;
}

export function createS3PrivateFileStore({
  bucket,
  region,
}: {
  bucket: string;
  region: string;
}): PrivateFileStore {
  const client = new S3Client({ region });
  return {
    async createSignedUpload({ key, mediaType, sha256, expiresInSeconds }) {
      const checksum = Buffer.from(sha256, "hex").toString("base64");
      const headers = {
        "content-type": mediaType,
        "x-amz-checksum-sha256": checksum,
        "x-amz-meta-alice-sha256": sha256,
        "x-amz-server-side-encryption": "AES256",
      };
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ChecksumSHA256: checksum,
          ContentType: mediaType,
          Metadata: { "alice-sha256": sha256 },
          ServerSideEncryption: "AES256",
        }),
        {
          expiresIn: expiresInSeconds,
          signableHeaders: new Set(["content-type"]),
          unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-alice-sha256"]),
        },
      );
      return { url, headers, expiresInSeconds };
    },

    async putObject({ key, bytes, mediaType, sha256 }) {
      const result = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: mediaType,
          Metadata: { "alice-sha256": sha256 },
          ServerSideEncryption: "AES256",
        }),
      );
      if (!result.VersionId) {
        throw new Error("The private file bucket must have versioning enabled.");
      }
      return { versionId: result.VersionId, etag: result.ETag || null };
    },

    async getScanResult({ key, versionId }): Promise<ProviderScanResult> {
      const result = await client.send(
        new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
      );
      const status = result.TagSet?.find(({ Key }) => Key === SCAN_TAG)?.Value;
      const statuses: Record<string, ProviderScanResult> = {
        ACCESS_DENIED: "failed",
        FAILED: "failed",
        NO_THREATS_FOUND: "clean",
        THREATS_FOUND: "threats_found",
        UNSUPPORTED: "unsupported",
      };
      return statuses[String(status)] || "pending";
    },

    async getObject({ key, versionId }) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
      );
      if (!result.Body) throw new Error("Private object storage returned no body.");
      return Buffer.from(await result.Body.transformToByteArray());
    },

    async createSignedDownload({ key, versionId, displayName, mediaType, expiresInSeconds }) {
      return await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: versionId,
          ResponseContentDisposition: contentDisposition(displayName),
          ResponseContentType: mediaType,
        }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}
