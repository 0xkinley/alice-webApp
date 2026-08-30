# Repository and Deployment Boundaries

Status: Accepted through Milestone 06 PostgreSQL foundation

Decision date: 2026-08-27; updated 2026-08-30

## Purpose

Milestone 02 turned the compatibility spike into a repeatable repository. Milestone 03 replaced spike authentication and introduced the tenant-shaped database. Milestone 04 productionized capture and human review. Milestone 05 added deterministic, provenance-bearing, budgeted consumption and cross-host evaluation. Milestone 06 keeps the two-deployable boundary while moving production persistence to shared PostgreSQL.

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
npm run test:postgres
npm run build
```

`npm run check` is the equivalent aggregate command when `ALICE_TEST_DATABASE_URL` points to an isolated PostgreSQL database. GitHub Actions provisions PostgreSQL 17, migrates an empty database, runs both test suites and the deterministic evaluations, and verifies a dump/restore before building. The workflow receives read-only repository permissions and uses only disposable CI credentials.

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
| `ALICE_MCP_URL` | Stable connection-center MCP origin | Not used | Server-only public origin, HTTPS unless loopback |
| `ALICE_DATABASE_URL` | Required PostgreSQL application connection | Required PostgreSQL application connection | Server-only URL; TLS required outside loopback |
| `ALICE_MIGRATION_DATABASE_URL` | Migration command only | Migration command only | Separate owner/migrator URL; never supplied to a deployable |
| `ALICE_APPLICATION_DATABASE_ROLE` | Migration command only | Migration command only | Constrained runtime role receiving schema/table grants |
| `HOST` | Listen address | Listen address | Defaults to `127.0.0.1` |
| `PORT` | Listen port | Listen port | Defaults to 8788 for web and 8787 for MCP |

Local `.env` files and `.data/` are ignored, and the committed `.env.example` contains names and non-secret placeholders only. Connection URLs are server-only. alice. passwords are salted and memory-hard hashed. ChatGPT and Claude passwords are never collected. Web session tokens and OAuth access and refresh tokens are hashed before persistence; plaintext bearer values are returned only at issuance and are not logged.

OAuth client secrets and authorization codes are also hash-only at rest. Integration connection rows store ownership, client classification, scope grants, usage timestamps, and revocation state—not bearer values or provider credentials.

Alpha invitation tokens are also hash-only at rest. The invitation URL is a one-time credential and its query value must be redacted from edge and application logs.

## PostgreSQL persistence boundary

Both deployables use one versioned PostgreSQL database through a pooled asynchronous adapter. Runtime startup never creates or migrates schema; it checks the exact applied migration list and fails closed when the database is absent, behind, or ahead. `npm run db:migrate` runs separately with an owner/migrator login and grants only the runtime permissions required by the application.

The constrained runtime role cannot create schema, manage migrations, truncate tables, or rewrite immutable evidence, accepted history, and audit events. Host writes remain candidate-only, evidence remains immutable, accepted context is authenticated and provenance-bearing, and only the web review action changes trusted state.

The old `.data/*.sqlite` development files are not production data and receive no automatic conversion. They are deliberately discarded when moving to Milestone 06. SQLite remains only behind `@alice/database/testing` for empty, ephemeral regression fixtures; neither deployable can select it through configuration.

## Hosting boundary

The repository deliberately chooses no cloud vendor, container platform, reverse proxy, or infrastructure-as-code layer. A future hosting decision must provide:

- stable HTTPS origins for web and MCP;
- server-side secret injection;
- a shared durable PostgreSQL 17 database with separate migration and application roles;
- separate health checks and logs for both processes;
- no bearer-token or submitted-evidence logging; and
- scheduled encrypted backups, restore drills, and an operator-run versioned migration path.

Provider-specific behavior stays inside the MCP integration surface. The web application does not receive provider credentials or configuration, and neither deployable routes work between AI models.
