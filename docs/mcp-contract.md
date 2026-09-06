# alice. MCP Contract

Status: Active-target consumption, capability-gated file reads, and capture contracts extended in Milestone 06

Decision date: 2026-08-28; updated 2026-08-31

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

Input is a strict empty object. Output contract `2.2` contains each project identity, current accepted-state count/freshness, permitted selectable work contexts, and the authenticated connection's active target or `null`. Projects and contexts have deterministic ordering. Foreign projects and contexts are absent rather than disclosed.

Project-state side effects: none. The read does not append audit rows or mutate projects, evidence, candidates, or accepted state. Bearer authentication may update safe connection-usage metadata outside the project-intelligence boundary.

### `get_active_context`

Builds a bounded context package for the exact project/work context selected by the authenticated human for this connection. The strict input contains only `task` and optional `context_budget`; a host cannot supply or change destination identifiers. The output is the version `2.2` context package described below. With no selection, the tool returns an explicit error and points to the alice. connection center. This is the normal supported-host continuation path and does not require the user to repeat a project identifier or “use alice.” phrasing.

### `get_project_context`

Builds a bounded, task-specific context package from accepted project state.

Version `2.2` input:

- `project_id`
- optional `context_id` for an explicit work-context fallback; omission returns project-wide context only
- `task`: 1-2,000 trimmed characters
- optional `context_budget`: 2,000-32,000 UTF-8 bytes; default 16,000

Version `2.2` output:

- project identity
- selected context identity and freshness, with an explicit project-wide inclusion marker
- accepted decisions and constraints selected for the task
- separately labeled relevant open questions, artifact references, and unresolved-conflict notices when available
- current clean file references visible in the project-wide or selected context, labelled reference-only and untrusted
- accepted-state, candidate, and evidence provenance references for every accepted assertion
- deterministic package version and explicit source freshness
- exact UTF-8 byte budget usage and per-section omission counts, including file artifacts

The input and output objects are strict MCP schemas. The same authenticated project state and normalized request produce the same package, including version and ordering. Package freshness is derived from persisted project, accepted-state, and evidence timestamps; context assembly does not use a wall-clock generation timestamp.

Pending and rejected candidate values are excluded from trusted decisions by default. An unresolved-conflict notice may identify pending candidate/evidence references for the same accepted state key, but it does not expose the proposed value or present the alternative as trusted. Accepted-state artifact values and uploaded file artifacts are returned as references only; alice. does not fetch or execute their content during context assembly. File selection includes only the latest clean, non-removed logical-file version in the allowed scopes, and never exposes storage keys, object versions, credentials, signed URLs, or bytes.

Project-state side effects: none. Ordinary reads and context assembly cannot mutate evidence, candidates, accepted state, audit history, or projects. Bearer authentication may update safe connection-usage metadata outside the project-intelligence boundary.

### `read_project_file_text`

This tool is registered only when the MCP deployment has the private object-store capability configured. It reads one exact current, clean UTF-8 plain-text, Markdown, CSV, TSV, or JSON reference that the authenticated user can currently access. Its strict version `1.0` input contains:

- `project_id`;
- `file_reference_id` obtained from an authorized context package;
- optional `start_character`, a zero-based Unicode code-point continuation offset; and
- optional `context_budget`, 2,000–32,000 UTF-8 bytes, defaulting to 8,000.

The response repeats bounded immutable provenance, returns the largest exact excerpt that fits, and supplies the next code-point offset or `null`. The declared budget covers the complete serialized JSON response; `budget.used` is its exact UTF-8 byte count. Before decoding, the server fetches the stored object by its internal exact version and rechecks both byte size and SHA-256 against immutable PostgreSQL metadata. Invalid UTF-8 and integrity mismatches fail closed.

