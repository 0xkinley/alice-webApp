import { createHash, randomBytes } from "node:crypto";

export const OAUTH_CONSENT_LIFETIME_SECONDS = 10 * 60;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validToken(token: unknown): token is string {
  return typeof token === "string" && /^alice_consent_[A-Za-z0-9_-]{40,}$/.test(token);
}

export async function createOAuthConsentTransaction(
  database,
  input: {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge: string;
    scopes: string[];
    resource: string;
    mcpOrigin: string;
    webOrigin: string;
  },
) {
  const token = `alice_consent_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = now + OAUTH_CONSENT_LIFETIME_SECONDS;
  await database.transaction(async () => {
    await database.prepare("DELETE FROM oauth_consent_transactions WHERE expires_at <= ?").run(now);
    await database
      .prepare(
        `INSERT INTO oauth_consent_transactions
          (token_hash, client_id, redirect_uri, oauth_state, code_challenge, scope, resource,
           mcp_origin, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(token),
        input.clientId,
        input.redirectUri,
        input.state || null,
        input.codeChallenge,
        input.scopes.join(" "),
        input.resource,
        new URL(input.mcpOrigin).origin,
        createdAt,
        expiresAt,
      );
  });
  const consentUrl = new URL("/oauth/consent", new URL(input.webOrigin).origin);
  consentUrl.searchParams.set("request", token);
  return { consent_url: consentUrl.href, expires_at: expiresAt };
}

export async function getOAuthConsentTransaction(database, token: unknown) {
  if (!validToken(token)) return undefined;
  const row = await database
    .prepare(
      `SELECT consent.client_id, consent.scope, consent.expires_at,
              consent.approved_user_id, client.client_name
       FROM oauth_consent_transactions consent
       JOIN oauth_clients client ON client.client_id = consent.client_id
       WHERE consent.token_hash = ? AND consent.expires_at > ?`,
    )
    .get(sha256(token), Math.floor(Date.now() / 1_000));
  if (!row) return undefined;
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    scopes: String(row.scope).split(" ").filter(Boolean),
    expires_at: Number(row.expires_at),
    approved: Boolean(row.approved_user_id),
  };
}

export async function approveOAuthConsentTransaction(
  database,
  input: { token: unknown; userId: string },
) {
  if (!validToken(input.token)) return undefined;
  const token = input.token;
  const tokenHash = sha256(token);
  const now = Math.floor(Date.now() / 1_000);
  return await database.transaction(async () => {
    const row = await database
      .prepare(
        `SELECT approved_user_id, expires_at, mcp_origin
         FROM oauth_consent_transactions
         WHERE token_hash = ? FOR UPDATE`,
      )
      .get(tokenHash);
    if (!row || Number(row.expires_at) <= now) return undefined;
    if (row.approved_user_id && row.approved_user_id !== input.userId) return undefined;
    if (!row.approved_user_id) {
      await database
        .prepare(
          `UPDATE oauth_consent_transactions
           SET approved_user_id = ?, approved_at = ?
           WHERE token_hash = ?`,
        )
        .run(input.userId, new Date().toISOString(), tokenHash);
    }
    const completeUrl = new URL("/authorize/complete", row.mcp_origin);
    completeUrl.searchParams.set("request", token);
    return { complete_url: completeUrl.href };
  });
}

export function oauthConsentTokenHash(token: unknown): string | undefined {
  return validToken(token) ? sha256(token) : undefined;
}
