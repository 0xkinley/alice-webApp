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

## ChatGPT Plus eligibility investigation

Recorded at 2026-08-26 Asia/Dubai:

- The signed-in target is a personal ChatGPT Plus account.
- The account can open the Plugins Directory and use installed plugins with external actions.
- `Settings > Security and login` exposes a `Developer mode` switch with an elevated-risk warning for unverified connectors.
- Developer mode was off. In that state, the Plugins Directory did not expose the plus control documented for adding an MCP server.
- No setting was changed and no MCP connection was created during this read-only investigation.

Root-cause finding: the failed setup attempt does not establish a Business-plan requirement. The target Plus account exposes the documented prerequisite, but it must be deliberately enabled before the native ChatGPT MCP read/write test can continue.

The supported transport comparison and fallback decision are recorded in `docs/provider-adapters.md`. Milestone 01 remains the native MCP round-trip because the actual target Plus account has the required Developer mode gate. Explicit handoff remains the baseline and fallback; a browser companion remains out of scope unless native availability or measured friction fails.

Repository verification after recording this decision: `npm run check` — 14 tests passed, 0 failed.

## Manual copy/paste baseline

Not run yet.

## Go/no-go recommendation

Pending the complete two-switch round trip and recurring-workflow comparison. MCP connectivity is not treated as success.
