# Repository and Deployment Boundaries

Status: Accepted through Milestone 04

Decision date: 2026-08-27; updated 2026-08-29

## Purpose

Milestone 02 turned the compatibility spike into a repeatable repository. Milestone 03 replaced spike authentication and introduced the tenant-shaped database. Milestone 04 productionizes capture and human review while retaining the same two-deployable boundary.

## Clean-checkout contract

Node.js 24 and the committed `package-lock.json` are the only installation prerequisites:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run check:secrets
npm run eval:capture
npm run eval:context
npm test
npm run build
```

`npm run check` is the equivalent aggregate command. GitHub Actions runs these same gates after `npm ci`, including the versioned capture tool-selection and canonical cross-host context evaluations; it receives read-only repository permissions and no application secrets.

Generated `dist/` directories are deployment artifacts, not source. They and TypeScript build metadata remain ignored. A deployment must run `npm run build` before starting either server.

## Deployables

### Web control plane

Entry point: `apps/web/dist/server.js`

Responsibilities:

- register and authenticate users with one private workspace each;
- create and revisit tenant-scoped projects;
- render the candidate review interface;
- execute explicit human candidate acceptance, rejection, and supersession; and
- expose `/health` for process checks.

The web process is server-rendered. It creates no browser JavaScript bundle and exposes no configuration or secret through a client-public environment prefix.

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
| `ALICE_DATABASE_PATH` | Persistence location | Persistence location | Server filesystem path |
| `HOST` | Listen address | Listen address | Defaults to `127.0.0.1` |
| `PORT` | Listen port | Listen port | Defaults to 8788 for web and 8787 for MCP |

Local `.env` files and `.data/` are ignored, and the committed `.env.example` contains names and non-secret placeholders only. alice. passwords are salted and memory-hard hashed. ChatGPT and Claude passwords are never collected. Web session tokens and OAuth access and refresh tokens are hashed before persistence; plaintext bearer values are returned only at issuance and are not logged.

OAuth client secrets and authorization codes are also hash-only at rest. Integration connection rows store ownership, client classification, scope grants, usage timestamps, and revocation state—not bearer values or provider credentials.

## Current persistence constraint

Both deployables currently use the versioned SQLite adapter. They may share one database object in tests or one database file when colocated on the same trusted host and durable volume. Do not deploy them to isolated filesystems and assume state will synchronize. Do not horizontally scale this topology.

Milestones 03 and 04 add production-shaped identity, tenant isolation, transactional capture, and explicit human review but intentionally do not choose a hosted database. Before private alpha, hosting must provide one shared durable database or a documented move to a server database with equivalent constraints. Host writes remain candidate-only, evidence remains immutable, accepted context is authenticated and provenance-bearing, and only the web review action changes trusted state.

## Hosting boundary

The repository deliberately chooses no cloud vendor, container platform, reverse proxy, or infrastructure-as-code layer. A future hosting decision must provide:

- stable HTTPS origins for web and MCP;
- server-side secret injection;
- a shared durable database appropriate for the topology;
- separate health checks and logs for both processes;
- no bearer-token or submitted-evidence logging; and
- a documented backup and migration path for the versioned tenant schema.

Provider-specific behavior stays inside the MCP integration surface. The web application does not receive provider credentials or configuration, and neither deployable routes work between AI models.
