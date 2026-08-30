import { configureApplicationRole, ensureApplicationRole, openDatabase } from "@alice/database";

const connectionString = process.env.ALICE_MIGRATION_DATABASE_URL || process.env.ALICE_DATABASE_URL;
if (!connectionString) {
  throw new Error("ALICE_MIGRATION_DATABASE_URL is required.");
}
const applicationRole = process.env.ALICE_APPLICATION_DATABASE_ROLE;
if (!applicationRole) throw new Error("ALICE_APPLICATION_DATABASE_ROLE is required.");

const database = await openDatabase({
  connectionString,
  schema: process.env.ALICE_DATABASE_SCHEMA || "public",
  maxConnections: 1,
  migrate: true,
});
if (process.env.ALICE_APPLICATION_DATABASE_PASSWORD) {
  await ensureApplicationRole(
    database,
    applicationRole,
    process.env.ALICE_APPLICATION_DATABASE_PASSWORD,
  );
}
await configureApplicationRole(database, applicationRole);
const migrations = await database
  .prepare("SELECT version, filename, applied_at FROM alice_schema_migrations ORDER BY version")
  .all();
await database.close();
console.log(`PostgreSQL migrations current: ${migrations.length} applied.`);
