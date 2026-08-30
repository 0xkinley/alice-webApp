# Saved Context View

Status: Implemented for the single-user Milestone 06 loop

Decision date: 2026-08-30

## Product language

The authenticated project screen links every project-wide or work context to one scoped lifecycle view:

- **Saved context** shows only the latest human-confirmed value for each state key in that exact context.
- **Needs attention** shows pending proposals and links each one to its evidence-bound exact save preview.
- **Removed** is reserved for content that was previously active and later removed. A cancelled or rejected proposal is not mislabeled as removed.
- **History** shows saved, pending, and not-saved proposals as a chronological record without presenting inactive material as current.

Internal evidence, candidate, and accepted-state identifiers remain available under optional Source and history or Provenance disclosures. Users can understand the current state and next action without learning those internal terms, while support and audit work retain the complete trace.

## Scope and trust

Context switching is explicit. The view queries the exact selected context rather than silently layering another work context or project-wide content into its management screen. Saved context uses the latest accepted version per context/state key; pending and rejected values never appear in the Saved context section. Normal MCP consumption continues to apply its documented project-wide-plus-selected-context layering separately.

The initial Removed section is an honest empty state until the append-only removal task is implemented. It does not infer removal from rejection, cancellation, supersession, or absence.

All queries derive workspace scope from the authenticated alice. user. Foreign and guessed project/context identifiers produce the same not-found result and reveal no names, values, counts, history, freshness, or provenance.
