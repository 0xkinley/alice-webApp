# alice.

alice. is the independent project intelligence layer for the AI tools users already use.

> One project. Whichever AI you use.

The first product test completed a ChatGPT → alice. → Claude → alice. → ChatGPT round trip using official authenticated remote MCP integrations, explicit capture, human-reviewed trusted state, and preserved provenance. Milestone 06 moves that trust model onto a shared PostgreSQL system of record for private-alpha operation.

## Prerequisites

- Node.js 24
- npm 11 or a compatible npm version that honors lockfile version 3
- PostgreSQL 17 for migration, runtime, and PostgreSQL integration checks
- PostgreSQL client tools for backup/restore verification

Install exactly the locked dependency graph and run every repository gate:

```bash
npm ci
npm run check
```

`npm run check` verifies formatting, linting, TypeScript project references, repository secret policy, deterministic evaluations, the regression and real-PostgreSQL suites, and production builds for the web and MCP deployables. Set `ALICE_TEST_DATABASE_URL` to an isolated PostgreSQL database before running it.

## Workspace

```text
apps/web          authentication, projects, and human review control plane
apps/mcp          tenant-bound OAuth and authenticated remote MCP server
packages/config   server-only environment validation
packages/schemas  shared boundary schemas
packages/domain   tenant authorization, trusted context, capture, and review rules
packages/database versioned PostgreSQL schema and asynchronous pooled persistence adapter
```

Production JavaScript is emitted under each workspace's ignored `dist/` directory. Run `npm run build` before `npm run start:web` or `npm run start:mcp`. The `dev:web` and `dev:mcp` scripts execute TypeScript source directly for local development.

## Local development

Create a constrained application login, then migrate with a separate owner/migrator login:

```bash
ALICE_MIGRATION_DATABASE_URL=postgresql://alice_migrator:replace-me@127.0.0.1:5432/alice \
ALICE_APPLICATION_DATABASE_ROLE=alice_app \
npm run db:migrate
```

Start the web control plane with the constrained application login:

```bash
ALICE_WEB_URL=http://127.0.0.1:8788 \
ALICE_MCP_URL=http://127.0.0.1:8787 \
ALICE_DATABASE_URL=postgresql://alice_app:replace-me@127.0.0.1:5432/alice \
PORT=8788 \
npm run dev:web
```

In a second terminal, start the MCP server against the same local database:

```bash
ALICE_PUBLIC_URL=http://127.0.0.1:8787 \
ALICE_WEB_URL=http://127.0.0.1:8788 \
ALICE_DATABASE_URL=postgresql://alice_app:replace-me@127.0.0.1:5432/alice \
PORT=8787 \
npm run dev:mcp
```

The loopback URLs may use HTTP. Configured non-loopback origins must use HTTPS. Runtime data, local environment files, secrets, and build output are ignored by Git.

Open `http://127.0.0.1:8788/auth/register` to create an account. Registration automatically provisions one private workspace. Passwords, browser sessions, and OAuth bearer tokens are stored only as salted or cryptographic digests.

See [Repository and deployment boundaries](docs/repository-and-deployment.md) before hosting either process.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run format` | Apply Prettier to repository code and configuration. |
| `npm run format:check` | Verify formatting without mutation. |
| `npm run lint` | Run ESLint with zero warnings allowed. |
| `npm run typecheck` | Typecheck all shared packages and both deployables. |
| `npm run check:secrets` | Scan tracked and untracked repository files for secret-policy violations. |
| `npm test` | Run the protocol, trust-boundary, and configuration tests. |
| `npm run test:postgres` | Run migrations, concurrency, immutability, and tenant checks on real PostgreSQL. |
| `npm run db:migrate` | Apply versioned migrations and constrain the application role. |
| `npm run db:backup:verify` | Dump, restore, and compare protected-table row counts. |
| `npm run alpha:invite -- email` | Create a one-time, single-email private-alpha invitation. |
| `npm run build` | Clean and compile all packages and both deployables. |
| `npm run check` | Run every required CI gate. |

## Project documentation

- [Milestone roadmap](MILESTONES.md)
- [Product architecture](docs/architecture.md)
- [Repository and deployment boundaries](docs/repository-and-deployment.md)
- [MCP contract](docs/mcp-contract.md)
- [Minimum data model](docs/data-model.md)
- [Initial threat model](docs/threat-model.md)
- [Authentication and tenancy](docs/authentication-and-tenancy.md)
- [Alpha access and AI connections](docs/alpha-access-and-connections.md)
- [Tenant-isolation verification](docs/tenant-isolation.md)
- [Repository instructions](AGENTS.md)

Every milestone begins in a new Codex task and a dedicated milestone branch, as defined in `AGENTS.md`.
