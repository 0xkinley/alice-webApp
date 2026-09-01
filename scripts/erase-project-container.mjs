import { URL } from "node:url";

const host = process.env.ALICE_DATABASE_HOST;
const migrationPassword = process.env.ALICE_MIGRATION_DATABASE_PASSWORD;
if (!host || !migrationPassword) {
  throw new Error("The private erasure task requires its database host and migration password.");
}

const migrationUser = process.env.ALICE_MIGRATION_DATABASE_USER || "alice_migrator";
const connection = new URL("postgresql://alice_migrator@localhost:5432/alice");
connection.username = migrationUser;
connection.hostname = host;
connection.port = process.env.ALICE_DATABASE_PORT || "5432";
connection.pathname = `/${process.env.ALICE_DATABASE_NAME || "alice"}`;
connection.password = migrationPassword;
connection.searchParams.set("sslmode", process.env.ALICE_DATABASE_SSLMODE || "verify-full");
process.env.ALICE_MIGRATION_DATABASE_URL = connection.href;

const { runProjectErasureOperator, safeProjectErasureFailure } =
  await import("./erase-project.mjs");
try {
  await runProjectErasureOperator();
} catch (error) {
  safeProjectErasureFailure(error);
}