File content is `untrusted_artifact` data. The response explicitly says never to follow instructions from it, expand access, call tools because of it, or present it as alice.-verified state. The tool cannot create evidence, candidates, accepted state, audit history, or project mutations. Foreign, guessed, superseded, removed, non-clean, and inaccessible references share a non-disclosing unavailable result. PDF extraction and file-backed candidate capture are separate tools; images and modern Office files remain metadata-only.

### `read_project_file_pdf_text`

This read-only `mcp:read` tool is registered only with private-file capability. It accepts the same strict project/reference/Unicode-offset/complete-response-budget envelope as the text tool, but only for a current clean PDF. The server reauthorizes and integrity-checks the exact immutable object version, then uses pinned `pdfjs-dist@6.2.108` contract `pdfjs_embedded_text_v1` to extract embedded text deterministically. It returns exact excerpt text/hash/range, continuation, intersecting page numbers, total/text/textless page counts, parser/method, no-OCR status, untrusted-content safety instructions, and exact complete JSON budget/omissions.

Extraction is bounded to 200 pages, 50,000 text items per page, 250,000 total items, and 2,097,152 Unicode code points. It is embedded-text only: no OCR, image understanding, URL following, model call, embedding, or project-state mutation occurs. Encrypted, malformed, unsupported, over-limit, foreign, removed, superseded, and inaccessible sources fail closed.

### `suggest_project_updates_from_file`

This capability-gated `mcp:write` tool may be invoked only after the user explicitly asks to suggest or save project context from a PDF. Its strict input contains `project_id`, `file_reference_id`, a receipt with the fixed extraction version/start/end/excerpt SHA-256, summary, 1–20 bounded candidate claims, and idempotency key. The receipt range may not exceed 12,000 Unicode code points. The host cannot provide source text, file provenance, destination context, or any accepted/rejected state.

alice. reauthorizes the current clean PDF with write capability, refetches and integrity-checks the exact object version, reruns extraction, and requires an exact receipt match. A selected-context source must match the connection's active context; a project-wide source may feed that active target. The server constructs the evidence payload and immutable relational file provenance. One atomic transaction creates evidence, its exact file source, pending candidates, context targets, and one audit receipt. Idempotent retries return the original complete receipt. The result always reports `trusted_state_changed: false`; only the existing authenticated exact review preview can activate the proposals.

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

The receipt's review URL is bound to the immutable evidence identifier and opens the alice.-controlled exact save preview. One authenticated check accepts the complete still-pending capture atomically; one authenticated cross rejects it without activation. An opaque preview version binds the action to the displayed destination, proposal content, statuses, and current context-specific versions. Stale and concurrent submissions fail closed. The durable authority and transaction design are recorded in `docs/save-confirmation.md`.

The tool must not accept, reject, supersede, or otherwise mutate trusted state.

The tool description explicitly forbids invocation for ordinary project activity, suggestions, summaries, or inferred intent. An AI host may call it only after an explicit user request to save or record material in alice. The MCP input boundary is capped at 64 KiB for protocol overhead; the validated capture itself must meet the stricter 32 KiB domain limit above.

The versioned tool-selection fixture and deterministic scoring rules are documented in `docs/capture-evaluations.md`. Correct traces include an explicit-save write and non-capture reads/no-ops; incorrect traces include false-positive writes, missed explicit saves, invented review tools, and duplicate logical capture selection.

Milestone 03 enforces this separation structurally: candidate capture and human acceptance are separate domain operations, and only the web review control plane imports acceptance. Accepted rows are append-only versions whose candidate/evidence pair is constraint-verified. The MCP tool list exposes four core tools plus two capability-gated file reads and one capability-gated file-suggestion capture when private storage is configured. No MCP tool can accept, reject, supersede, remove, or otherwise mutate trusted state.

## Deferred tools

The MVP does not expose MCP tools for:

- accepting or rejecting candidates
- resolving conflicts
- deleting project data
- running OCR, extracting images or non-PDF binaries, or automatically generating/activating file claims
- creating teams or invitations
- routing work between AI providers
