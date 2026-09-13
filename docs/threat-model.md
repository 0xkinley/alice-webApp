# alice. Initial Threat Model

This document identifies minimum security properties for the spike and MVP. It is not yet a complete production threat assessment.

## Protected assets

- Project evidence and trusted state
- Candidate claims and review decisions
- User and workspace identity
- MCP access and refresh tokens
- Integration connection metadata
- Artifact references
- Audit history

## Trust boundaries

- ChatGPT, Claude, and other hosts are untrusted structured-input producers.
- Model-generated tool arguments are untrusted until validated.
- A valid user token does not imply access to every project.
- Artifact URLs and submitted source material may contain malicious instructions or content.
- The web review interface is the only MVP authority for trusted-state mutation.

## Primary threats

### Cross-tenant access

An authenticated user guesses another project's identifiers or exploits a missing workspace filter.

Minimum controls:

- deny-by-default row authorization
- workspace-aware foreign keys and constraints where possible
- caller-scoped database access
- explicit negative tests for every data path

Milestone 03 centralizes these controls in deny-by-default user and MCP-connection scopes. The connection policy requires a simultaneous match on internal user, private workspace, active connection, and registered client. Web and MCP project paths use the shared scopes, and composite foreign keys reject cross-workspace ownership at the database layer. Missing, guessed, mismatched, and revoked principals are policy-tested to produce no data and no write.

The complete two-user API and constraint matrix is recorded in `docs/tenant-isolation.md`. It verifies both tenant directions and compares real foreign identifiers with random guessed identifiers for non-disclosing equivalence.

### Confused-deputy writes

An AI host or prompt injection invokes a write tool without the user's real intent.

Minimum controls:

- tool description requires an explicit save request
- host confirmation where available
- write creates only evidence and candidates
- human review before trusted-state mutation
- visible provenance and revocation

The Milestone 04 capture evaluation gate scores disclosed correct and incorrect logical host traces. It requires exactly one capture selection for an explicit alice. save, forbids capture during ordinary, ambiguous, negative, and read-only requests, and rejects invented review or supersession MCP tools. The evaluation detects adapter-policy regressions; candidate-only writes and independent human review remain the runtime backstop when a host selects incorrectly.

### Silent canonical overwrite

A candidate, extraction process, or retry changes trusted state automatically.

Minimum controls:

- no MCP trusted-state mutation tool
- separate review action
- append-only evidence
- versioned accepted state
- explicit supersession

Milestone 03 additionally makes accepted-state rows database-immutable, permits only a single pending-to-terminal candidate status transition, and enforces the accepted candidate/evidence pair with a composite foreign key. A later acceptance of the same key creates the next version; current context selects the highest version without deleting history.

Milestone 04 adds explicit accept and reject forms only to the authenticated first-party web control plane. Acceptance versions trusted state; rejection creates no trusted row. Both decisions share a transaction with their immutable human-review audit event, and any audit failure restores the pending candidate. Terminal candidates cannot be accepted, rejected, or switched again. The MCP server imports no review operation and its advertised tool list contains no review action.

Ordinary acceptance cannot replace an established state key. Supersession is a separate authenticated-human route that must name the exact current accepted-state identifier. The transaction rejects stale, guessed, foreign, cross-key, and cross-project targets, then appends rather than updates: a new accepted version plus an immutable audit link to the superseded identifier/version. Audit failure rolls the candidate and new version back, leaving the prior current version intact.

### Evidence or audit rewriting

A compromised application path attempts to update or delete the source material or security history after the fact.

Minimum controls:

- database triggers reject every evidence and audit update or delete
- normal domain and HTTP interfaces expose append operations only
- composite tenant foreign keys bind evidence and audit rows to their workspace/project
- state-changing transactions append identifier-only audit metadata without credentials, bearer values, or submitted content
- tests exercise mutation and deletion attempts directly against the application database role

### Retry and replay duplication

Hosts retry tool calls and create duplicate evidence or candidates.

Minimum controls:

- caller-provided idempotency key
- unique idempotency constraint scoped to connection and project
- transactional evidence, candidate, and audit creation

