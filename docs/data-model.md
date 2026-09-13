# alice. Minimum Data Model

This is the conceptual minimum. PostgreSQL migration `001_initial.sql` is the production schema beginning in Milestone 06.

## Identity and tenancy

### Users

Application identity with a stable internal identifier and normalized unique email. Milestone 03 uses salted scrypt password digests; an external identity provider can later replace the verifier without changing tenant identifiers.

### Workspaces

One private workspace is automatically created per MVP user.

The user and workspace are inserted transactionally. A unique constraint on `workspaces.user_id` enforces exactly one workspace per user. Workspaces are not merged for collaboration: a project stays anchored to its creator's workspace and gains explicit user memberships around that project.

### Projects

Projects belong to a private workspace. Every tenant-owned record carries the workspace identifier even when it can be derived through the project.

Composite workspace/project foreign keys prevent a record from naming a project in another workspace.

Project identifiers are random server-generated UUID-based values. Names are unique within a workspace but not globally. Migration `010_project_memberships.sql` backfills and automatically creates exactly one Owner membership for every project. Active memberships use Owner, Editor, or Viewer roles and retain ended rows rather than deleting history. Database triggers reject membership deletion, ended-row rewrites, and demotion of the last active Owner.

Project invitations are expiring, single-recipient, Editor-or-Viewer grants. Only the random token digest is stored. The exact signed-in normalized email can preview, accept, or decline; an Owner can revoke a pending invitation or replace it with a new token that invalidates the old one. Acceptance, decline, replacement, revocation, role change, ownership transfer, departure, and member removal append content-free audit events. Project authorization requires an active membership rather than project-workspace ownership. Ownership transfer promotes the successor before demoting the actor, and the final active Owner cannot be demoted or ended.

Migration `013_project_lifecycle.sql` adds a paired archive time/actor to projects and an append-preserving deletion-request queue. Ordinary project authorization requires an unarchived project; a dedicated Owner-only lifecycle scope can resolve active or archived projects for exact archive/restore, permission-filtered export, request, and cancellation actions. Archive revokes pending invitations and clears active connection targets without deleting project intelligence. A deletion request stores immutable requester/request/not-before fields and permits only one-way cancellation. The runtime database role can update only the archive pair or cancellation pair and cannot delete either project or request. No privileged erasure executor exists yet.

### Work contexts

Migration `003_work_contexts.sql` historically backfilled `Project-wide` and `General` records. Project-first migration `022_project_default_contexts.sql` leaves every such row unchanged and adds one empty hidden default plus one immutable mapping for each existing project. New projects transactionally create only that hidden default and mapping. Context rows retain workspace/project composite keys, creator, kind, bounded name/description, visibility, and lifecycle timestamps, but the context model is now an internal compatibility and authorization mechanism rather than a product-visible hierarchy.

Context-history rows are append-only through database triggers and the constrained application role. Deterministic normalized full-text scoring may suggest an existing context, but only an explicit human web action creates a new context. Suggestions perform no grouping, selection, permission change, or trusted-state write.

Migration `011_context_access.sql` adds append-preserving context grants tied to the exact active project membership. Grants exist only for `selected_members` contexts and use Viewer, Editor, or Manager roles bounded by the project role. Project-wide and `all_members` contexts derive their role from membership; `personal` contexts are creator-only; selected-context creators are implicit Managers while active. Owners have no automatic access to restricted or personal contexts. Grant identities and terminal history cannot be rewritten or deleted. Membership downgrade/departure cannot leave an incompatible active grant, and departure is blocked when it would orphan a personal context or a selected context without another Manager.

Candidate destinations and accepted-context entries are separate immutable mappings so the pre-context evidence/candidate/accepted tables are never rewritten. Migration `004_context_entries.sql` backfills existing records to the project-wide context. New capture writes a candidate target in the evidence transaction, and acceptance writes the corresponding accepted-context entry in the human-review transaction. Composite foreign keys prohibit a candidate or accepted identifier from being attached to another project or workspace.

Project-level writes resolve the hidden mapping after current human or connection authorization. Project-level reads separately authorize every legacy source. A current hidden-default value wins; otherwise canonical-JSON-equivalent permitted legacy values may render once, while disagreement produces a value-free unresolved notice and excludes every alternative. Inaccessible legacy names, values, counts, freshness, provenance, conflicts, and files never enter the package. Project file aggregation similarly deduplicates an authorized shared immutable object only at presentation time and preserves every underlying reference.

## Project intelligence

### Evidence events

Immutable records of explicitly submitted material. Store the exact validated MCP payload, provenance, idempotency key, content hash, and timestamps.

For the Milestone 01 spike, the validated payload is serialized once, hashed with SHA-256, and inserted in the same database transaction before any candidate claim. Candidate foreign keys require the evidence row to exist first. Database triggers reject evidence updates and deletes; an idempotent retry may only reuse an existing event when its payload hash matches.

