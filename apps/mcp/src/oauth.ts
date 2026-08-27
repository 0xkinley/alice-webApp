import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendAuditEvent, authenticateUser } from "@alice/domain";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const SUPPORTED_SCOPES = new Set(["mcp:read", "mcp:write", "offline_access"]);
const DEFAULT_CLIENT_SCOPES = [...SUPPORTED_SCOPES];

// OAuth remains an MCP-server responsibility and is never exposed to browser code.

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function oauthError(response, status, error, description) {
  response.status(status).json({ error, error_description: description });
}

function parseScope(value) {
  const scopes = String(value || DEFAULT_CLIENT_SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set(scopes.filter((scope) => SUPPORTED_SCOPES.has(scope)))];
}

function describeScopes(scopes) {
  const labels: string[] = [];
  if (scopes.includes("mcp:read")) labels.push("read");
  if (scopes.includes("mcp:write")) labels.push("candidate-write");
  if (scopes.includes("offline_access")) labels.push("persistent refresh");
  if (labels.length === 1) return `${labels[0]} access`;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)} access`;
}

function validateRedirectUri(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function authenticateClient(database, request) {
  let clientId = request.body.client_id;
  let clientSecret = request.body.client_secret;
  const authorization = request.get("authorization");

  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    clientId = decodeURIComponent(decoded.slice(0, separator));
    clientSecret = decodeURIComponent(decoded.slice(separator + 1));
  }

  const client = database.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId);
  if (!client) return undefined;
  if (client.token_endpoint_auth_method === "none") return client;
  if (!clientSecret || !constantTimeEqual(sha256(clientSecret), client.client_secret_hash)) {
    return undefined;
  }
  return client;
}

function issueTokens(database, { clientId, connectionId, scopes, resource, userId }) {
  const accessToken = secret("alice_access");
  const refreshToken = secret("alice_refresh");
  const now = nowSeconds();
  const scope = scopes.filter((item) => item !== "offline_access").join(" ");

  database
    .prepare(
      `INSERT INTO oauth_access_tokens
        (token_hash, client_id, user_id, connection_id, scope, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sha256(accessToken),
      clientId,
      userId,
      connectionId,
      scope,
      resource,
      now + ACCESS_TOKEN_TTL_SECONDS,
    );
  database
    .prepare(
      `INSERT INTO oauth_refresh_tokens
        (token_hash, client_id, user_id, connection_id, scope, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sha256(refreshToken),
      clientId,
      userId,
      connectionId,
      scope,
      resource,
      now + REFRESH_TOKEN_TTL_SECONDS,
    );

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clientClassification(name) {
  const normalized = String(name).toLowerCase();
  if (normalized.includes("chatgpt") || normalized.includes("openai")) return "chatgpt";
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude";
  return "unknown_mcp_client";
}

export function createOAuth({ database, publicUrl }) {
  const resource = new URL("/mcp", publicUrl).href;
  const issuer = new URL(publicUrl).origin;
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...SUPPORTED_SCOPES],
  };

  const verifier = {
    async verifyAccessToken(token) {
      const row = database
        .prepare("SELECT * FROM oauth_access_tokens WHERE token_hash = ?")
        .get(sha256(token));
      if (!row || row.revoked_at || row.expires_at <= nowSeconds()) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "The access token is invalid or expired.",
        );
      }
      if (row.resource !== resource) {
        throw new OAuthError(
          OAuthErrorCode.InvalidTarget,
          "The access token is for another resource.",
        );
      }
      const connection = database
        .prepare(
          `SELECT id FROM integration_connections
           WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
        )
        .get(row.connection_id, row.user_id);
      if (!connection) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The connection is revoked.");
      }
      database
        .prepare("UPDATE integration_connections SET last_used_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.connection_id);
      return {
        token,
        clientId: row.client_id,
        scopes: row.scope.split(" ").filter(Boolean),
        expiresAt: row.expires_at,
        resource: new URL(row.resource),
        extra: { connectionId: row.connection_id, userId: row.user_id },
      };
    },
  };

  function register(request, response) {
    const redirectUris = request.body.redirect_uris;
    const authMethod = request.body.token_endpoint_auth_method || "none";
    const registeredScopes = parseScope(request.body.scope);
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every(validateRedirectUri)
    ) {
      return oauthError(response, 400, "invalid_redirect_uri", "A valid redirect URI is required.");
    }
    if (!metadata.token_endpoint_auth_methods_supported.includes(authMethod)) {
      return oauthError(
        response,
        400,
        "invalid_client_metadata",
        "Unsupported token endpoint authentication method.",
      );
    }

    const clientId = secret("alice_client");
    const clientSecret = authMethod === "none" ? undefined : secret("alice_secret");
    database
      .prepare(
        `INSERT INTO oauth_clients
          (client_id, client_secret_hash, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        clientId,
        clientSecret ? sha256(clientSecret) : null,
        String(request.body.client_name || "MCP client").slice(0, 200),
        JSON.stringify(redirectUris),
        authMethod,
        new Date().toISOString(),
      );

    response.status(201).json({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: nowSeconds(),
      client_name: request.body.client_name || "MCP client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: registeredScopes.join(" "),
    });
  }

  function authorizeForm(request, response) {
    const client = database
      .prepare("SELECT * FROM oauth_clients WHERE client_id = ?")
      .get(request.query.client_id);
    const redirectUris = client ? JSON.parse(client.redirect_uris_json) : [];
    if (!client || !redirectUris.includes(request.query.redirect_uri)) {
      return oauthError(response, 400, "invalid_request", "Unknown client or redirect URI.");
    }
    if (request.query.response_type !== "code" || request.query.code_challenge_method !== "S256") {
      return oauthError(
        response,
        400,
        "invalid_request",
        "Authorization code with S256 PKCE is required.",
      );
    }
    if (!request.query.code_challenge) {
      return oauthError(response, 400, "invalid_request", "A PKCE code challenge is required.");
    }
    const requestedResource = String(request.query.resource || resource);
    if (requestedResource !== resource) {
      return oauthError(response, 400, "invalid_target", "Unknown MCP resource.");
    }

    const requestedScopes = parseScope(request.query.scope);

    const fields = [
      "client_id",
      "redirect_uri",
      "response_type",
      "state",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "resource",
    ]
      .map(
        (name) =>
          `<input type="hidden" name="${name}" value="${escapeHtml(request.query[name] || "")}">`,
      )
      .join("\n");

    response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize alice.</title><style>body{font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.7rem;width:100%;box-sizing:border-box;margin:.4rem 0}small{color:#555}</style></head>
<body><h1>Authorize alice.</h1><p><strong>${escapeHtml(client.client_name)}</strong> is requesting ${escapeHtml(describeScopes(requestedScopes))} to your private alice. workspace.</p>
<p><small>Writes create pending candidates only. They cannot change trusted state.</small></p>
<form method="post" action="/authorize">${fields}<label>Email<input type="email" name="email" required autocomplete="email"></label><label>Password<input type="password" name="password" required autocomplete="current-password"></label><button type="submit">Authorize</button></form></body></html>`);
  }

  function authorize(request, response) {
    const client = database
      .prepare("SELECT * FROM oauth_clients WHERE client_id = ?")
      .get(request.body.client_id);
    const redirectUris = client ? JSON.parse(client.redirect_uris_json) : [];
    if (!client || !redirectUris.includes(request.body.redirect_uri)) {
      return oauthError(response, 400, "invalid_request", "Unknown client or redirect URI.");
    }
    const user = authenticateUser(database, request.body);
    if (!user) {
      return response
        .status(403)
        .type("html")
        .send("Authorization denied: invalid alice. credentials.");
    }
    if (request.body.code_challenge_method !== "S256" || !request.body.code_challenge) {
      return oauthError(response, 400, "invalid_request", "S256 PKCE is required.");
    }
    const requestedResource = String(request.body.resource || resource);
    if (requestedResource !== resource) {
      return oauthError(response, 400, "invalid_target", "Unknown MCP resource.");
    }

    const code = secret("alice_code");
    const scopes = parseScope(request.body.scope);
    const connectionId = secret("connection");
    const connectedAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO integration_connections
            (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
             first_connected_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          connectionId,
          user.id,
          user.workspace_id,
          client.client_id,
          clientClassification(client.client_name),
          scopes.join(" "),
          connectedAt,
          connectedAt,
        );
      database
        .prepare(
          `INSERT INTO oauth_authorization_codes
            (code_hash, client_id, user_id, connection_id, redirect_uri, code_challenge,
             scope, resource, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sha256(code),
          client.client_id,
          user.id,
          connectionId,
          request.body.redirect_uri,
          request.body.code_challenge,
          scopes.join(" "),
          resource,
          nowSeconds() + AUTHORIZATION_CODE_TTL_SECONDS,
        );
      appendAuditEvent(database, {
        workspaceId: user.workspace_id,
        action: "integration_connection_authorized",
        actorType: "human_user",
        actorId: user.id,
        correlationId: `connection_${connectionId}`,
        metadata: {
          connection_id: connectionId,
          client_id: client.client_id,
          scopes,
        },
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const redirect = new URL(request.body.redirect_uri);
    redirect.searchParams.set("code", code);
    if (request.body.state) redirect.searchParams.set("state", request.body.state);
    response.redirect(303, redirect.href);
  }

  function token(request, response) {
    const client = authenticateClient(database, request);
    if (!client) {
      response.set("WWW-Authenticate", 'Basic realm="alice token endpoint"');
      return oauthError(response, 401, "invalid_client", "Client authentication failed.");
    }

    if (request.body.grant_type === "authorization_code") {
      const codeHash = sha256(String(request.body.code || ""));
      const row = database
        .prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash = ?")
        .get(codeHash);
      const challenge = sha256(String(request.body.code_verifier || ""));
      const encodedChallenge = Buffer.from(challenge, "hex").toString("base64url");
      if (
        !row ||
        row.client_id !== client.client_id ||
        row.redirect_uri !== request.body.redirect_uri ||
        row.consumed_at ||
        row.expires_at <= nowSeconds() ||
        !constantTimeEqual(encodedChallenge, row.code_challenge)
      ) {
        return oauthError(response, 400, "invalid_grant", "Authorization code validation failed.");
      }
      database
        .prepare("UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ?")
        .run(new Date().toISOString(), codeHash);
      return response.json(
        issueTokens(database, {
          clientId: client.client_id,
          connectionId: row.connection_id,
          scopes: row.scope.split(" "),
          resource: row.resource,
          userId: row.user_id,
        }),
      );
    }

    if (request.body.grant_type === "refresh_token") {
      const refreshHash = sha256(String(request.body.refresh_token || ""));
      const row = database
        .prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?")
        .get(refreshHash);
      if (
        !row ||
        row.client_id !== client.client_id ||
        row.revoked_at ||
        row.expires_at <= nowSeconds()
      ) {
        return oauthError(response, 400, "invalid_grant", "Refresh token validation failed.");
      }
      database
        .prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?")
        .run(new Date().toISOString(), refreshHash);
      return response.json(
        issueTokens(database, {
          clientId: client.client_id,
          connectionId: row.connection_id,
          scopes: row.scope.split(" "),
          resource: row.resource,
          userId: row.user_id,
        }),
      );
    }

    return oauthError(response, 400, "unsupported_grant_type", "Unsupported grant type.");
  }

  function revoke(request, response) {
    const client = authenticateClient(database, request);
    if (!client)
      return oauthError(response, 401, "invalid_client", "Client authentication failed.");
    const tokenHash = sha256(String(request.body.token || ""));
    const revokedAt = new Date().toISOString();
    const connection = database
      .prepare(
        `SELECT tokens.connection_id, connections.workspace_id, connections.user_id
         FROM (
           SELECT connection_id FROM oauth_access_tokens WHERE token_hash = ? AND client_id = ?
           UNION
           SELECT connection_id FROM oauth_refresh_tokens WHERE token_hash = ? AND client_id = ?
         ) tokens
         JOIN integration_connections connections ON connections.id = tokens.connection_id`,
      )
      .get(tokenHash, client.client_id, tokenHash, client.client_id);
    if (connection) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            "UPDATE oauth_access_tokens SET revoked_at = ? WHERE connection_id = ? AND client_id = ?",
          )
          .run(revokedAt, connection.connection_id, client.client_id);
        database
          .prepare(
            "UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE connection_id = ? AND client_id = ?",
          )
          .run(revokedAt, connection.connection_id, client.client_id);
        database
          .prepare("UPDATE integration_connections SET revoked_at = ? WHERE id = ?")
          .run(revokedAt, connection.connection_id);
        appendAuditEvent(database, {
          workspaceId: connection.workspace_id,
          action: "integration_connection_revoked",
          actorType: "human_user",
          actorId: connection.user_id,
          correlationId: `connection_${connection.connection_id}`,
          metadata: { connection_id: connection.connection_id, client_id: client.client_id },
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    response.status(200).end();
  }

  return { authorize, authorizeForm, metadata, register, resource, revoke, token, verifier };
}
