# Artifact Handoff Contract

Status: Accepted for Milestone 06; compact selector/receipt amendment implemented in source
Decision date: 2026-09-11

## Product boundary

The private-alpha promise is: **Start work in one AI. Continue it in another.** The supported loop is ChatGPT ↔ alice. ↔ Claude. alice. remains the independent persistence and transport layer; it is not a chatbot, agent orchestrator, or model.

alice. does not call an LLM, create embeddings, inspect conversations passively, summarize work, classify it, or invent tags. The connected host reasons over the conversation. alice. validates an explicit structured payload, shows the exact payload to the authenticated user, stores only what that user saves, and retrieves it under Alice permissions.

Raw ChatGPT and Claude conversations are not stored. A host may submit only the artifact and current handoff state that the user explicitly asked to save.

## Current-state retrieval

Default artifact retrieval returns enough approved state for the receiving AI to continue without replaying the conversation:

- the full current artifact;
- current and selected version;
- exact project;
- goal and optional summary;
- decisions;
- constraints;
- rejected directions with reasons;
- open questions;
- next steps;
- relevant context; and
- source host and saved timestamp.

Default retrieval returns the current version only. `include_history` adds lightweight version metadata. An exact older version may be requested separately. History is never injected by default.

Search returns lightweight matches, not full bodies. A host calls `get_artifact` only for the selected artifact. This avoids sending every project or every artifact body to a host.

## Project-first resolution

Every artifact belongs to one project. `search_alice` uses an exact project ID or exact project name when supplied. With one accessible project, it may resolve that project automatically. With several accessible projects and no clear project, it returns the permission-filtered project choices and requires the host to ask the user. It never searches or retrieves all project contents together.

ChatGPT and Claude receive the same available-project catalog for the same Alice user, governed by project membership and role rather than provider-specific targets. Reads and writes reauthorize the connection and exact project on every operation.

## Four-tool host interface

- `search_alice`: find lightweight current artifact matches using deterministic text and filters.
- `get_artifact`: fetch one exact full artifact version and its handoff state.
- `save_to_alice`: prepare either a full artifact Save card or a structured project-information Save card.
- `save_artifact_version`: prepare the complete next version of one exact artifact.

Every successful current-version `get_artifact` read issues one ten-minute, single-use retrieval receipt. `save_artifact_version` requires that receipt and binds it to the authenticated user, exact connection and client, project, artifact, current version row, and stored title. Preview creation reauthorizes write access, locks and consumes the receipt, and rechecks every binding. Expired, replayed, foreign-connection, wrong-project, wrong-artifact, guessed, and stale-after-concurrent-update receipts share one content-free failure. An older-version read does not issue a version-write receipt.

Legacy project-context tools remain temporarily available for backwards compatibility while the private-alpha artifact loop is validated. New host examples and evaluation coverage use the four-tool artifact interface.

The two Save tools only create short-lived preview records. They cannot create an artifact, version, accepted context, or trusted state. In the embedded MCP App, only the authenticated human's exact `Save selected` action commits the preview; the existing authenticated web fallback retains its exact `Save` action. Closing, ignoring, tampering with, deselecting the artifact in the app, or allowing a preview to expire saves nothing.

The compact embedded Save surface presents a complete artifact as one selectable item with its exact content and handoff collapsed for optional inspection. `Save selected` still commits the entire immutable snapshot; it never selects individual paragraphs or silently converts an artifact into conversation summaries. Successful commits create an immutable, project-scoped durable receipt in the same transaction. Reopening the embedded app reauthorizes current access and restores the saved version, destination name, time, and exact artifact link instead of showing the deleted preview as expired. The receipt contains no second artifact body. A foreign, guessed, inaccessible, or conflicting-connection receipt reference discloses nothing. This amendment does not alter the website Change log or web Save fallback.

Project-information selection is intentionally separate: one preview may contain multiple bounded candidate claims and commit only the human-selected subset. File attachment confirmation and byte transfer also remain separate. The host may choose the appropriate contract, but Alice does not claim that host classification is verified or that the host supplied a complete conversation history.

## Artifact and version model

`artifacts` stores the stable project-scoped identity. `artifact_versions` stores immutable complete snapshots. Each version records its parent version, source connection and provider, authenticated saver, timestamp, validated metadata, complete handoff snapshot, and exact content integrity metadata. A new version must be based on the version shown in its preview; a concurrent change makes the preview stale and requires a new review.

Alice's integer version is authoritative. A deterministic title parser recognizes only an explicit trailing `Vn` or `Version n` label. Search, retrieval, detail, and history render the stable title separately from the system-owned Alice version badge. A matching label is identified and removed from new stored metadata after appearing in the exact preview. A stored historical mismatch is not rewritten: the surface displays the stable title, authoritative Alice version, and mismatch notice. A proposed label that disagrees with the proposed Alice version, or a proposed stable title that differs from the freshly retrieved artifact identity, creates a prominently blocked preview; neither the embedded nor web Save action can commit it. A later fresh retrieval and corrected preview may create the next immutable version.

