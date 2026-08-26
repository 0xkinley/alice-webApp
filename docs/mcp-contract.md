# alice. MCP Contract

## Design principles

- All tools are authenticated.
- Read and write capabilities are separate.
- Write tools are invoked only after an explicit user request to save or record something in alice.
- A host-generated payload creates evidence and candidates, never trusted state.
- Every write is idempotent, bounded, attributable, and audited.
- Tool results are structured and also readable by the model.

## Minimum tool surface

### `list_projects`

Lists projects available to the authenticated user in their private workspace.

Side effects: none, apart from safe audit telemetry.

### `get_project_context`

Builds a bounded, task-specific context package from accepted project state.

Minimum input:

- `project_id`
- `task`
- optional context budget

Minimum output:

- project identity
- accepted decisions and constraints relevant to the task
- relevant open questions and artifact references when implemented
- provenance references
- package version and freshness
- omission counts

Pending candidate claims are excluded by default.

### `save_project_update`

Captures an explicitly requested project update.

Minimum input:

- `project_id`
- summary
- one or more candidate claims
- optional source note or explicitly submitted source context
- idempotency key

The server must atomically:

1. Store the exact validated payload as an immutable evidence event.
2. Record actor, connection, client classification, tool, timestamp, idempotency key, and payload hash.
3. Create candidate claims referencing that evidence.
4. Append an audit event.
5. Return evidence and candidate identifiers plus a review location.

The tool must not accept, reject, supersede, or otherwise mutate trusted state.

## Deferred tools

The MVP does not expose MCP tools for:

- accepting or rejecting candidates
- resolving conflicts
- deleting project data
- creating teams or invitations
- routing work between AI providers

