# Artifact Handoff Contract

Status: Accepted for Milestone 06  
Decision date: 2026-09-10

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

Legacy project-context tools remain temporarily available for backwards compatibility while the private-alpha artifact loop is validated. New host examples and evaluation coverage use the four-tool artifact interface.

The two Save tools only create short-lived preview records. They cannot create an artifact, version, accepted context, or trusted state. Only the authenticated human's exact `Save` action—through the embedded app or authenticated web fallback—commits the preview. Closing, ignoring, tampering with, or allowing a preview to expire saves nothing.

## Artifact and version model

`artifacts` stores the stable project-scoped identity. `artifact_versions` stores immutable complete snapshots. Each version records its parent version, source connection and provider, authenticated saver, timestamp, validated metadata, complete handoff snapshot, and exact content integrity metadata. A new version must be based on the version shown in its preview; a concurrent change makes the preview stale and requires a new review.

Activity is derived from intentional saved versions. The project Change log shows a readable reference—action, title, version, type, category, tags, source, local time, goal, and summary—without duplicating the artifact body or exposing hashes, storage keys, or internal JSON.

## Storage boundary

Private alpha accepts non-empty UTF-8 artifact text up to 48 KiB inline. It is stored with metadata and lineage in PostgreSQL. The schema admits an object-backed representation for future larger text, but the current MCP artifact tools do not claim that capability. Oversized text and binary work use the existing private Files path, where bytes live in versioned object storage and PostgreSQL retains metadata, provenance, access, scan, and lifecycle state.

An artifact version never stores both inline content and an object pointer. alice. never stores a second full copy in Activity or the Change log.

## Controlled taxonomy

Categories are a bounded 20-value enumeration. Tags are a bounded 30-value canonical enumeration exposed in the Save schemas. ChatGPT and Claude may select only those values; they cannot create, normalize, alias, or extend tags during alpha. Duplicate tags, unknown tags, unknown categories, unknown artifact types, oversized payloads, and unsafe extra fields fail schema validation before a preview exists.

The alpha vocabulary is intentionally small. It can be revised from observed use through a repository decision and schema migration, not through host-generated strings.

## Deterministic search

Search uses exact project permission scope plus normal deterministic matching across title, summary, goal, category, type, and canonical tags. Filters for timeline, category, tag, source, artifact type, and result limit combine. No semantic inference, embedding lookup, or hidden model call occurs.

Custom date ranges and unified search over legacy memories/decisions are follow-on search refinements. The first private-alpha handoff proves complete artifact portability before broadening search UX.

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
