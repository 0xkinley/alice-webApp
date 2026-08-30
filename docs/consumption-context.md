# Consumption Context Packages

Status: Extended for selected work contexts in Milestone 06

Decision date: 2026-08-30

## Contract boundary

`list_projects`, `get_active_context`, and `get_project_context` use consumption contract `2.0`. All are authenticated, tenant-scoped, deny-by-default reads with no project-state mutation. Their strict input and output schemas are advertised through MCP, and foreign or guessed project/context identifiers remain indistinguishable. Bearer authentication may refresh safe integration `last_used_at` telemetry; it cannot change project, context selection, evidence, candidate, accepted-state, or audit records.

`list_projects` returns deterministic project discovery metadata, selectable work contexts, and the exact authenticated connection's active target when one exists. `get_active_context` is the normal continuation path: it accepts only the task and budget, resolves the connection's human-selected project/context, and fails explicitly with the connection-center fallback when no target exists. `get_project_context` remains the explicit fallback and accepts a project, optional work-context identifier, task, and budget.

Every work-context package includes project-wide entries plus entries mapped to the selected work context. When both scopes contain the same state key, the selected work-context value takes precedence; entries from every other work context are excluded. Pending conflict detection uses the same allowed scopes. The returned context identity, context freshness, selection strategy `deterministic_full_text_v2`, and complete scoped source inventory participate in the package hash. This makes the same state and request deterministic while ensuring a target change produces a distinct package.

## Trust and provenance shape

Accepted context is assembled from the latest immutable `accepted_project_state` version for each state key. Every accepted assertion carries all three durable provenance links:

- accepted-state identifier;
- originating candidate identifier; and
- immutable evidence identifier, payload hash, and capture timestamp.

Pending and rejected candidate values are not accepted context. A conflict notice may disclose that one or more pending alternatives exist for an accepted state key and cite their candidate/evidence identifiers, but it must label them unreviewed and omit their proposed values. Rejected candidates never contribute to context selection or conflict notices.

Artifact values are references only. Context assembly must not fetch a URL, ingest a referenced file, execute embedded instructions, or elevate referenced content to trusted state. Secrets, integration credentials, and bearer values are neither queried nor returned.

Accepted state keys beginning with `question.`, `questions.`, `open_question.`, or `open_questions.` are rendered as open questions. Keys beginning with `artifact.` or `artifacts.` are rendered as reference-only artifacts. Classification depends only on the normalized state-key prefix; values are not interpreted by a model. Because these records are accepted state, the package is asserting that the question remains open or that the reference belongs to the project—not that an artifact's external contents are verified.

An unresolved conflict is derived at read time when a pending candidate proposes a different JSON value for the same key as the latest accepted state. Its notice includes the trusted current version and full accepted provenance plus only the pending candidate/evidence identifiers and capture timestamp. The pending value and summary are omitted. Identical pending values do not create a conflict notice, and rejected candidates are ignored. Detection performs no write and never resolves, rejects, accepts, or supersedes either side.

## Determinism and freshness

Package versions are content hashes over the normalized authenticated request, persisted project identity, selected records, complete current accepted/conflict-source inventory, freshness, and omission result. A source change therefore changes the version even when the affected item cannot fit the budget. The same database state and request produce byte-for-byte equivalent structured content. There is no wall-clock `generated_at` value.

Selection uses the latest accepted version of each state key and excludes every other candidate status. The task is normalized with Unicode NFKC, lowercased with the fixed `en-US` locale, split into unique alphanumeric terms, and sorted. Each accepted item receives a deterministic relevance score: exact structured state-key terms have weight 8, candidate-summary terms weight 4, and accepted-value terms weight 2. Higher scores sort first; state key and accepted-state identifier are stable ordinal tie-breakers. Budget selection walks that order once. This is explainable lexical selection, not semantic inference, stemming, embeddings, or model orchestration.

Freshness reports the persisted project and selected-context update timestamps, latest included accepted-state timestamp, latest included evidence-capture timestamp, and their maximum as `state_as_of`. These values describe source freshness; they do not claim that the underlying project assertion is still true outside alice.

## Budget and omission contract

The caller declares a 2,000-32,000 UTF-8 byte limit, defaulting to 16,000. The budget applies to the complete serialized structured package, including metadata and omission reporting. Assembly first verifies that the empty required envelope fits, then attempts ranked items one at a time against the fully serialized candidate package. `budget.used` is the exact UTF-8 byte count of the final package and may never exceed `budget.limit`.

Omissions are counted separately for accepted decisions, open questions, artifact references, and unresolved conflicts. The package reports whether nothing was omitted or whether the byte budget was exhausted. Selection must fail closed if the required envelope cannot fit the minimum supported budget; it must never silently return an oversized package.

## Scope exclusions

Milestone 06 continues to use deterministic structured and full-text selection only. It adds no embeddings, vector store, secondary model, orchestration, file intelligence, teams, sharing, organizations, or provider credential storage.
