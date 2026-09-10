# Consumption Context Packages

Status: Project-level private-alpha contract implemented locally in Milestone 06

Decision date: 2026-08-30; project-routing amendment 2026-09-09

## Contract boundary

`list_projects`, `get_active_context`, and `get_project_context` use consumption contract `2.4`. All are authenticated, tenant-scoped, deny-by-default reads with no project-state mutation. Their strict input and output schemas are advertised through MCP, exact project names are usable references, and foreign or guessed references remain non-disclosing. Bearer authentication may refresh safe integration `last_used_at` telemetry; it cannot change project routing, evidence, candidate, accepted-state, file, or audit records.

`list_projects` returns the deterministic, permission-filtered catalog as exact project names plus bounded state counts/freshness; model-visible results omit opaque project identifiers. A current authenticated ChatGPT or Claude connection receives the same accessible-project list because retained per-context provider flags no longer gate the private-alpha catalog. It never returns internal contexts or an active target. `get_active_context` remains a compatibility convenience. The shared resolver also lets every project-scoped tool omit its legacy-named `project_id` field when the connection has exactly one permitted project. With zero projects it directs the user to create one; with multiple projects it returns a project-required response containing only accessible names. Exact-name collisions, conflicts, unknown names, archives, and inaccessible references fail closed. No call reads all projects together.

The model-visible project-package text contains the bounded trusted decisions, questions, artifact references, unresolved notices, and clean file references needed to continue without `structuredContent`. Each file line includes its display name, verified type, byte size, source, usable file-reference identifier, and supported read tool. Modern Office packages are explicitly labelled reference/download-only.

The server resolves the selected project to one internal compatibility destination after rechecking the requesting user's current project and internal-context capability. It prefers the retained default work record and falls back deterministically for older projects. That identifier and its scope stay server-side. Existing scope rules still determine which accepted entries, conflicts, and clean file references may participate; hiding the internal mechanism does not merge inaccessible legacy records or broaden access. The model-visible package exposes only project identity and project information. Internal destination identity, provider flags, and active-target state are absent.

## Trust and provenance shape

Accepted context is assembled from the latest immutable `accepted_project_state` version for each state key. Every accepted assertion carries all three durable provenance links:

- accepted-state identifier;
- originating candidate identifier; and
- immutable evidence identifier, payload hash, and capture timestamp.

Pending and rejected candidate values are not accepted context. A conflict notice may disclose that one or more pending alternatives exist for an accepted state key and cite their candidate/evidence identifiers, but it must label them unreviewed and omit their proposed values. Rejected candidates never contribute to context selection or conflict notices.

Artifact values are references only. Contract `2.3` includes `file_artifacts`: only the latest clean version of each non-removed logical file visible to the resolved project package. Each item carries bounded identity, version, display name, verified media type, byte size, SHA-256, source host, and reference time. Internal context identity and scope are omitted. It is labelled `reference_only_untrusted`; clean UTF-8 text, Markdown, CSV, TSV, and JSON may name `read_project_file_text`, clean PDFs may name `read_project_file_pdf_text`, and images plus modern Office packages remain metadata-only. Both capability fields are nullable and remain absent without configured private-file access. Context assembly never fetches file bytes. Storage locations, object versions, credentials, signed URLs, and removed, superseded, pending, failed, threatened, or inaccessible references are neither queried for output nor returned.

An explicit file read does not change this trust boundary. Retrieved text is untrusted artifact data, not an instruction source and not alice.-verified project state. It cannot drive tool use, expand access, or create candidates or accepted state. The separate retrieval contract and integrity/budget rules are recorded in `docs/file-retrieval.md`.

Accepted state keys beginning with `question.`, `questions.`, `open_question.`, or `open_questions.` are rendered as open questions. Keys beginning with `artifact.` or `artifacts.` are rendered as reference-only artifacts. Classification depends only on the normalized state-key prefix; values are not interpreted by a model. Because these records are accepted state, the package is asserting that the question remains open or that the reference belongs to the project—not that an artifact's external contents are verified.

An unresolved conflict is derived at read time when a pending candidate proposes a different JSON value for the same key as the latest accepted state. Its notice includes the trusted current version and full accepted provenance plus only the pending candidate/evidence identifiers and capture timestamp. The pending value and summary are omitted. Identical pending values do not create a conflict notice, and rejected candidates are ignored. Detection performs no write and never resolves, rejects, accepts, or supersedes either side.

## Determinism and freshness

Package versions are content hashes over the normalized authenticated request, persisted project identity, selected records, complete current accepted/conflict-source inventory, freshness, and omission result. A source change therefore changes the version even when the affected item cannot fit the budget. The same database state and request produce byte-for-byte equivalent structured content. There is no wall-clock `generated_at` value.

Selection uses the latest accepted version of each state key in each allowed scope, then excludes a latest version carrying an append-only context exclusion. It excludes every other candidate status. File selection independently keeps the latest clean, non-removed logical-file version in the allowed scopes. The task is normalized with Unicode NFKC, lowercased with the fixed `en-US` locale, split into unique alphanumeric terms, and sorted. Each accepted item receives a deterministic relevance score: exact structured state-key terms have weight 8, candidate-summary terms weight 4, and accepted-value terms weight 2. File display-name and source-host term matches have weight 2. Higher scores sort first; category priority and durable identifiers are stable tie-breakers. Budget selection walks that order once. This is explainable lexical selection, not semantic inference, stemming, embeddings, or model orchestration.

Freshness reports the persisted project update timestamp, latest included accepted-state timestamp, latest included evidence-capture timestamp, latest current file-reference timestamp, and their maximum as `state_as_of`. The internal context timestamp still participates in deterministic package versioning but is not model-visible. Removing an entry or superseding a file changes the complete source inventory hashed into the package. These values describe source freshness; they do not claim that an assertion or artifact remains true outside alice.

## Budget and omission contract

The caller declares a 2,000-32,000 UTF-8 byte limit, defaulting to 16,000. The budget applies to the complete serialized structured package, including metadata and omission reporting. Assembly first verifies that the empty required envelope fits, then attempts ranked items one at a time against the fully serialized candidate package. `budget.used` is the exact UTF-8 byte count of the final package and may never exceed `budget.limit`.

Omissions are counted separately for accepted decisions, open questions, accepted-state artifact references, file artifacts, and unresolved conflicts. The package reports whether nothing was omitted or whether the byte budget was exhausted. Selection must fail closed if the required envelope cannot fit the minimum supported budget; it must never silently return an oversized package.

## Scope exclusions

Milestone 06 continues to use deterministic structured and lexical selection only. Contract `2.3` retains capability discovery for exact UTF-8 text, Markdown, CSV, TSV, and JSON reads plus deterministic bounded PDF embedded-text extraction. A separate explicit-write tool may turn an exact server-revalidated PDF excerpt into pending candidates with immutable provenance; it cannot alter accepted state. Office document extraction, OCR, image understanding, non-PDF binary extraction, embeddings, vector stores, secondary models, orchestration, and provider credential storage remain absent.