Activity is derived from intentional saved versions. The project Change log shows a readable reference—action, title, version, type, category, tags, source, local time, goal, and summary—without duplicating the artifact body or exposing hashes, storage keys, or internal JSON.

## Storage boundary

Private alpha accepts non-empty UTF-8 artifact text up to 48 KiB inline. It is stored with metadata and lineage in PostgreSQL. The schema admits an object-backed representation for future larger text, but the current MCP artifact tools do not claim that capability. Oversized text and binary work use the existing private Files path, where bytes live in versioned object storage and PostgreSQL retains metadata, provenance, access, scan, and lifecycle state.

An artifact version never stores both inline content and an object pointer. alice. never stores a second full copy in Activity or the Change log.

## Controlled taxonomy

Categories are a bounded 20-value enumeration. Tags are a bounded 30-value canonical enumeration exposed in the Save schemas. ChatGPT and Claude may select only those values; they cannot create, normalize, alias, or extend tags during alpha. Duplicate tags, unknown tags, unknown categories, unknown artifact types, oversized payloads, and unsafe extra fields fail schema validation before a preview exists.

The alpha vocabulary is intentionally small. It can be revised from observed use through a repository decision and schema migration, not through host-generated strings.

## Deterministic search

Search uses exact project permission scope plus deterministic matching across title, summary, goal, category, type, and canonical tags. It applies Unicode compatibility decomposition, removes combining marks, uses fixed English lowercase handling, converts punctuation and symbols (including dash variants) to spaces, collapses whitespace, and tokenizes the normalized query. It never searches artifact bodies. Filters for timeline, category, tag, source, artifact type, result limit, and continuation offset combine. No semantic inference, embedding lookup, or hidden model call occurs.

Ranking is fixed: exact normalized title, normalized query phrase in title, all query tokens in title, all query tokens distributed across searchable metadata, then partial-token matches. Every result exposes its match class; partial results are explicitly marked with matched and total query-token counts. Recency and stable artifact identity break ties only after match class. Results include total and returned counts, the applied limit, truncation state, and an exact next offset when more authorized matches exist. A zero-result response says that metadata non-match does not prove absence, forbids treating it as permission to overwrite or version a nearby artifact, and offers a safe broader search in the same project. `list_projects` is only a permission-filtered project catalog and is never an artifact inventory.

The authenticated website exposes the same boundary as a separate project `Artifacts` tab. Its compact browser provides search plus four controlled filters: category, tag, source AI, and time period. Artifact type remains visible on results and available to the MCP search contract, but is intentionally not another website control. Website search queries only current-version metadata and does not load or render full artifact bodies. Each result links to one artifact detail route; that separate request loads the complete selected snapshot and its lightweight immutable history. The current snapshot is the default, and an explicit positive version query selects one exact older snapshot.

Website list, search, current detail, and older-version reads independently reauthorize the signed-in user's current project membership. An archived project, ended membership, foreign artifact, unknown artifact, guessed project/artifact pair, or unavailable version returns the same content-free unavailable page. No title, count, source, version, timestamp, or project name is disclosed on denial.

Artifact content is rendered only after HTML escaping, preserving its text without interpreting stored markup or instructions. Handoff fields use the shared human-readable renderer. The page states that the source AI generated the material and that an authenticated human saved the exact snapshot; this preserves provenance without claiming that alice. verified the content or its assertions. Uploaded Files retain their own tab, object-storage, scan, preview, download, and lifecycle controls and never appear as artifacts merely because they were uploaded.

Artifact-body search, custom date ranges, pagination beyond the first 100 current artifacts, and unified search over legacy memories/decisions are explicit follow-on refinements. The first private-alpha browser proves complete artifact portability before broadening search UX.

## Project names and text-only hosts

Every artifact tool resolves an exact unique accessible project name server-side and accepts omission only for a sole accessible project. Legacy opaque project IDs remain compatible inputs but are absent from the model-visible catalog and project results. Missing multi-project selection returns only accessible names; ambiguous, conflicting, archived, unknown, and inaccessible references fail before artifact lookup or preview creation.

`search_alice` includes each usable artifact reference in both structured output and model-visible text. `get_artifact` includes the complete selected artifact and current handoff state in model-visible text as well as structured output. This keeps the ChatGPT/Claude handoff usable when a host consumes only MCP text content.

## Verification standard

The canonical integration test exercises this measurable loop:

1. ChatGPT prepares a complete artifact and creates no durable artifact before Save.
2. The exact web/app Save authority creates version 1.
3. Claude finds metadata and retrieves the complete current artifact and handoff.
4. Claude prepares a complete revision and creates no version before Save.
5. Save creates version 2 with Claude provenance.
6. ChatGPT retrieves version 2 by default, while optional history identifies both versions and an exact request can retrieve version 1.
7. Invented tags and ambiguous multi-project retrieval fail closed.
8. The Change log references both intentional saves without copying either artifact body.

The core alpha success question is whether this loop works reliably without copying, pasting, or re-explaining the work.
