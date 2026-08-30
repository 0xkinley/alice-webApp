# PostgreSQL Persistence

Status: Async production boundary verified for Milestone 06

Decision date: 2026-08-30

## Production boundary

PostgreSQL 17 is the production system of record. Both deployables require the same server-only `ALICE_DATABASE_URL`; the configuration layer rejects SQLite paths, non-PostgreSQL URLs, and non-loopback database URLs that do not explicitly require TLS. The web and MCP health endpoints query the database and return `503` when it is unreachable.

The `@alice/database` package owns a pooled asynchronous adapter. Prepared reads, writes, arbitrary queries, and transactions return promises. Transaction-local PostgreSQL clients are carried with `AsyncLocalStorage`, so nested domain calls use the same connection without passing a client through every policy function.

Production modules import only `@alice/database`. The separate `@alice/database/testing` subpath contains the local in-memory SQLite regression adapter and is not referenced by either deployable.

## Preserved trust model

Migration `001_initial.sql` recreates the complete Milestone 03-05 relational model with PostgreSQL-native foreign keys, checks, unique constraints, indexes, UTC `timestamptz` columns, and row triggers.

- `evidence_events.exact_payload_json` is PostgreSQL `text`. The validated serialization is written once, hashed over those exact UTF-8 bytes, and never normalized through `jsonb`.
- Evidence, accepted-state versions, and audit events reject every ordinary SQL update and delete.
- Candidate content and provenance are immutable; the only update is one `pending` to `accepted` or `rejected` transition.
- Accepted state retains the exact candidate/evidence pair and a unique project/key version.
- Composite workspace/project/connection keys remain the database backstop for tenant isolation.

The application-facing adapter maps PostgreSQL row counts and timestamps to the deterministic shapes expected by the domain layer. Context assembly remains side-effect free and byte-deterministic.

## Concurrency decisions

SQLite's process-wide `BEGIN IMMEDIATE` assumption is removed.

- Capture transactions take a transaction-scoped advisory lock derived from connection, project, and idempotency key under `READ COMMITTED`. Identical concurrent calls see the committed receipt and return it; different payloads under the same key fail closed.
- Human review locks the pending candidate row and takes a transaction-scoped advisory lock derived from workspace, project, and state key. Concurrent same-key acceptance or supersession can append only one next version.
- OAuth authorization-code and refresh-token consumption lock the credential row before rotating or consuming it.
- All state-changing domain operations keep their audit insert in the same PostgreSQL transaction.

The PostgreSQL integration gate uses a real PostgreSQL 17 server. It verifies repeatable migration, twelve concurrent identical captures, conflicting retry reuse, concurrent supersession, byte-exact evidence text and hash, immutable DML rejection, and cross-tenant/mismatched-connection non-disclosure.