Milestone 04 performs the idempotency lookup under the same immediate transaction as creation. Commit requires a complete receipt containing one immutable evidence event, every submitted candidate, and exactly one correlated audit event. Candidate or audit failure rolls all capture rows back. Identical retries return the original evidence, ordered candidate, audit, correlation, and provenance identifiers without another insert; different-payload reuse and partial stored receipts fail closed.

### Token leakage or misuse

OAuth tokens appear in logs, storage, errors, or are accepted for the wrong audience.

Minimum controls:

- OAuth 2.1 authorization code flow with PKCE
- issuer, audience/resource, expiry, client, and capability validation
- redacted logs
- short-lived access tokens and revocable connections
- no bearer tokens in application tables or analytics

Milestone 03 stores only SHA-256 digests of OAuth authorization codes, confidential client secrets, access tokens, and refresh tokens. Integration records contain tenant ownership, client classification, granted scopes, timestamps, and revocation state only. Revocation invalidates the full connection and both token classes. Tests compare issued secrets with stored digests and inspect safe audit metadata for bearer leakage.

Milestone 02 added repository and startup gates around the former spike-passphrase boundary. Milestone 03 supersedes that shared passphrase. Remote web and MCP origins still require HTTPS. The repository secret check rejects tracked `.env` files, high-confidence credential formats, and secret-like names under common browser-public environment prefixes. This scanner is a fast preventive check, not a substitute for provider-side secret scanning or credential rotation.

Milestone 03 removes the shared passphrase. User passwords are salted and scrypt-hashed; web sessions and OAuth bearer tokens are random, opaque, and stored only as SHA-256 digests. OAuth grants carry a server-resolved user and connection identifier. A dynamically registered client has no tenant authority until a user authenticates and grants access.

### Account and session compromise

An attacker guesses credentials, fixes a session, or reuses a stolen browser token.

Minimum controls:

- memory-hard, per-user salted password hashes
- fresh opaque session tokens after registration and login
- `HttpOnly`, `SameSite=Strict`, root-scoped cookies with `Secure` on HTTPS
- server-side logout revocation and bounded session lifetime
- generic invalid-credential responses
- deployment edge rate limiting before public self-service registration

### Sensitive overcollection

Alice stores conversation content the user did not intend to save.

Minimum controls:

- no passive history access
- explicit capture only
- bounded payloads
- store only the submitted evidence
- documented retention and deletion behavior before private alpha

### Adapter overreach

A fallback adapter reads more host data than the user deliberately chose to transfer, relies on host session credentials, or silently inserts or submits content.

Minimum controls:

- prefer official native integrations
- keep explicit handoffs previewable and user-initiated
- never read host cookies, tokens, browsing history, or unrelated tabs
- never use undocumented or reverse-engineered host endpoints
- if a browser companion is later justified, use temporary `activeTab` access and an explicit gesture
- capture only selected text and insert only a user-approved package
- fail closed when the intended host surface cannot be identified

Milestone 06.5 does not add a provider account adapter. A migration intent may contain only host-visible or user-supplied material and optional provider labels; those labels are provenance strings, not lookup authority. There is no provider credential, outbound provider request, project enumeration, cookie access, scraping, or source mutation. Exact local files remain a separate user-selected Alice upload, and provider-export archives/unknown schemas are not silently parsed. Account-wide unrelated history should be filtered locally before any relevant file is uploaded.

### Context poisoning

Unreviewed or malicious content is presented as project truth.

Minimum controls:

- normal context packages use accepted state only
- provenance accompanies assertions
- candidates are labeled and excluded by default
- conflicts and supersession remain visible

Milestone 05 keeps accepted decisions, accepted open questions, reference-only artifacts, and unresolved-conflict notices in separate typed sections. Artifact targets are never fetched during assembly. Conflict notices expose no pending value or summary, label pending alternatives unreviewed, and retain both the accepted provenance chain and pending candidate/evidence references. Rejected candidates are excluded. This warns about disagreement without promoting host-generated content or introducing a read-side mutation.

