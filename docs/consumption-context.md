# Consumption Context Packages

Status: In Progress for Milestone 05

Decision date: 2026-08-30

## Contract boundary

`list_projects` and `get_project_context` use consumption contract `1.0`. Both are authenticated, tenant-scoped, deny-by-default reads with no state-changing telemetry. Their strict input and output schemas are advertised through MCP, and foreign or guessed project identifiers remain indistinguishable.

`list_projects` returns deterministic project discovery metadata: identity, brief, project timestamps, current accepted-state count, and latest acceptance timestamp. `get_project_context` accepts a project identifier, a normalized task, and an optional maximum serialized-package budget measured in UTF-8 bytes.

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

Package versions are content hashes over the normalized authenticated request, persisted project identity, selected records, and omission result. The same database state and request therefore produce byte-for-byte equivalent structured content. There is no wall-clock `generated_at` value.

Selection uses the latest accepted version of each state key and excludes every other candidate status. The task is normalized with Unicode NFKC, lowercased with the fixed `en-US` locale, split into unique alphanumeric terms, and sorted. Each accepted item receives a deterministic relevance score: exact structured state-key terms have weight 8, candidate-summary terms weight 4, and accepted-value terms weight 2. Higher scores sort first; state key and accepted-state identifier are stable ordinal tie-breakers. Budget selection walks that order once. This is explainable lexical selection, not semantic inference, stemming, embeddings, or model orchestration.

Freshness reports the persisted project update timestamp, latest included accepted-state timestamp, latest included evidence-capture timestamp, and their maximum as `state_as_of`. These values describe source freshness; they do not claim that the underlying project assertion is still true outside alice.

## Budget and omission contract

The caller declares a 2,000-32,000 UTF-8 byte limit, defaulting to 16,000. The budget applies to the complete serialized structured package, including metadata and omission reporting. `budget.used` is the exact UTF-8 byte count of that package and may never exceed `budget.limit`.

Omissions are counted separately for accepted decisions, open questions, artifact references, and unresolved conflicts. The package reports whether nothing was omitted or whether the byte budget was exhausted. Selection must fail closed if the required envelope cannot fit the minimum supported budget; it must never silently return an oversized package.

## Scope exclusions

Milestone 05 uses deterministic structured and full-text selection only. It adds no embeddings, vector store, secondary model, orchestration, file intelligence, teams, sharing, organizations, or provider credential storage.
