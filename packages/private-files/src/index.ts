import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PrivateFileStore, ProviderScanResult } from "@alice/domain";

const SCAN_TAG = "GuardDutyMalwareScanStatus";

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
        { expiresIn: expiresInSeconds },
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
