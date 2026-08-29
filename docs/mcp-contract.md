# alice. MCP Contract

Status: Capture contract finalized for Milestone 04

Decision date: 2026-08-28

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
- optional source note
- optional bounded source context containing only material the user explicitly chose to save
- idempotency key

The input object and each candidate object are strict; unrecognized fields are rejected rather than silently persisted or interpreted. The finalized limits are:

| Field or structure | Limit |
| --- | --- |
| `project_id` | 1-200 characters; letters, digits, `.`, `_`, `:`, and `-` only |
| `summary` | 1-1,000 trimmed characters |
| `candidate_claims` | 1-20 claims, with no duplicate `state_key` in one save |
| `state_key` | 1-200 lowercase characters in dot/underscore/hyphen-separated segments |
| candidate `summary` | 1-500 trimmed characters |
| candidate `value` | JSON; at most 8 KiB, depth 8, and 256 JSON nodes |
| `source_note` | optional; 1-4,000 trimmed characters |
| `source_context` | optional; 1-12,000 trimmed characters |
| `idempotency_key` | 8-128 characters; letters, digits, `.`, `_`, `:`, and `-` only |
| complete validated payload | at most 32 KiB UTF-8 |

The idempotency key identifies one explicit save within the authenticated connection and project. Reusing it with an identical validated payload returns the original evidence and candidate identifiers. Reusing it with any different validated payload fails closed. Whitespace normalization on bounded textual fields occurs before the exact validated payload is serialized, hashed, and retained as evidence.

The server must atomically:

1. Store the exact validated payload as an immutable evidence event.
2. Record actor, connection, client classification, tool, timestamp, idempotency key, and payload hash.
3. Create candidate claims referencing that evidence.
4. Append an audit event.
5. Return evidence and candidate identifiers plus a review location.

The successful result also returns the original audit-event and correlation identifiers, per-candidate review statuses, and evidence provenance: actor type, authenticated connection, registered client, bounded client classification, tool name, payload hash, and capture timestamp. Retries return the same ordered receipt with `deduplicated: true`; the reported review statuses may reflect a later human decision, but the retry itself performs no mutation.

The tool must not accept, reject, supersede, or otherwise mutate trusted state.

The tool description explicitly forbids invocation for ordinary project activity, suggestions, summaries, or inferred intent. An AI host may call it only after an explicit user request to save or record material in alice. The MCP input boundary is capped at 64 KiB for protocol overhead; the validated capture itself must meet the stricter 32 KiB domain limit above.

The versioned tool-selection fixture and deterministic scoring rules are documented in `docs/capture-evaluations.md`. Correct traces include an explicit-save write and non-capture reads/no-ops; incorrect traces include false-positive writes, missed explicit saves, invented review tools, and duplicate logical capture selection.

Milestone 03 enforces this separation structurally: candidate capture and human acceptance are separate domain operations, and only the web review control plane imports acceptance. Accepted rows are append-only versions whose candidate/evidence pair is constraint-verified. The MCP tool list continues to expose only the three tools above.

## Deferred tools

The MVP does not expose MCP tools for:

- accepting or rejecting candidates
- resolving conflicts
- deleting project data
- creating teams or invitations
- routing work between AI providers
