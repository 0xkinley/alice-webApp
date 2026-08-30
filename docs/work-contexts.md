# Project and Work Contexts

Status: Durable single-user foundation implemented for Milestone 06

Decision date: 2026-08-30

## Model

Every project has exactly one `Project-wide` context and at least one selectable work context. New projects receive `General` as their initial work context. Project-wide context is intended for active entries that should accompany every selected work context; a work context represents a bounded stream such as launch planning, pricing, research, or a feature.

`work_contexts` carries the owning workspace/project composite key, creator, bounded name and description, kind, visibility, lifecycle timestamps, and stable identifier. Migration `003_work_contexts.sql` backfills both default contexts for every existing project. A partial unique index enforces one project-wide row, and project names are case-insensitively unique within the project.

Migration `004_context_entries.sql` adds immutable candidate destinations and accepted-context entries. Every new host capture resolves an authorized explicit context or defaults to the project-wide context, writes one destination per candidate in the capture transaction, and returns that destination in its receipt and review URL. Human acceptance copies the immutable target onto the accepted-state identifier in the same transaction. Database constraints prevent cross-project context links, and the application role cannot update or delete either mapping. Pre-context candidates and accepted rows are backfilled to their project's project-wide context.

Context creation is an authenticated-human web action. It and the corresponding content-free project audit event plus append-only context-history event share one transaction. Context history stores identifiers and lifecycle actions, not project content. The constrained application role cannot update or delete history rows.

## Deterministic similarity

Before creating a context, alice. normalizes the proposed name/description with NFKC and lowercase tokenization, then scores existing permitted work contexts using fixed exact-name and name/description term weights. Results are ordered by score, name, and stable identifier. The same database state and input produce the same suggestions.

Suggestions never create, merge, rename, move, select, or broaden a context. The preview shows similar contexts and the exact proposed new context; only the user's explicit `Create this work context` POST creates it. Embeddings and model calls are absent.

## Permission boundary

The current creation path emits `all_members` contexts but remains scoped to the authenticated owner's workspace until the collaboration task introduces memberships and restricted grants. Foreign and guessed project identifiers return no context list, similarity result, history, or mutation. Context visibility is already constrained to the future enum (`all_members`, `selected_members`, or `personal`) so collaboration cannot invent an unbounded access mode.

Accepted version numbers remain globally monotonic for a project/state key, while the current-value/supersession check is context-specific. This permits the same stable key in separate work contexts without treating one context as a supersession of another, and the project/state advisory lock still serializes version allocation across concurrent contexts.
