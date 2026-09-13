# Active Context Removal

Status: Implemented for the single-user Milestone 06 loop

Decision date: 2026-08-30

## User action and authority

An authorized alice. user can open a removal preview from a current Saved context entry. The preview is bound to the exact authenticated user scope, project, context, accepted-state identifier, state key, value, version, and acceptance time. Submitting a stale or mismatched preview fails closed. Merely opening the page performs no mutation.

The confirmation appends one `context_entry_exclusions` record, one content-free context history event, and one audit event. PostgreSQL serializes decisions for the state key so concurrent confirmations cannot silently produce two exclusions. Foreign and guessed identifiers return the same not-found response and cannot disclose content, counts, provenance, or conflict state.

## Data and lifecycle semantics

Removal means “stop using this saved version as active context in this exact context.” It does not mean rejection, project archive, export, or permanent privacy deletion. The accepted-state version, candidate, immutable evidence payload, accepted-context mapping, and audit history remain unchanged. Ordinary application roles cannot update or delete the exclusion.

The Saved context view and normal MCP consumption omit an excluded latest version. The Removed and History views retain the value, source provenance, removal time, and optional human reason. If a selected work-context override is removed, an active project-wide value for the same state key may become effective again under the normal layering rule.

A later exact confirmed save for the same context and state key creates a new accepted version. Its preview explicitly says that the removed key will be restored; it never reverses or rewrites the earlier exclusion. This append-only chain preserves what was saved, what was removed, and what later became active.

## Repair and supersession

The Saved context view offers a repair action for a current value that the human identifies as stale, contradicted by reliable information, or wrong as stated. The repair page shows the exact current value and provenance before the human confirms. Confirmation uses the same serialized, stale-safe exclusion transaction as ordinary removal and records the bounded classification plus an optional explanation. It never edits the accepted row or manufactures a replacement.

A corrected value must arrive as a new evidence-backed candidate and pass its own exact human confirmation. Once accepted, the prior value remains visible in History as `Superseded`, including the replacement version number, while only the latest non-excluded version is active. Project and context Viewers cannot open or submit repair/removal controls.

## Explicit non-goals

This control does not archive a context or project, export data, erase source bytes, remove backup copies, or execute a privileged privacy deletion. Those actions require separate controls, consequences, authorization, retention rules, and verification.
