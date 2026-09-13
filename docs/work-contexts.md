# Project and Work Contexts

Status: Internal compatibility foundation implemented for Milestone 06

Decision date: 2026-08-30

The 2026-09-09 project-first amendment removes Work Context from the product experience without destructively removing this mechanism. Migration `022_project_default_contexts.sql` is implemented: new writes use one hidden project default, and legacy records retain their original context scope and authorization. See [`docs/project-first-private-alpha-redesign.md`](project-first-private-alpha-redesign.md). The historical sections below describe the retained compatibility structures.

## Model

Projects created before migration `022` may retain one `Project-wide` context and named work contexts such as `General`. Projects created after migration `022` receive exactly one hidden all-members work record and one immutable `project_default_contexts` mapping; they receive no visible `Project-wide` or `General` row. The mapping is resolved only inside authorization and routing code and is excluded from web, MCP, and project-export presentation.

`work_contexts` carries the owning workspace/project composite key, creator, bounded name and description, kind, visibility, lifecycle timestamps, and stable identifier. Migration `003_work_contexts.sql` historically backfilled two default contexts; migration `022` adds a new empty hidden default to each existing project without changing those rows. Composite foreign keys and unique constraints bind exactly one mapping to one context in the same project. Database triggers and application-role grants reject mapping update and deletion outside the bounded erasure operator.

Migration `004_context_entries.sql` adds immutable candidate destinations and accepted-context entries. Every new host capture now resolves the exact authorized project to its hidden default, writes one destination per candidate in the capture transaction, and omits that destination from user/model presentation. Human acceptance copies the immutable target onto the accepted-state identifier in the same transaction. Database constraints prevent cross-project context links, and the application role cannot update or delete either mapping. Pre-context candidates and accepted rows remain attached to their historical project-wide context.

Context creation is an authenticated-human web action. It and the corresponding content-free project audit event plus append-only context-history event share one transaction. Context history stores identifiers and lifecycle actions, not project content. The constrained application role cannot update or delete history rows.

## Deterministic similarity

Before creating a context, alice. normalizes the proposed name/description with NFKC and lowercase tokenization, then scores existing permitted work contexts using fixed exact-name and name/description term weights. Results are ordered by score, name, and stable identifier. The same database state and input produce the same suggestions.

Suggestions never create, merge, rename, move, select, or broaden a context. The preview shows similar contexts and the exact proposed new context; only the user's explicit `Create this work context` POST creates it. Embeddings and model calls are absent.

## Permission boundary

The current creation path emits `all_members` contexts but remains scoped to the authenticated owner's workspace until the collaboration task introduces memberships and restricted grants. Foreign and guessed project identifiers return no context list, similarity result, history, or mutation. Context visibility is already constrained to the future enum (`all_members`, `selected_members`, or `personal`) so collaboration cannot invent an unbounded access mode.

Accepted version numbers remain globally monotonic for a project/state key, while the current-value/supersession check is context-specific. This permits the same stable key in separate work contexts without treating one context as a supersession of another, and the project/state advisory lock still serializes version allocation across concurrent contexts.

## Active connection targets

Migration `005_active_context_targets.sql` stores one explicit project/work-context target for each user connection. A target is bound by composite foreign keys to the same user/workspace connection and the same workspace/project context. Project-wide context cannot be selected directly; it is included automatically when a work context is consumed.

The connection center lists only the authenticated user's permitted projects and work contexts, shows the target on every connection card, and requires a human POST to change it. The user may deliberately apply one choice to all currently active connections. Each form carries opaque per-connection selection versions; PostgreSQL row locks and version comparison make a stale or concurrent submission fail with `409` instead of silently overwriting a newer target. Successful selections append content-free context-history and audit events.

An AI connection can read its own selection but cannot set or change it through MCP. Revoked and foreign connection identifiers, projects, and contexts return no target metadata and perform no mutation.
