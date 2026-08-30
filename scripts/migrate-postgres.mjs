import { openDatabase } from "@alice/database";

const connectionString = process.env.ALICE_DATABASE_URL;
if (!connectionString) {
  throw new Error("ALICE_DATABASE_URL is required.");
}

const database = await openDatabase({
  connectionString,
  schema: process.env.ALICE_DATABASE_SCHEMA || "public",
  maxConnections: 1,
});
const migrations = await database
  .prepare("SELECT version, filename, applied_at FROM alice_schema_migrations ORDER BY version")
  .all();
await database.close();
console.log(`PostgreSQL migrations current: ${migrations.length} applied.`);
