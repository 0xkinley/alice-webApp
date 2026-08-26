# alice. Minimum Data Model

This is the conceptual minimum. Exact SQL belongs to the database milestone.

## Identity and tenancy

### Users

Application profile keyed to the external identity provider subject.

### Workspaces

One private workspace is automatically created per MVP user.

### Projects

Projects belong to a private workspace. Every tenant-owned record carries the workspace identifier even when it can be derived through the project.

## Project intelligence

### Evidence events

Immutable records of explicitly submitted material. Store the exact validated MCP payload, provenance, idempotency key, content hash, and timestamps.

### Candidate claims

Untrusted proposed decisions, facts, requirements, constraints, preferences, or open questions. Each candidate references its source evidence.

### Accepted project state

Versioned trusted state accepted by a human. Acceptance creates a traceable state record; it never overwrites or detaches prior history.

### Conflicts

Records disagreement between candidates or accepted values for the same state key. Conflict detection must not resolve or supersede state automatically.

### Artifacts

Project references such as URLs and metadata. Binary ingestion and file intelligence are deferred.

## Integrations and audit

### Integration connections

Records which authenticated MCP client a user connected, granted capabilities, first and last use, and revocation status. Do not store ChatGPT or Claude passwords. Do not log bearer tokens.

### Audit events

Append-only records of security- and state-relevant actions. Store identifiers, safe metadata, and correlation IDs rather than unsaved conversation content.

## Required invariants

- Deny access by default.
- Authorize from authenticated identity and workspace membership, never a caller-supplied workspace ID alone.
- Evidence and audit history are append-only through normal application roles.
- Candidate creation does not change trusted state.
- Trusted state always references the accepted candidate and source evidence.
- Supersession preserves the prior state record.
- Cross-workspace references are prevented by database constraints and tested authorization policies.

