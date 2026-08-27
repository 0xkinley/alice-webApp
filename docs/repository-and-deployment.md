# Repository and Deployment Boundaries

Status: Accepted for Milestone 02

Decision date: 2026-08-27

## Purpose

Milestone 02 turns the compatibility spike into a repeatable repository. It does not select production hosting, replace spike authentication, or implement the Milestone 03 database and tenancy foundation.

## Clean-checkout contract

Node.js 24 and the committed `package-lock.json` are the only installation prerequisites:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run check:secrets
npm test
npm run build
```

`npm run check` is the equivalent aggregate command. GitHub Actions runs these same gates after `npm ci`; it receives read-only repository permissions and no application secrets.

Generated `dist/` directories are deployment artifacts, not source. They and TypeScript build metadata remain ignored. A deployment must run `npm run build` before starting either server.

## Deployables

### Web control plane

Entry point: `apps/web/dist/server.js`

Responsibilities:

- render the human review interface;
- authenticate the spike reviewer;
- execute explicit candidate acceptance; and
- expose `/health` for process checks.

The web process is server-rendered. Milestone 02 creates no browser JavaScript bundle and exposes no configuration or secret through a client-public environment prefix.

### MCP server

Entry point: `apps/mcp/dist/server.js`

Responsibilities:

- OAuth metadata, dynamic client registration, authorization-code PKCE, refresh, and revocation;
- authenticated Streamable HTTP MCP transport;
- accepted-context retrieval; and
- candidate-only capture into immutable evidence.

The MCP tool list contains no review or trusted-state mutation action. `save_project_update` returns a review URL at the configured web origin, but acceptance remains a separate authenticated human action.

## Runtime configuration

Both processes validate configuration at startup and fail before listening when it is invalid.

| Variable | Web | MCP | Boundary |
| --- | --- | --- | --- |
| `ALICE_WEB_URL` | Required outside loopback defaults | Review origin; defaults to MCP origin for spike compatibility | Server-only origin, HTTPS unless loopback |
| `ALICE_PUBLIC_URL` | Not used | OAuth issuer and MCP origin | Server-only origin, HTTPS unless loopback |
| `ALICE_AUTH_PASSPHRASE_FILE` | One allowed secret source | One allowed secret source | Preferred mounted-secret path |
| `ALICE_AUTH_PASSPHRASE` | Alternative secret source | Alternative secret source | Server environment only; never browser-public |
| `ALICE_DATABASE_PATH` | Persistence location | Persistence location | Server filesystem path |
| `HOST` | Listen address | Listen address | Defaults to `127.0.0.1` |
| `PORT` | Listen port | Listen port | Defaults to 8788 for web and 8787 for MCP |

Exactly one passphrase source must be configured. Local `.env` files and `.data/` are ignored, and the committed `.env.example` contains names and non-secret placeholders only. ChatGPT and Claude passwords, session cookies, and bearer tokens are not provider configuration and must never be stored. OAuth access and refresh tokens are hashed before persistence as preserved from Milestone 01.

## Current persistence constraint

Both deployables still use the Milestone 01 SQLite adapter. They may share one database object in tests or one database file when colocated on the same trusted host and durable volume. Do not deploy them to isolated filesystems and assume state will synchronize. Do not horizontally scale this topology.

Milestone 03 must replace this transitional constraint with production-shaped identity, tenant isolation, and shared durable persistence before private-alpha deployment. This deferral does not weaken the current trust invariant: host writes remain candidate-only, evidence remains immutable, accepted context is authenticated and provenance-bearing, and only the web review action changes trusted state.

## Hosting boundary

Milestone 02 deliberately chooses no cloud vendor, container platform, reverse proxy, or infrastructure-as-code layer. A future hosting decision must provide:

- stable HTTPS origins for web and MCP;
- server-side secret injection;
- a shared durable database appropriate for the topology;
- separate health checks and logs for both processes;
- no bearer-token or submitted-evidence logging; and
- an explicit migration path from the spike passphrase to Milestone 03 authentication.

Provider-specific behavior stays inside the MCP integration surface. The web application does not receive provider credentials or configuration, and neither deployable routes work between AI models.