Milestone 03 retains those triggers in the versioned tenant schema and adds composite workspace/project/connection foreign keys. Migration `011_context_access.sql` separates `evidence_events.workspace_id`, which is the destination project workspace, from `connection_workspace_id`, which proves ownership of the collaborator's personal integration connection. Evidence insertion, candidate insertion, and its audit event share one transaction. Normal application code exposes no evidence update or delete operation.

Milestone 04 moved the idempotency lookup inside the same SQLite `BEGIN IMMEDIATE` transaction. Milestone 06 replaces that lock with a PostgreSQL transaction-scoped advisory lock derived from connection, project, and idempotency key under `READ COMMITTED`. A new save cannot commit unless the immutable evidence row, every candidate in submitted order, and exactly one correlated audit event are all readable as one complete receipt. Any candidate or audit failure rolls the entire capture back. The audit receipt stores only safe identifiers, counts, the evidence hash, and correlation data; source notes, source context, candidate values, and bearer material remain absent.

The idempotency uniqueness scope is the authenticated integration connection plus project plus caller key. An identical validated payload returns the original ordered evidence/candidate/audit identifiers and provenance without inserting anything. A different payload under the same key fails closed. Retry reconstruction uses the immutable evidence payload's candidate order rather than UUID sort order, and a partial or inconsistent stored receipt fails closed instead of being repaired or duplicated.

Migration `014_pdf_evidence_sources.sql` adds an optional one-to-one immutable source row for evidence created by `suggest_project_updates_from_file`. It binds the evidence to the exact workspace/project/source context, file reference and object, logical-file version, content SHA-256, fixed extraction version, Unicode range, excerpt SHA-256, and capture time. Composite foreign keys require the reference and object to be the exact pair already attached to that context. The capture layer additionally requires a current clean PDF, exact payload/source agreement, and a project-wide or destination-matching context. The evidence, file source, candidates, targets, and audit commit atomically; a file-backed retry is incomplete unless all are present. Runtime roles and triggers reject source-row update and deletion.

### Candidate claims

Untrusted proposed decisions, facts, requirements, constraints, preferences, or open questions. Each candidate references its source evidence.

Submitted candidate content is immutable. Its only permitted update is one transition from `pending` to the terminal `accepted` or `rejected` status; deletion and further status changes are database-rejected. Candidate creation never inserts accepted state.

The capture receipt returns each candidate identifier with its current review status. A retry after human review reports the terminal status but never changes it, creates a new audit event, or rewrites the original evidence.

Accept and reject are explicit authenticated-human transactions. Acceptance inserts the next immutable accepted-state version, changes the candidate to `accepted`, and appends `candidate_accepted`; rejection changes the candidate to `rejected` and appends `candidate_rejected` without inserting trusted state. The audit event carries the reviewer identifier plus candidate/evidence/state identifiers and a correlation ID. An audit failure rolls the whole review decision back, and a terminal candidate cannot be reviewed again.

For an established state key, acceptance is replaced by an explicit supersession transaction. A stale supersession target or failed audit leaves both the current trusted version and pending candidate unchanged.

### Accepted project state

Versioned trusted state accepted by a human. Acceptance creates a traceable state record; it never overwrites or detaches prior history.

The web review control plane calls the tenant-scoped acceptance domain operation. In one transaction it locks the pending candidate and the workspace/project/state-key review target, allocates the next version, inserts an immutable accepted row, transitions the candidate to `accepted`, and appends the human-review audit event. A composite foreign key requires the accepted row's candidate and evidence identifiers to be the exact pair recorded on the candidate. Database triggers reject accepted-state updates and deletes.

Milestone 04 separates first acceptance from supersession. Ordinary acceptance is valid only when the project/state key has no accepted row. When trusted state already exists, the human must invoke the dedicated supersession operation with the exact currently accepted identifier shown by the review queue. The operation verifies that identifier is still the latest same-tenant, same-project, same-key version, inserts the next immutable accepted row, and appends an immutable `accepted_state_superseded` audit event linking old and new accepted identifiers and versions plus candidate/evidence provenance. The prior accepted row is never marked, rewritten, detached, or deleted; current context remains the highest version.

### Conflicts

Records disagreement between candidates or accepted values for the same state key. Conflict detection must not resolve or supersede state automatically.

Milestone 05 derives an unresolved conflict signal during context reads when a pending candidate has the same state key but a different serialized JSON value from the latest accepted version. This adds no mutable conflict table and performs no state change. Context exposes the accepted provenance and pending candidate/evidence references but omits the pending value, labels the signal unresolved and unreviewed, ignores rejected candidates, and leaves resolution entirely in the existing authenticated human review flow.

### Artifacts

Project references such as URLs, uploaded file metadata, and bounded untrusted extraction evidence.

Milestone 05 classifies accepted state under the `artifact.` or `artifacts.` prefix as a reference-only artifact. The reference value retains accepted-state/candidate/evidence provenance, but assembly neither fetches the target nor treats its external contents as verified. Accepted `question.`, `questions.`, `open_question.`, and `open_questions.` state keys are similarly represented as open questions rather than trusted decisions.

