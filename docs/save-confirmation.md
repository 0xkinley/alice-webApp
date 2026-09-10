# Exact Save Confirmation

Status: Single-action project Save implemented locally for Milestone 06

Decision date: 2026-08-30; project-routing amendment 2026-09-09

The 2026-09-09 project-first amendment retains one authenticated alice. `Save` action but removes visible context names, state keys, versions, hashes, identifiers, and raw JSON from the preview. See [`docs/project-first-private-alpha-redesign.md`](project-first-private-alpha-redesign.md). The 2026-09-10 resolver amendment lets the host supply one exact unique accessible project name, or omit it only when the connection has one permitted project. Neither an active target nor an internal context identifier may supply or override it. alice. resolves the internal project and compatibility destination only after reauthorizing the connection.

## Authority boundary

`save_project_update` creates one exact, immutable, short-lived preview and no durable evidence, candidate, Needs attention item, accepted state, or audit event. Its strict input accepts an optional legacy-named `project_id` as an exact name/reference; omission succeeds only for one permitted project. `context_id` is not accepted. A model-visible tool call cannot accept, supersede, reject, or otherwise activate project information.

`suggest_project_updates_from_file` preserves the same human authority boundary. Its eventual evidence carries server-generated exact PDF reference/version/content hash, extraction contract/range, excerpt hash, and source text, backed by an immutable relational source row. The preview labels that PDF evidence untrusted and renders readable provenance before the proposed information. Successful extraction or capture cannot activate a statement.

Only an authenticated alice. Save control can decide the preview. The page names the destination project, source host, capture time, readable proposed information, deliberately included source material, and any current saved information that will be replaced. Internal destination, access implementation, state keys, versions, hashes, and identifiers remain hidden. Host text, tool arguments, and model-generated confirmation fields cannot invoke the decision operation.

## One-decision transaction

One `Save` action consumes the exact unexpired preview authority and atomically persists immutable evidence, internal candidate provenance, accepted versions, and the human-review audit. State-key advisory locks are acquired in stable order, so the complete save either commits or rolls back. Replacement is allowed only when the exact preview showed the current project-level value; earlier versions and provenance remain immutable history.

There is no Cancel, cross, Not now, accept, reject, or suggestion control in this routine path. Closing, ignoring, navigating away, or expiry is no action and creates no project state. Expired undecided previews are purged under the bounded retention contract.

## Exactness, races, and fallback

The app receives a random authority through tool-result metadata; only its digest is stored. The exact preview version covers the project, proposal content, current replacement snapshot, and authority. Missing, changed, consumed, expired, inaccessible, or concurrently submitted previews fail closed. PostgreSQL locks ensure that simultaneous Save attempts produce one complete winner rather than partial or duplicate activation.

The portable MCP App is shared by ChatGPT and Claude. When a host cannot render it, an authenticated alice.-controlled web preview provides the same one-button authority. Foreign and guessed preview identifiers return the same not-found response, reveal no project or proposal metadata, and cannot save anything.

## Attachment transfer states

An attachment preview distinguishes human confirmation from byte transfer. Before the click it says `Waiting for confirmation`; after `Save` it says `Transfer authorized` and `Waiting for transfer`, never `Saved`. The host may transfer the exact bytes through its supported capability. When it cannot, the same exact preview offers an alice.-controlled browser fallback with the destination project locked and the expected filename visible.

User-facing transfer progress uses only truthful states: `Waiting for transfer`, `Uploading`, `Scanning`, `Available`, `Transfer unavailable`, and `Scan failed`. `Available` appears only after exact name/type/size/hash validation, immutable storage, both clean private-file security results, authorization revalidation, and project-reference creation. The file remains an untrusted reference and does not become accepted project information merely because it became available.
