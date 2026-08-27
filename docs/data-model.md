# alice. Minimum Data Model

This is the conceptual minimum. Exact SQL belongs to the database milestone.

## Identity and tenancy

### Users

Application identity with a stable internal identifier and normalized unique email. Milestone 03 uses salted scrypt password digests; an external identity provider can later replace the verifier without changing tenant identifiers.

### Workspaces

One private workspace is automatically created per MVP user.

The user and workspace are inserted transactionally. A unique constraint on `workspaces.user_id` enforces exactly one workspace per user. No membership, team, organization, invitation, sharing, or role table exists.

### Projects

Projects belong to a private workspace. Every tenant-owned record carries the workspace identifier even when it can be derived through the project.

Composite workspace/project foreign keys prevent a record from naming a project in another workspace.

Project identifiers are random server-generated UUID-based values. Names are unique within a workspace but not globally. The application exposes create, list, and detail paths scoped to the workspace derived from the authenticated user; project deletion is intentionally absent while immutable history and retention rules are being established.

## Project intelligence

### Evidence events

Immutable records of explicitly submitted material. Store the exact validated MCP payload, provenance, idempotency key, content hash, and timestamps.

For the Milestone 01 spike, the validated payload is serialized once, hashed with SHA-256, and inserted in the same database transaction before any candidate claim. Candidate foreign keys require the evidence row to exist first. Database triggers reject evidence updates and deletes; an idempotent retry may only reuse an existing event when its payload hash matches.

Milestone 03 retains those triggers in the versioned tenant schema and adds composite workspace/project/connection foreign keys. Evidence insertion, candidate insertion, and its audit event share one immediate transaction. Normal application code exposes no evidence update or delete operation.

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

The current action set covers registration, session creation and revocation, project creation, integration authorization and revocation, candidate submission, and human acceptance. Audit insertion participates in the transaction for the associated state change. Database triggers reject every audit update and delete. Metadata excludes passwords, session values, bearer tokens, email addresses, and submitted evidence content.

## Required invariants

- Deny access by default.
- Authorize from authenticated identity and workspace membership, never a caller-supplied workspace ID alone.
- Evidence and audit history are append-only through normal application roles.
- Candidate creation does not change trusted state.
- Trusted state always references the accepted candidate and source evidence.
- Supersession preserves the prior state record.
- Cross-workspace references are prevented by database constraints and tested authorization policies.