Milestone 06.5 migration snapshots remain immutable `UNVERIFIED_HOST_DERIVED` data even when they contain confident summaries, project instructions, decision language, or prompt injection. The migration tool cannot execute imported text, call another tool because of it, place it in accepted state, or classify it as Alice-confirmed. The preview and status UIs HTML-escape every supplied value. Turning any source into candidates, artifacts, exact files, or accepted state requires the existing independently authorized paths.

### Duplicate or destructive project migration

A retried host call, forged card, guessed session, or misleading provider identifier could create duplicate projects, disclose another migration, or imply that Alice moved/deleted the source.

Minimum controls:

- preview-only model tool and private app-only authority token;
- exact user, connection, registered client, payload hash, preview version, and expiry binding;
- one source-connection/intent idempotency constraint plus a transaction advisory lock;
- ordinary project authorization on every status/retry read and transition;
- immutable source records and append-only ordered events;
- fixed content-free error summaries and bounded monotonic counters;
- no provider credential, network request, or mutation path; and
- explicit supplied-scope, partial-fidelity, unverified-source, and original-unchanged copy in both model-visible and interactive output.

Deleting the Alice copy invokes only Alice's existing archive/request/privileged-erasure workflow. The ordered erasure dependency set removes migration source, event, and session rows before the project and contains no provider-side action.

### Wrong-artifact versioning and misleading title labels

A host may select a close-title artifact after an incomplete search, replay an old reference after a concurrent update, use a receipt from another connection/project, or embed `V4` in a title while Alice's stored version is 3.

Minimum controls:

- deterministic metadata search with explicit zero-result and partial-match semantics;
- a ten-minute single-use current-retrieval receipt bound to user, connection/client, project, artifact, immutable current version row, and stored title;
- independent read and version-preview authorization plus optimistic concurrency at commit;
- the same non-disclosing failure for expired, replayed, foreign, guessed, wrong-project, wrong-artifact, and stale receipts;
- deterministic stable-title parsing for explicit trailing version labels, with Alice's integer version always rendered separately and authoritatively;
- a blocked exact preview for a conflicting proposed version label or changed stable artifact identity; and
- no fallback from failed versioning to artifact creation or project-information capture.

Receipt issuance is a read-side security record, not trusted project state or human Save authority. The model can request a preview only after the exact read; the preview still cannot commit itself.

### Host-controlled artifact cleanup or redirection

A host may identify close-title duplicates but then attempt to archive, merge, supersede, delete, redirect, or version a non-canonical lineage without accountable human authority.

Minimum controls:

- no artifact-lifecycle MCP mutation tool;
- append-only lifecycle events under authenticated Owner/Editor web authority;
- exact same-project active replacement references for supersession;
- project authorization, audit, lifecycle-version concurrency checks, and non-disclosing failures;
- active-only default search with explicit authorized history filters;
- a clear authorized replacement pointer on superseded retrieval; and
- version-receipt denial plus independent preview/commit denial for superseded or archived artifacts.

Alice does not infer duplicates or choose a canonical artifact from prose. Production cleanup is outside implementation and requires a separate explicit human action.

### Semantic collision invention or host-controlled resolution

A host may claim two prose passages conflict, invent a decision key, hide one source value, or try to resolve a disagreement through MCP. It may also replay a resolution after one source has a newer current version.

Minimum controls:

- accept only validated explicit structured decision keys inside the exact human-reviewed artifact snapshot;
- compare exact keys and deterministic canonical JSON values only across current active versions in one authorized project;
- expose every source artifact/version, provider, saved time, and exact value without asserting correctness;
- bind resolution authority to a fingerprint of the complete current conflict set;
- permit resolution only as a separately authenticated Owner/Editor web action under a transaction lock;
- append immutable resolution and content-free audit records without rewriting sources or accepted state;
- deny Viewers and expose no MCP resolution tool; and
- state that free-form semantic contradictions are not inferred and a human selection is not Alice verification.

## Spike security gates

- Candidate tool calls cannot directly change trusted state.
- Every trusted decision is traceable to evidence and human approval.
- Cross-workspace access tests fail safely.
- Logs contain neither bearer tokens nor unsaved conversation history.
- Revoked connections cannot continue using alice. tools.
