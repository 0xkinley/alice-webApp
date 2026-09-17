import { randomBytes, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  ACQUISITION_PROBE_CONTRACT_VERSION,
  ACQUISITION_TOOL_NAME,
  type AcquisitionOutcome,
  type AcquisitionOutcomeKind,
  type AcquisitionOutcomeValue,
  type AcquisitionRecord,
  type AcquisitionRunMetadata,
  type AcquisitionSession,
} from "./types.ts";
import {
  assertSessionId,
  cloneRecord,
  DEFAULT_DIAGNOSTIC_TTL_MS,
  DiagnosticRecordAlreadyExistsError,
  sha256,
  type DiagnosticRuntimeStore,
} from "./storage.ts";

interface S3ClientLike {
  send(command: object): Promise<any>;
}

function jsonBody(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailed(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

async function responseJson<T>(response: {
  Body?: { transformToString(): Promise<string> };
}): Promise<T> {
  if (!response.Body) throw new Error("S3 diagnostic object body is missing.");
  return JSON.parse(await response.Body.transformToString()) as T;
}

export class S3DiagnosticStore implements DiagnosticRuntimeStore {
  readonly bucket: string;
  readonly client: S3ClientLike;

  constructor({
    bucket,
    client,
    clientConfig,
  }: {
    bucket: string;
    client?: S3ClientLike;
    clientConfig?: S3ClientConfig;
  }) {
    if (!bucket.trim()) throw new Error("The diagnostic S3 bucket is required.");
    this.bucket = bucket;
    this.client = client ?? new S3Client(clientConfig ?? {});
  }

  private sessionKey(tokenSha256: string): string {
    return `sessions/by-token/${tokenSha256}.json`;
  }

  private sessionByIdKey(sessionId: string): string {
    assertSessionId(sessionId);
    return `sessions/by-id/${sessionId}.json`;
  }

  private recordKey(sessionId: string): string {
    assertSessionId(sessionId);
    return `records/${sessionId}.json`;
  }

  private outcomeKey(sessionId: string, outcomeId: string, observedAt: string): string {
    assertSessionId(sessionId);
    return `outcomes/${sessionId}/${observedAt.replaceAll(":", "-")}-${outcomeId}.json`;
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    try {
      return await responseJson<T>(
        await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const entry of response.Contents ?? []) {
        if (entry.Key) keys.push(entry.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  async createSession(
    run: AcquisitionRunMetadata,
    options: { now?: Date; ttlMs?: number } = {},
  ): Promise<{ session: AcquisitionSession; token: string }> {
    const ttlMs = options.ttlMs ?? DEFAULT_DIAGNOSTIC_TTL_MS;
    if (ttlMs !== DEFAULT_DIAGNOSTIC_TTL_MS) {
      throw new Error("Hosted diagnostic sessions use an exact 24-hour TTL.");
    }
    const now = options.now ?? new Date();
    const token = randomBytes(32).toString("base64url");
    const session: AcquisitionSession = {
      contract_version: ACQUISITION_PROBE_CONTRACT_VERSION,
      session_id: randomUUID(),
      token_sha256: sha256(token),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      maximum_calls: 1,
      run,
    };
    const object = {
      Bucket: this.bucket,
      Body: jsonBody(session),
      ContentType: "application/json",
      ServerSideEncryption: "AES256" as const,
      IfNoneMatch: "*",
    };
    const tokenKey = this.sessionKey(session.token_sha256);
    await this.client.send(new PutObjectCommand({ ...object, Key: tokenKey }));
    try {
      await this.client.send(
        new PutObjectCommand({ ...object, Key: this.sessionByIdKey(session.session_id) }),
      );
    } catch (error) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: tokenKey }));
      throw error;
    }
    return { session, token };
  }

  async resolveSessionToken(
    token: string,
    now = new Date(),
  ): Promise<AcquisitionSession | undefined> {
    if (!token || token.length > 256) return undefined;
    const session = await this.getJson<AcquisitionSession>(this.sessionKey(sha256(token)));
    if (!session || Date.parse(session.expires_at) <= now.getTime()) return undefined;
    return session;
  }

  async capture(
    session: AcquisitionSession,
    exactArgumentsJson: string,
    parsedArguments: Record<string, unknown>,
    now = new Date(),
  ): Promise<AcquisitionRecord> {
    if (Date.parse(session.expires_at) <= now.getTime()) {
      throw new Error("Diagnostic session expired.");
    }
    const reparsed = JSON.parse(exactArgumentsJson) as unknown;
    if (!reparsed || Array.isArray(reparsed) || typeof reparsed !== "object") {
      throw new Error("Diagnostic arguments must be an object.");
    }
    if (JSON.stringify(reparsed) !== JSON.stringify(parsedArguments)) {
      throw new Error("The pre-validation argument snapshot changed before capture.");
    }
    const record: AcquisitionRecord = {
      contract_version: ACQUISITION_PROBE_CONTRACT_VERSION,
      record_id: randomUUID(),
      session_id: session.session_id,
      tool_name: ACQUISITION_TOOL_NAME,
      received_at: now.toISOString(),
      expires_at: session.expires_at,
      run: session.run,
      received_arguments: {
        exact_json: exactArgumentsJson,
        sha256: sha256(exactArgumentsJson),
        utf8_bytes: Buffer.byteLength(exactArgumentsJson, "utf8"),
      },
      parsed_arguments: cloneRecord(parsedArguments),
    };
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.recordKey(session.session_id),
          Body: jsonBody(record),
          ContentType: "application/json",
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (isPreconditionFailed(error)) throw new DiagnosticRecordAlreadyExistsError();
      throw error;
    }
    return record;
  }

  async recordOutcome(
    session: AcquisitionSession,
    outcome: {
      source: "runtime" | "operator";
      kind: AcquisitionOutcomeKind;
      value: AcquisitionOutcomeValue;
      detail_code: string;
    },
    now = new Date(),
  ): Promise<AcquisitionOutcome> {
    if (Date.parse(session.expires_at) <= now.getTime()) {
      throw new Error("Diagnostic session expired.");
    }
    const record: AcquisitionOutcome = {
      contract_version: ACQUISITION_PROBE_CONTRACT_VERSION,
      outcome_id: randomUUID(),
      session_id: session.session_id,
      observed_at: now.toISOString(),
      expires_at: session.expires_at,
      ...outcome,
    };
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.outcomeKey(session.session_id, record.outcome_id, record.observed_at),
        Body: jsonBody(record),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
        IfNoneMatch: "*",
      }),
    );
    return record;
  }

  async readRecord(sessionId: string): Promise<AcquisitionRecord | undefined> {
    return await this.getJson<AcquisitionRecord>(this.recordKey(sessionId));
  }

  async readOutcomesForSession(sessionId: string): Promise<AcquisitionOutcome[]> {
    assertSessionId(sessionId);
    const outcomes = await Promise.all(
      (await this.listKeys(`outcomes/${sessionId}/`)).map((key) =>
        this.getJson<AcquisitionOutcome>(key),
      ),
    );
    return outcomes
      .filter((outcome): outcome is AcquisitionOutcome => Boolean(outcome))
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
  }

  async readSessionById(sessionId: string): Promise<AcquisitionSession | undefined> {
    return await this.getJson<AcquisitionSession>(this.sessionByIdKey(sessionId));
  }

  async deleteSession(
    sessionId: string,
  ): Promise<{ session_deleted: boolean; record_deleted: boolean }> {
    const session = await this.readSessionById(sessionId);
    const record = await this.readRecord(sessionId);
    const keys = [
      ...(session ? [this.sessionByIdKey(sessionId), this.sessionKey(session.token_sha256)] : []),
      ...(record ? [this.recordKey(sessionId)] : []),
      ...(await this.listKeys(`outcomes/${sessionId}/`)),
    ];
    await Promise.all(
      keys.map((key) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
      ),
    );
    return { session_deleted: Boolean(session), record_deleted: Boolean(record) };
  }

  async verifySessionMissing(sessionId: string): Promise<boolean> {
    return (
      (await this.readSessionById(sessionId)) === undefined &&
      (await this.readRecord(sessionId)) === undefined &&
      (await this.readOutcomesForSession(sessionId)).length === 0
    );
  }
}
