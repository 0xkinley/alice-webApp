# Milestone 01 Spike Results

Status: In progress

## Test environment

- Date: 2026-08-26
- Runtime: Node.js 24.0.2 on macOS arm64
- MCP SDK: `@modelcontextprotocol/server` 2.0.0
- Transport: Streamable HTTP with legacy 2025 protocol compatibility
- Public transport during the recorded probe: temporary Cloudflare Quick Tunnel
- Persistent application store: local SQLite; runtime database excluded from Git

Secrets, bearer tokens, passphrases, and unsaved conversation content are intentionally absent from this record.

## Endpoint evidence

Recorded at 2026-08-26 22:23 Asia/Dubai:

- A probe from outside the local listener returned `200` from `/health` over public HTTPS.
- The path-aware RFC 9728 resource document returned the public `/mcp` resource, the co-located authorization server, and separate `mcp:read` and `mcp:write` scopes.
- An unauthenticated public `initialize` request returned `401` and a `WWW-Authenticate` challenge containing the protected-resource metadata URL.
- Automated integration coverage completed dynamic client registration, authorization-code + S256 PKCE, access and refresh token issuance, authenticated MCP initialization, access-token revocation, and rejection of the revoked token.
- The public hostname was an ephemeral `trycloudflare.com` address and is not a production deployment. Its URL is omitted because it is invalid after the recorded tunnel stops.

Verification command: `npm test`

Result: 3 tests passed, 0 failed.

## Round-trip runs

No host run recorded yet.

## Manual copy/paste baseline

Not run yet.

## Go/no-go recommendation

Pending the complete two-switch round trip and recurring-workflow comparison. MCP connectivity is not treated as success.
