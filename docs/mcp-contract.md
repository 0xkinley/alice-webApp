# alice. MCP Contract

Status: Active-target consumption and capture contracts extended in Milestone 06

Decision date: 2026-08-28; updated 2026-08-30

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

Input is a strict empty object. Output contract `2.0` contains each project identity, current accepted-state count/freshness, permitted selectable work contexts, and the authenticated connection's active target or `null`. Projects and contexts have deterministic ordering. Foreign projects and contexts are absent rather than disclosed.

Project-state side effects: none. The read does not append audit rows or mutate projects, evidence, candidates, or accepted state. Bearer authentication may update safe connection-usage metadata outside the project-intelligence boundary.

### `get_active_context`

Builds a bounded context package for the exact project/work context selected by the authenticated human for this connection. The strict input contains only `task` and optional `context_budget`; a host cannot supply or change destination identifiers. The output is the version `2.0` context package described below. With no selection, the tool returns an explicit error and points to the alice. connection center. This is the normal supported-host continuation path and does not require the user to repeat a project identifier or “use alice.” phrasing.

### `get_project_context`

Builds a bounded, task-specific context package from accepted project state.

Version `2.0` input:

- `project_id`
- optional `context_id` for an explicit work-context fallback; omission returns project-wide context only
- `task`: 1-2,000 trimmed characters
- optional `context_budget`: 2,000-32,000 UTF-8 bytes; default 16,000

Version `2.0` output:

- project identity
- selected context identity and freshness, with an explicit project-wide inclusion marker
- accepted decisions and constraints selected for the task
- separately labeled relevant open questions, artifact references, and unresolved-conflict notices when available
- accepted-state, candidate, and evidence provenance references for every accepted assertion
- deterministic package version and explicit source freshness
- exact UTF-8 byte budget usage and per-section omission counts

The input and output objects are strict MCP schemas. The same authenticated project state and normalized request produce the same package, including version and ordering. Package freshness is derived from persisted project, accepted-state, and evidence timestamps; context assembly does not use a wall-clock generation timestamp.

Pending and rejected candidate values are excluded from trusted decisions by default. An unresolved-conflict notice may identify pending candidate/evidence references for the same accepted state key, but it does not expose the proposed value or present the alternative as trusted. Artifact references are returned as references only; alice. does not fetch or execute their content during context assembly.

Project-state side effects: none. Ordinary reads and context assembly cannot mutate evidence, candidates, accepted state, audit history, or projects. Bearer authentication may update safe connection-usage metadata outside the project-intelligence boundary.

### `save_project_update`

Captures an explicitly requested project update.

Minimum input:

- optional `project_id` and `context_id`; the connection's active target supplies both when omitted
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

When a human-selected active target exists, omitted destination fields resolve to that target and any explicit destination must match it exactly. Without an active target, the explicit project fallback remains available and an omitted context resolves to project-wide. Foreign, archived, mismatched, or inaccessible destinations fail without evidence, candidates, or audit writes. MCP cannot change an active target.

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

Milestone 03 enforces this separation structurally: candidate capture and human acceptance are separate domain operations, and only the web review control plane imports acceptance. Accepted rows are append-only versions whose candidate/evidence pair is constraint-verified. The MCP tool list exposes only the four tools above; none can accept, reject, supersede, or remove trusted state.

## Deferred tools

The MVP does not expose MCP tools for:

- accepting or rejecting candidates
- resolving conflicts
- deleting project data
- creating teams or invitations
- routing work between AI providers
