import { URL } from "node:url";
import { openDatabase } from "@alice/database";
import { issueAlphaInvitation } from "@alice/domain";

const email = process.argv[2];
if (!email) throw new Error("Usage: npm run alpha:invite -- person@example.com");
const databaseUrl = process.env.ALICE_DATABASE_URL;
if (!databaseUrl) throw new Error("ALICE_DATABASE_URL is required.");
const webUrl = process.env.ALICE_WEB_URL;
if (!webUrl) throw new Error("ALICE_WEB_URL is required.");

const database = await openDatabase({ connectionString: databaseUrl, maxConnections: 1 });
try {
  const invitation = await issueAlphaInvitation(database, { email });
  const url = new URL("/auth/register", webUrl);
  url.searchParams.set("invite", invitation.token);
  console.log(`One-time alpha invitation for ${invitation.email}: ${url.href}`);
  console.log(`Expires at ${new Date(invitation.expires_at * 1_000).toISOString()}.`);
} finally {
  await database.close();
}
