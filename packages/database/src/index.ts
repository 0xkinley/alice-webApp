import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";

const { Pool, types } = pg;

types.setTypeParser(20, Number);
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/;

function quoteIdentifier(identifier: string): string {
  if (!identifierPattern.test(identifier)) {
    throw new Error("Database schema names must be lowercase SQL identifiers.");
  }
  return `"${identifier}"`;
}

function postgresSql(sql: string): string {
  let parameter = 0;
  return sql.replaceAll("?", () => `$${++parameter}`);
}

export type RunResult = Readonly<{ changes: number }>;

export class PreparedStatement {
  private readonly database: AliceDatabase;
  private readonly sql: string;

  constructor(database: AliceDatabase, sql: string) {
    this.database = database;
    this.sql = sql;
  }

  async get(...parameters: unknown[]): Promise<any | undefined> {
    const result = await this.database.query(this.sql, parameters);
    return result[0];
  }

  async all(...parameters: unknown[]): Promise<any[]> {
    return this.database.query(this.sql, parameters);
  }

  async run(...parameters: unknown[]): Promise<RunResult> {
    const result = await this.database.execute(this.sql, parameters);
    return { changes: result };
  }
}

export class AliceDatabase {
  readonly #pool: InstanceType<typeof Pool>;
  readonly #schema: string;
  readonly #transactionClient = new AsyncLocalStorage<PoolClient>();

  constructor(pool: InstanceType<typeof Pool>, schema: string) {
    this.#pool = pool;
    this.#schema = schema;
  }

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this, sql);
  }

  async query(sql: string, parameters: unknown[] = []): Promise<QueryResultRow[]> {
    const executor = this.#transactionClient.getStore() || this.#pool;
    const result = await executor.query(postgresSql(sql), parameters);
    return result.rows;
  }

  async execute(sql: string, parameters: unknown[] = []): Promise<number> {
    const executor = this.#transactionClient.getStore() || this.#pool;
    const result = await executor.query(postgresSql(sql), parameters);
    return result.rowCount || 0;
  }

  async exec(sql: string): Promise<void> {
    const executor = this.#transactionClient.getStore() || this.#pool;
    await executor.query(sql);
  }

  async transaction<T>(
    operation: () => Promise<T>,
    { isolation = "SERIALIZABLE" }: { isolation?: "READ COMMITTED" | "SERIALIZABLE" } = {},
  ): Promise<T> {
    if (this.#transactionClient.getStore()) return operation();
    const client = await this.#pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await this.#transactionClient.run(client, operation);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  get schema(): string {
    return this.#schema;
  }
}

async function applyMigrations(database: AliceDatabase): Promise<void> {
  await database.transaction(async () => {
    await database.exec("SELECT pg_advisory_xact_lock(hashtext('alice-schema-migrations'))");
    await database.exec(`
      CREATE TABLE IF NOT EXISTS alice_schema_migrations (
        version integer PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await database.prepare("SELECT version FROM alice_schema_migrations").all()).map((row) =>
        Number(row.version),
      ),
    );
    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) => /^\d{3}_[a-z0-9_]+\.sql$/.test(filename))
      .sort();
    for (const filename of filenames) {
      const version = Number(filename.slice(0, 3));
      if (applied.has(version)) continue;
      await database.exec(await readFile(resolve(migrationsDirectory, filename), "utf8"));
      await database
        .prepare("INSERT INTO alice_schema_migrations (version, filename) VALUES (?, ?)")
        .run(version, filename);
    }
  });
}

export type OpenDatabaseOptions = Readonly<{
  connectionString: string;
  schema?: string;
  maxConnections?: number;
  migrate?: boolean;
}>;

export async function openDatabase({
  connectionString,
  schema = "public",
  maxConnections = 10,
  migrate = true,
}: OpenDatabaseOptions): Promise<AliceDatabase> {
  if (!/^postgres(?:ql)?:\/\//.test(connectionString)) {
    throw new Error("ALICE_DATABASE_URL must be a PostgreSQL connection URL.");
  }
  const quotedSchema = quoteIdentifier(schema);
  const bootstrapPool = new Pool({
    connectionString,
    max: 1,
    application_name: "alice-migrations",
  });
  try {
    await bootstrapPool.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
  } finally {
    await bootstrapPool.end();
  }

  const pool = new Pool({
    connectionString,
    max: maxConnections,
    application_name: "alice",
    options: `-c search_path=${schema}`,
  });
  const database = new AliceDatabase(pool, schema);
  try {
    await database.query("SELECT 1");
    if (migrate) await applyMigrations(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
