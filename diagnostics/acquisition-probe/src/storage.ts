import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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

export const DEFAULT_DIAGNOSTIC_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAXIMUM_DIAGNOSTIC_TTL_MS = 72 * 60 * 60 * 1_000;

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSessionId(sessionId: string): void {
  if (!sessionIdPattern.test(sessionId)) throw new Error("Invalid diagnostic session identifier.");
}

export function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export class DiagnosticRecordAlreadyExistsError extends Error {
  constructor() {
    super("Diagnostic session already received its one permitted call.");
    this.name = "DiagnosticRecordAlreadyExistsError";
  }
}

export interface DiagnosticRuntimeStore {
  resolveSessionToken(token: string, now?: Date): Promise<AcquisitionSession | undefined>;
  capture(
    session: AcquisitionSession,
    exactArgumentsJson: string,
    parsedArguments: Record<string, unknown>,
    now?: Date,
  ): Promise<AcquisitionRecord>;
  recordOutcome(
    session: AcquisitionSession,
    outcome: {
      source: "runtime" | "operator";
      kind: AcquisitionOutcomeKind;
      value: AcquisitionOutcomeValue;
      detail_code: string;
    },
    now?: Date,
  ): Promise<AcquisitionOutcome>;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class FileDiagnosticStore {
  readonly dataDirectory: string;
  readonly sessionsDirectory: string;
  readonly recordsDirectory: string;
  readonly outcomesDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.sessionsDirectory = path.join(this.dataDirectory, "sessions");
    this.recordsDirectory = path.join(this.dataDirectory, "records");
    this.outcomesDirectory = path.join(this.dataDirectory, "outcomes");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.recordsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.outcomesDirectory, { recursive: true, mode: 0o700 }),
    ]);
  }

  private sessionPath(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.sessionsDirectory, `${sessionId}.json`);
  }

  private recordPath(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.recordsDirectory, `${sessionId}.json`);
  }

  private sessionOutcomesDirectory(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.outcomesDirectory, sessionId);
  }

  async createSession(
    run: AcquisitionRunMetadata,
    options: { now?: Date; ttlMs?: number } = {},
  ): Promise<{ session: AcquisitionSession; token: string }> {
    await this.initialize();
    const ttlMs = options.ttlMs ?? DEFAULT_DIAGNOSTIC_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAXIMUM_DIAGNOSTIC_TTL_MS) {
      throw new Error("Diagnostic TTL must be between one minute and 72 hours.");
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
    await writeFile(this.sessionPath(session.session_id), `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { session, token };
  }

  async resolveSessionToken(
    token: string,
    now = new Date(),
  ): Promise<AcquisitionSession | undefined> {
    await this.initialize();
    if (!token || token.length > 256) return undefined;
    const candidateHash = Buffer.from(sha256(token), "hex");
    for (const entry of await readdir(this.sessionsDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const session = await readJson<AcquisitionSession>(path.join(this.sessionsDirectory, entry));
      if (!session || Date.parse(session.expires_at) <= now.getTime()) continue;
      const storedHash = Buffer.from(session.token_sha256, "hex");
      if (
        storedHash.length === candidateHash.length &&
        timingSafeEqual(storedHash, candidateHash)
      ) {
        return session;
      }
    }
    return undefined;
  }

  async capture(
    session: AcquisitionSession,
    exactArgumentsJson: string,
    parsedArguments: Record<string, unknown>,
    now = new Date(),
  ): Promise<AcquisitionRecord> {
    await this.initialize();
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
    const handle = await open(this.recordPath(session.session_id), "wx", 0o600).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DiagnosticRecordAlreadyExistsError();
      }
      throw error;
    });
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
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
    await this.initialize();
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
    const directory = this.sessionOutcomesDirectory(session.session_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, `${record.outcome_id}.json`),
      `${JSON.stringify(record)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    return record;
  }

  async readRecord(sessionId: string): Promise<AcquisitionRecord | undefined> {
    return await readJson<AcquisitionRecord>(this.recordPath(sessionId));
  }

  async readSessionById(sessionId: string): Promise<AcquisitionSession | undefined> {
    return await readJson<AcquisitionSession>(this.sessionPath(sessionId));
  }

  async deleteSession(
    sessionId: string,
  ): Promise<{ session_deleted: boolean; record_deleted: boolean }> {
    await this.initialize();
    assertSessionId(sessionId);
    const remove = async (filePath: string): Promise<boolean> => {
      try {
        await rm(filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    const [sessionDeleted, recordDeleted] = await Promise.all([
      remove(this.sessionPath(sessionId)),
      remove(this.recordPath(sessionId)),
    ]);
    await rm(this.sessionOutcomesDirectory(sessionId), { recursive: true, force: true });
    return { session_deleted: sessionDeleted, record_deleted: recordDeleted };
  }

  async pruneExpired(
    now = new Date(),
  ): Promise<{ sessions_deleted: number; records_deleted: number }> {
    await this.initialize();
    let sessionsDeleted = 0;
    let recordsDeleted = 0;
    for (const directory of [this.sessionsDirectory, this.recordsDirectory]) {
      for (const entry of await readdir(directory)) {
        if (!entry.endsWith(".json")) continue;
        const filePath = path.join(directory, entry);
        const value = await readJson<{ expires_at?: string }>(filePath);
        if (value?.expires_at && Date.parse(value.expires_at) <= now.getTime()) {
          await rm(filePath);
          if (directory === this.sessionsDirectory) sessionsDeleted += 1;
          else recordsDeleted += 1;
        }
      }
    }
    for (const sessionDirectory of await readdir(this.outcomesDirectory)) {
      const directory = path.join(this.outcomesDirectory, sessionDirectory);
      for (const entry of await readdir(directory).catch(() => [])) {
        if (!entry.endsWith(".json")) continue;
        const filePath = path.join(directory, entry);
        const value = await readJson<{ expires_at?: string }>(filePath);
        if (value?.expires_at && Date.parse(value.expires_at) <= now.getTime()) {
          await rm(filePath);
        }
      }
      if ((await readdir(directory).catch(() => [])).length === 0) {
        await rm(directory, { recursive: true, force: true });
      }
    }
    return { sessions_deleted: sessionsDeleted, records_deleted: recordsDeleted };
  }

  async readAllRecords(): Promise<AcquisitionRecord[]> {
    await this.initialize();
    const records: AcquisitionRecord[] = [];
    for (const entry of await readdir(this.recordsDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const record = await readJson<AcquisitionRecord>(path.join(this.recordsDirectory, entry));
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.received_at.localeCompare(right.received_at));
  }

  async readAllOutcomes(): Promise<AcquisitionOutcome[]> {
    await this.initialize();
    const outcomes: AcquisitionOutcome[] = [];
    for (const sessionDirectory of await readdir(this.outcomesDirectory)) {
      const directory = path.join(this.outcomesDirectory, sessionDirectory);
      for (const entry of await readdir(directory).catch(() => [])) {
        if (!entry.endsWith(".json")) continue;
        const outcome = await readJson<AcquisitionOutcome>(path.join(directory, entry));
        if (outcome) outcomes.push(outcome);
      }
    }
    return outcomes.sort((left, right) => left.observed_at.localeCompare(right.observed_at));
  }

  async readOutcomesForSession(sessionId: string): Promise<AcquisitionOutcome[]> {
    assertSessionId(sessionId);
    return (await this.readAllOutcomes()).filter((outcome) => outcome.session_id === sessionId);
  }

  async verifySessionMissing(sessionId: string): Promise<boolean> {
    return (
      (await this.readSessionById(sessionId)) === undefined &&
      (await this.readRecord(sessionId)) === undefined &&
      (await this.readOutcomesForSession(sessionId)).length === 0
    );
  }
}
