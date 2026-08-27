# alice.

alice. is the independent project intelligence layer for the AI tools users already use.

> One project. Whichever AI you use.

The first product test completed a ChatGPT → alice. → Claude → alice. → ChatGPT round trip using official authenticated remote MCP integrations, explicit capture, human-reviewed trusted state, and preserved provenance. Milestone 02 packages that verified behavior as a TypeScript workspace with repeatable local and CI checks.

## Prerequisites

- Node.js 24
- npm 11 or a compatible npm version that honors lockfile version 3

Install exactly the locked dependency graph and run every repository gate:

```bash
npm ci
npm run check
```

`npm run check` verifies formatting, linting, TypeScript project references, repository secret policy, 18 tests, and production builds for the web and MCP deployables.

## Workspace

```text
apps/web          human review control plane
apps/mcp          OAuth and authenticated remote MCP server
packages/config   server-only environment validation
packages/schemas  shared boundary schemas
packages/domain   trusted-context and candidate-capture rules
packages/database SQLite persistence adapter and bootstrap schema
```

Production JavaScript is emitted under each workspace's ignored `dist/` directory. Run `npm run build` before `npm run start:web` or `npm run start:mcp`. The `dev:web` and `dev:mcp` scripts execute TypeScript source directly for local development.

## Local development

Create a passphrase of at least 12 characters. Supply it either through `ALICE_AUTH_PASSPHRASE` or a server-readable file through `ALICE_AUTH_PASSPHRASE_FILE`, never both.

Start the web control plane:

```bash
ALICE_AUTH_PASSPHRASE='local-development-passphrase' \
ALICE_WEB_URL=http://127.0.0.1:8788 \
ALICE_DATABASE_PATH=.data/spike.sqlite \
PORT=8788 \
npm run dev:web
```

In a second terminal, start the MCP server against the same local database:

```bash
ALICE_AUTH_PASSPHRASE='local-development-passphrase' \
ALICE_PUBLIC_URL=http://127.0.0.1:8787 \
ALICE_WEB_URL=http://127.0.0.1:8788 \
ALICE_DATABASE_PATH=.data/spike.sqlite \
PORT=8787 \
npm run dev:mcp
```

The loopback URLs may use HTTP. Configured non-loopback origins must use HTTPS. Runtime data, local environment files, secrets, and build output are ignored by Git.

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
| `npm run build` | Clean and compile all packages and both deployables. |
| `npm run check` | Run every required CI gate. |

## Project documentation

- [Milestone roadmap](MILESTONES.md)
- [Product architecture](docs/architecture.md)
- [Repository and deployment boundaries](docs/repository-and-deployment.md)
- [MCP contract](docs/mcp-contract.md)
- [Minimum data model](docs/data-model.md)
- [Initial threat model](docs/threat-model.md)
- [Repository instructions](AGENTS.md)

Every milestone begins in a new Codex task and a dedicated milestone branch, as defined in `AGENTS.md`.
