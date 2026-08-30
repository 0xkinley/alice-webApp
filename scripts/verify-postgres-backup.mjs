import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.ALICE_MIGRATION_DATABASE_URL || process.env.ALICE_DATABASE_URL;
if (!connectionString) throw new Error("ALICE_MIGRATION_DATABASE_URL is required.");

const source = new URL(connectionString);
const sourceDatabase = source.pathname.slice(1);
if (!sourceDatabase || !/^[a-zA-Z0-9_-]+$/.test(sourceDatabase)) {
  throw new Error("The PostgreSQL database name is invalid.");
}
const restoreDatabase = `alice_restore_${process.pid}_${Date.now()}`;
const toolsContainer = process.env.ALICE_POSTGRES_TOOLS_CONTAINER;
const directory = toolsContainer ? undefined : mkdtempSync(join(tmpdir(), "alice-backup-"));
const backupPath = toolsContainer
  ? `/tmp/alice-backup-${process.pid}-${Date.now()}.dump`
  : join(directory, "alice.dump");
const pgEnvironment = {
  ...process.env,
  PGHOST: toolsContainer ? "127.0.0.1" : source.hostname,
  PGPORT: toolsContainer ? process.env.ALICE_POSTGRES_TOOLS_PORT || "5432" : source.port || "5432",
  PGUSER: decodeURIComponent(source.username),
  PGPASSWORD: decodeURIComponent(source.password),
  PGSSLMODE: source.searchParams.get("sslmode") || "prefer",
};

function run(command, arguments_) {
  try {
    const containerEnvironment = Object.entries(pgEnvironment).flatMap(([key, value]) =>
      key.startsWith("PG") && value !== undefined ? ["--env", `${key}=${value}`] : [],
    );
    execFileSync(
      toolsContainer ? "docker" : command,
      toolsContainer
        ? ["exec", ...containerEnvironment, toolsContainer, command, ...arguments_]
        : arguments_,
      {
        env: pgEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const password = decodeURIComponent(source.password);
    const rawDetail = String(error.stderr || error.message);
    const detail = password ? rawDetail.replaceAll(password, "[redacted]") : rawDetail;
    throw new Error(`${command} failed: ${detail}`, { cause: error });
  }
}

async function tableCounts(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const protectedTables = [
      "alice_schema_migrations",
      "alpha_invitations",
      "users",
      "workspaces",
      "projects",
      "work_contexts",
      "context_history_events",
      "candidate_context_targets",
      "accepted_context_entries",
      "active_connection_targets",
      "context_entry_exclusions",
      "evidence_events",
      "file_context_references",
      "file_objects",
      "candidate_claims",
      "accepted_project_state",
      "audit_events",
    ];
    const discovered = await pool.query(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND table_name = ANY($1::text[])
       ORDER BY table_schema, table_name`,
      [protectedTables],
    );
    const counts = {};
    for (const { table_schema: schema, table_name: table } of discovered.rows) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
        throw new Error("Backup verification found an unsafe schema identifier.");
      }
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."${table}"`);
      counts[`${schema}.${table}`] = result.rows[0].count;
    }
    return counts;
  } finally {
    await pool.end();
  }
}

try {
  run("pg_dump", [
    "--format=custom",
    "--no-owner",
    "--no-acl",
    `--file=${backupPath}`,
    sourceDatabase,
  ]);
  run("createdb", ["--maintenance-db=postgres", restoreDatabase]);
  run("pg_restore", ["--no-owner", "--no-acl", `--dbname=${restoreDatabase}`, backupPath]);

  const restored = new URL(connectionString);
  restored.pathname = `/${restoreDatabase}`;
  const [sourceCounts, restoredCounts] = await Promise.all([
    tableCounts(connectionString),
    tableCounts(restored.href),
  ]);
  if (JSON.stringify(sourceCounts) !== JSON.stringify(restoredCounts)) {
    throw new Error("Restored PostgreSQL table counts differ from the source backup.");
  }
  console.log(
    `PostgreSQL backup/restore verified across ${Object.keys(sourceCounts).length} protected tables.`,
  );
} finally {
  try {
    run("dropdb", ["--if-exists", "--maintenance-db=postgres", restoreDatabase]);
  } finally {
    if (toolsContainer) run("rm", ["-f", backupPath]);
    else rmSync(directory, { recursive: true, force: true });
  }
}