Milestone 06 keeps uploaded objects and immutable metadata separate. Deterministic PDF embedded-text extraction never creates an artifact or candidate by itself. An explicit file-suggestion capture retains the exact excerpt inside evidence and its exact file/extraction link in `evidence_file_sources`; the proposed claims remain ordinary pending candidates. Malware-clean and successfully extracted remain distinct from human-accepted.

Complete artifact snapshots may carry bounded `decision_records_json`: explicit validated decision keys paired with exact JSON values. The retained empty-array default keeps older application images able to insert artifact versions after the additive migration. `artifact_decision_resolutions` is append-only and project-scoped; it binds one human-selected current artifact/version/value to a SHA-256 fingerprint of an exact conflict set. A composite foreign key prevents selecting a version from another artifact or project. Resolution records do not change artifact versions or accepted state, and a new current version produces a different conflict fingerprint.

## Integrations and audit

### Integration connections

Records which authenticated MCP client a user connected, granted capabilities, first and last use, and revocation status. Do not store ChatGPT or Claude passwords. Do not log bearer tokens.

Each authorization grant creates a connection bound by foreign keys to the user, private workspace, and dynamically registered OAuth client. The row stores the bounded scope grant, safe client classification, first-connected timestamp, last-use timestamp, and optional revocation timestamp. Authorization codes, OAuth client secrets, access tokens, and refresh tokens are persisted only as SHA-256 digests in their protocol tables; plaintext values exist only in the immediate protocol request/response path.

### Context read events

Migration `012_context_read_events.sql` adds immutable receipts for MCP package attempts. A successful receipt records the authenticated user-owned connection, safe client classification, legacy route enum, currently authorized project/internal destination, deterministic package version, UTF-8 byte size, and timestamp. The 2026-09-09 project-routing amendment reuses `active_target` to record the single-project convenience lookup and `explicit_fallback` to record an exact named-project lookup; neither value means an active target was consulted. A failed receipt retains the bounded legacy failure enum for schema compatibility. Internal destination identifiers are displayed only through permission-filtered legacy administration, never in the project-first or model-visible experience.

Read receipts intentionally omit task text, package contents, accepted values, evidence/candidate content, emails, and bearer material. Only the connection owner can list their receipts, and current project/context authorization is rechecked before historical destination metadata is shown. The authenticated package-preview path assembles the same deterministic JSON but creates no receipt, because a browser preview is not an AI-host retrieval. Database triggers and the constrained application role reject receipt updates and deletes.

### Derived product signals

Private-alpha workflow signals add no mutable analytics authority and no content event table. They aggregate existing connection ownership, read-receipt status/timestamps, candidate terminal status/counts, and content-free exact-decision/repair audits. Queries deliberately do not select evidence payloads, candidate/accepted values or summaries, removal explanations, task text, project/context display metadata, emails, or credentials. Cross-host project identifiers are used only as in-memory grouping keys and are never returned by the signals view.

### Derived access and security view

The project access-and-security page adds no access-control or activity table. It derives current membership and context audiences from active membership, context visibility, creator identity, and active grants; derives the signed-in user's connection status from that user's connection rows; and derives recent security history from append-only audits. Context discovery is performed through the same authorization path as project consumption, so inaccessible selected-member and personal contexts are not returned even to a project Owner.

The history projection uses a fixed action allowlist and does not return `safe_metadata_json`, correlation identifiers, grant/membership identifiers, bearer material, or evidence content. Context-bound events are displayed only when their content-free `context_id` resolves to a context currently visible to the viewer. Other users' active-target events and connection rows are not included.

### Audit events

Append-only records of security- and state-relevant actions. Store identifiers, safe metadata, and correlation IDs rather than unsaved conversation content.

The current action set covers registration, session creation and revocation, project and work-context creation, project invitation and membership lifecycle, ownership transfer, context grant lifecycle, integration authorization and revocation, candidate submission, and human acceptance and rejection. Audit insertion participates in the transaction for the associated state change. Database triggers reject every audit update and delete. Metadata excludes passwords, session values, invitation and bearer tokens, email addresses, context names/descriptions, and submitted evidence content.

## Required invariants

- Deny access by default.
- Authorize from authenticated identity and an active project membership as collaboration paths are admitted, never a caller-supplied workspace, project, membership, or role identifier alone.
- Evidence and audit history are append-only through normal application roles.
- Candidate creation does not change trusted state.
- Trusted state always references the accepted candidate and source evidence.
- Supersession preserves the prior state record.
- Cross-workspace references are prevented by database constraints and tested authorization policies.

Milestone 03 implements these rules as two shared deny-by-default scopes: a user scope resolves exactly one private workspace, while an MCP connection scope additionally proves an active connection owned by that user/workspace and registered client. Project operations do not accept a workspace argument from callers. Missing or mismatched scope is handled before any project query or write transaction.
