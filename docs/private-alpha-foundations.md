# Private Alpha Foundations

Status: Accepted for Milestone 06; implementation in progress

Decision date: 2026-08-30

## Purpose

Hands-on testing after Milestone 05 proved the core cross-host consumption loop but exposed too much setup and governance friction for friend testing. The current two-process SQLite topology also cannot safely support an independently deployed hosted alpha, and the one-private-workspace model cannot express the requested project collaboration.

Milestone 06 must make the experience deployable, understandable, and low-friction before recruitment. This document records the product and architectural direction plus dated implementation boundaries. A described control exists only when its implementation note and verification evidence say so.

## Invariants that do not change

- AI hosts are untrusted structured-input producers.
- An MCP write creates immutable evidence and candidate claims only.
- A model cannot assert that a human clicked, consented, reviewed, or accepted something.
- Only an explicit authenticated human action on the exact proposed content can activate it as project context.
- Accepted context remains versioned and traceable through accepted state, candidate, and evidence provenance.
- Pending, rejected, removed, and inaccessible content is excluded from normal context by default.
- Ordinary application roles cannot update or delete immutable evidence or audit history.
- Secrets and provider configuration remain server-side. Collaborators never share host passwords or plaintext bearer tokens.
- Project and context access remains deny-by-default, including for guessed identifiers and metadata-only paths.

## Product model

### Projects and work contexts

A project is the durable collaboration and ownership boundary. Inside it, users may create work contexts for related streams such as launch planning, competitor research, pricing, or a specific feature.

Each request may use:

1. permitted project-wide active context; and
2. the selected work context's permitted active entries.

Before host work, alice. shows the user's permitted projects and contexts. The user selects an existing context or creates a new one. Active targets are scoped per user and connected host, with a visible option to apply a selection to both of that user's connected hosts. A single invisible global selection is unsafe because concurrent ChatGPT and Claude sessions could write to the wrong destination.

Context similarity begins with deterministic normalized fields and full-text signals. alice. may suggest continuing or grouping similar contexts, but a user confirms the destination or merge. Similarity never silently moves entries, broadens permissions, or makes content active. Embeddings remain out of Milestone 06.

### Consumption

After connection and target selection, supported hosts should retrieve the active project/context without requiring the user to repeat “use alice.” in every prompt. Tool contracts and host instructions may make normal retrieval discoverable, but host capabilities differ. The product must expose a capability matrix and retain an explicit fallback when a host cannot bind a conversation reliably to the active target.

Read/fetch operations remain side-effect free. They cannot alter active selection, freshness, evidence, candidates, accepted state, membership, or permissions.

alice. cannot force a host model to invoke an MCP tool. Active selection, tool descriptions, and server instructions can reduce friction, but they do not prove that a particular conversation consulted alice. The product therefore exposes both a deterministic package preview and a last-read receipt containing the host, surface, project, context, package version, and time. A skipped or failed invocation must be distinguishable from a successful read, and copy must not imply otherwise.

### Saving with one human confirmation

The desired routine flow is:

1. the AI produces useful work;
2. a save offer names the exact project and context;
3. the user sees the exact proposed entries and source material;
4. the user checks to save or crosses to cancel; and
5. confirmed entries appear under Saved context.

The check must be an alice.-verified authenticated human action. A model-generated `confirmed: true`, a phrase in a prompt, or the host calling an MCP tool is not sufficient. If a host supports a secure interactive component, it may render the alice.-controlled confirmation. Otherwise the host opens the smallest possible alice. confirmation page and returns the user to their work.

The confirmation transaction may create the immutable evidence, candidate, accepted-state version, and audit records together only when the human action is authenticated and bound to the exact preview. If capture occurred first through MCP, confirmation accepts that immutable candidate. In neither path may an ordinary AI tool directly create accepted state.

The product UI uses `Saved context`, `Needs attention`, `Removed`, and `History`. These labels reduce conceptual overhead; they do not remove the internal evidence/candidate/accepted-state boundary.

### Project files and host attachments

Users may attach bounded PDFs, PNG/JPEG/WebP images, plain-text files, and Markdown files to project-wide context or a permitted work context. The initial type and size allowlist must be explicit in schemas and UI rather than delegated to browser filenames or caller-supplied MIME types.

PostgreSQL stores file identifiers, original display names, verified media types, byte sizes, content hashes, uploader and source-host provenance, project/context references, permissions, lifecycle status, versions, extraction status, and audit references. File bytes live in private object storage. Downloads and previews use short-lived authorization after rechecking current project/context access; permanent public object URLs are prohibited.

The upload boundary must verify signatures and media types, sanitize display names and response headers, scan malicious content, bound decompression and page/image processing, avoid executable rendering, and prevent artifact URLs or document instructions from driving tools. Identical content may be deduplicated behind the authorization layer, but no hash lookup or deduplication result may disclose another tenant or restricted context.

A direct authenticated-human upload may immediately create an active artifact reference because the user chose its destination and audience. Statements inside the artifact do not become active project assertions. Deterministic bounded extraction produces provenance-bearing candidate suggestions, and every suggestion requires the same exact authenticated confirmation as other saved context. Extraction, preview, reads, OCR when later admitted, and context assembly cannot alter accepted state.

When a user attaches a file during a ChatGPT or Claude conversation, the desired offer is:

1. show the exact filename, verified type/size when available, active project, active context, and access scope;
2. offer `Save file only`, `Save file and suggest context`, and `Not now`;
3. require an alice.-controlled or provider-verified authenticated user confirmation before transferring or storing bytes; and
4. return a receipt linking to the saved artifact and destination.

A model statement that the user approved, a generated `confirmed` argument, or awareness of a host attachment is not transfer authority. alice. must not copy every host attachment automatically. If a provider cannot securely transfer attachment bytes and provenance through its supported integration, the offer opens a minimal alice. upload page with the permitted project/context preselected. It must not claim success until alice. has received, validated, scanned, stored, authorized, and audited the object.

AI-generated files follow the same flow and are labelled with their source host. The integration stores no host password, session cookie, unrelated conversation history, or reusable attachment URL. Provider capabilities and limits are dated and evaluated separately for ChatGPT and Claude.

Normal context packages include bounded, permission-filtered artifact references and omission reporting rather than automatically embedding every file. A separate explicit read retrieves a selected supported file or bounded excerpt when the host capability and context budget allow it. Remove-from-context stops normal retrieval without erasing history; permanent object erasure follows the published project/account retention and backup policy.

#### Implemented local file foundation — 2026-08-30

Migration `007_project_files.sql` adds immutable per-workspace file objects and context references. PostgreSQL retains SHA-256, verified media type, byte size, opaque storage key/version metadata, scan lifecycle, uploader/source provenance, and inherited context access; bytes are not stored in PostgreSQL. Normal application roles can advance only the storage/scan lifecycle and cannot rewrite content metadata, references, or terminal scan results.

The authenticated web fallback accepts exact raw bytes only from the configured same origin. It normalizes and sanitizes display names, checks filename/type consistency, verifies PDF/PNG/JPEG/WebP signatures or fatal UTF-8 text/Markdown, applies 25 MiB/10 MiB/2 MiB type-specific limits, and hashes the accepted bytes. Exact content may reuse one immutable object only within the same workspace; every authorized context retains a separate immutable reference and no hash/dedup result crosses an authorization boundary.

The optional production adapter uploads to a private versioned S3 bucket, observes the exact-version GuardDuty result tag, and treats missing, pending, threat, unsupported, access-denied, and failed results as non-downloadable. Only `NO_THREATS_FOUND` maps to `clean`. A current alice. authorization check is required before issuing a 60-second exact-version signed download; the browser receives no AWS credential and permanent object URLs are never persisted or rendered. A clean scan means only that the configured scanner reported no known threat. It never verifies claims or authorizes document instructions.

Migration `008_file_reference_exclusions.sql` adds exact-preview, append-only removal for a context reference. One authenticated human decision inserts an immutable exclusion and safe audit event; it never deletes or rewrites the file object/reference. Removed references disappear from active listings and immediately fail download and scan-reconciliation authorization, while a separate Removed section and metadata detail retain filename, type, size, source, destination, scan state, immutable receipts, removal time, and optional reason. A stale or concurrent second decision cannot create another exclusion. Re-uploading the exact removed bytes cannot silently reactivate the immutable reference; adding a changed replacement remains part of the unfinished version-control flow.

Migration `009_file_reference_versions.sql` groups immutable references into a logical file with monotonic versions. A replacement must contain changed bytes and target the latest terminal version. The previous clean version remains current while a replacement scans or when it fails; only a newer `clean` version supersedes it. Concurrent replacements against one version produce one next version. Old receipts remain visible but cease download authorization after a newer clean version exists.

Clean UTF-8 text and Markdown previews are fetched by exact object version, rechecked against immutable size and SHA-256, escaped, and labelled untrusted. Clean PNG/JPEG/WebP previews receive the same integrity check plus `nosniff`, no-store, and sandbox/default-deny response headers. PDF content is deliberately not rendered inline. The authorized context metadata export contains version, hash, provenance, scan, and removal history but no storage key, storage version, credential, or signed URL.

This is a local/provider-adapter foundation, not completion of the file milestone tasks. No AWS resource or IAM policy exists yet, live GuardDuty behavior and public-access denial have not been exercised, and audience controls, privileged erasure, host attachment transfer, extraction, and MCP file retrieval remain unimplemented. Removal applies to one logical context reference only and is explicitly not permanent object deletion. File routes stay disabled when the server-only storage configuration is absent.

### Removal, archive, export, and erasure

These are distinct controls:

- **Remove from active context:** append an exclusion or superseding version. Consumption stops returning the item, while provenance and audit history remain.
- **Archive project:** hide and disable ordinary use without erasing its records. It can be restored by an authorized user.
- **Export project:** provide the user's permitted project data, provenance, and history in a documented portable format without disclosing restricted contexts.
- **Permanently delete:** execute a policy-governed privacy erasure workflow, including the published backup-expiry behavior. This is a privileged lifecycle operation, not a normal role rewriting individual evidence or audit rows.

The retention policy must define account deletion, project deletion, collaborator removal, backups, security/audit records, legal holds if applicable, and the maximum erasure window before any friend is invited.

## Collaboration and permissions

### Project membership

Initial project roles are:

- **Owner:** project administration, membership, project-level settings, export, archive, deletion request, and ownership transfer.
- **Editor:** create and edit permitted contexts, propose and confirm saves where permitted, and remove entries from active permitted contexts.
- **Viewer:** read permitted active context and its permitted provenance without mutation.

Invitations are explicit, expiring, single-recipient grants with accept, decline, revoke, and resend lifecycle. The final owner cannot leave or be removed until ownership transfers or the project is safely archived/deleted under policy.

### Context permissions

A context can be visible to:

- all project members;
- selected project members; or
- only its creator as a personal draft.

Context capabilities are Viewer, Editor, and Manager, bounded by the user's project role. A context grant cannot elevate a project Viewer into a project Owner or reveal a project they cannot access. The UI must clearly disclose whether project owners can administer restricted contexts; the implementation and participant copy must agree.

Item-level access control is not part of the first collaboration version. If information needs a different audience, it belongs in a separate context. Moving or grouping content across contexts requires authorization for both source and destination and must never broaden access silently.

### Isolation requirements

Authorization derives from the authenticated user, accepted project membership, context grant, action capability, and active per-user integration connection. It never derives from a caller-supplied project, workspace, membership, context, or role identifier alone.

Denied paths disclose no restricted content or metadata, including project/context names, identifiers, membership, counts, freshness, omissions, conflict presence, artifact references, provenance, search hits, similarity suggestions, or active-selection state. Every new path requires both-direction cross-tenant and cross-permission negative tests.

Each collaborator authorizes their own ChatGPT and Claude connections. Tokens, host credentials, connection status, and revocation are per user and are never inherited through project membership.

## PostgreSQL system of record

PostgreSQL becomes the production system of record before hosted testing. The adapter boundary becomes asynchronous, and migrations are versioned, repeatable, and tested against real PostgreSQL rather than a SQLite emulation.

Migration requirements include:

- preserve exact validated evidence serialization and hashes by storing byte-exact payload text; use `jsonb` only where canonical byte identity is not required;
- use UTC `timestamptz` semantics and deterministic serialized outputs;
- replace SQLite `STRICT`, `NOCASE`, trigger, and `BEGIN IMMEDIATE` assumptions explicitly;
- use database constraints, row locks, unique keys, and transaction isolation to preserve capture idempotency and accepted-version allocation under concurrency;
- retain immutable evidence, accepted state, and audit enforcement at the database boundary available to normal application roles;
- add workspace/project/context/membership composite constraints and indexes for every authorized lookup;
- test clean migration, rollback/failure behavior, concurrent identical and conflicting capture, backup, restore, and schema compatibility; and
- document whether SQLite remains a local-only adapter, how its semantics differ, and how existing development data is discarded or migrated.

## Hosting and connection experience

The target experience has stable web and MCP HTTPS origins. Friends do not run terminals, create Cloudflare quick tunnels, paste changing MCP URLs, or configure raw authorization headers.

The alice. web application provides Connect ChatGPT and Connect Claude surfaces with current connection status, supported-account requirements, reconnect, and revoke controls. OAuth remains per user. The deployment shares one managed PostgreSQL database, injects secrets server-side, applies migrations deliberately, redacts evidence and bearer values from logs, and verifies both deployables through stable health and protocol checks.

Vercel may host the deployables only if the built Express applications, MCP request/transport behavior, stable OAuth origins, PostgreSQL connection strategy, migration process, and operational limits pass hosted tests. Platform choice is subordinate to these properties.

The read-only provider comparison and current recommendation are recorded in `docs/private-alpha-infrastructure-selection.md`. It recommends Railway for the two Node services, Neon for managed PostgreSQL, and private Amazon S3 with GuardDuty Malware Protection for file bytes. No resource, paid plan, public origin, invitation, or external data transfer exists merely because that recommendation is documented; provisioning remains an explicit product-owner approval gate.

## Host-surface compatibility

Remote MCP is the integration architecture, but capability claims are made per host surface rather than per provider brand. A successful result on one client does not establish support on another client, even when they use the same account or server URL.

Milestone 06 records live, dated results for this matrix:

| Provider | Surface | OAuth connect, reconnect, revoke | Project list and active selection | Accepted-context read | Candidate save, exact confirm, cancel | File reference and attachment fallback | Permission denial/non-disclosure | Milestone 06 status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Anthropic | Claude web | Required | Required | Required | Required | Required | Required | Planned |
| Anthropic | Claude Desktop | Required | Required | Required | Required | Required | Required | Planned |
| Anthropic | Claude iOS | Required | Required | Required | Required | Required | Required | Planned |
| Anthropic | Claude Android | Required | Required | Required | Required | Required | Required | Planned |
| Anthropic | Claude Code | Required | Required | Required | Required | Required | Required | Planned |
| OpenAI | ChatGPT web | Required | Required | Required | Required | Required | Required | Planned |
| OpenAI | ChatGPT desktop | Required | Required | Required | Required | Required | Required | Planned |
| OpenAI | Codex desktop | Required | Required | Required | Required | Required | Required | Planned |
| OpenAI | Codex CLI | Required | Required | Required | Required | Required | Required | Planned |
| OpenAI | Codex IDE extension | Required | Required | Required | Required | Required | Required | Planned |

Each result records the date, provider/client version, account type, region, transport, authorization scopes, tool exposure, observed confirmation behavior, and durable evidence location. `Pass`, `Fail`, `Provider-blocked`, and `Not tested` are distinct states. Only passing capabilities may appear in onboarding or marketing copy. Provider-blocked or failed native save and file-transfer paths use an alice.-controlled confirmation or pre-targeted upload fallback; they are not reported as native support.

ChatGPT mobile is outside the initial advertised matrix because current support has not been established for alice.'s custom remote integration path. It may be added only through a dated documentation review and separate live run; generic “ChatGPT support” must not imply mobile support.

Official capability references must be revalidated at implementation time because provider behavior changes:

- OpenAI, [Model Context Protocol for ChatGPT and Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- OpenAI, [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- Anthropic, [When to use desktop and web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
- Anthropic, [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## Product-risk gates from external critique

The 2026-08-30 product critique supplied by the product owner is advisory evidence, not an authority over repository invariants or approved scope. Milestone 06 adopts these durable risk controls from it:

- Position alice. first as a user-governed, versioned, provenance-bearing project record. Cross-tool memory is a benefit, not the trust claim.
- Treat confirmation effort as a measurable product cost. Instrument the number of proposed entries, confirmations, edits, cancellations, deferred reviews, and time-to-clear without recording their content.
- Do not depend exclusively on a host voluntarily offering `Save this to alice.?`. Keep an alice.-controlled Needs attention queue and smallest confirmation link as a dependable fallback.
- Give the user a visible receipt when alice. was read and a visible failure state when it was not. Do not attribute an answer to alice. without a recorded read.
- Make the deterministic context-package preview, including byte budget, freshness, omissions, and per-item provenance, a primary project-screen proof rather than a hidden diagnostic.
- Include repair for wrong, stale, contradicted, and superseded context. Saving is not complete lifecycle management.
- Verify whether each host surface can transfer attachment bytes through a supported interface. If it cannot, say so and open a pre-targeted alice. upload; awareness of an attachment is not possession of its bytes.
- Measure first-project value and cross-host reuse. The primary continuity signal is the same project being read from at least two supported host surfaces within seven days, supplemented by repeat use and review-burden evidence.

The critique recommends deferring collaboration and work contexts. The product owner has explicitly retained both for the pre-friend-testing foundation, so the recommendation is recorded as a scope-risk warning rather than silently changing the roadmap. Implementation should still sequence and verify the single-user project/read/save/repair loop before layering collaboration and final presentation work.

## Visual system and copy approval

Keel (`https://keel.framer.ai/`) is the single visual-system reference for the Milestone 06 public site and authenticated product. The choice is based on its calm product-first hierarchy, restrained dark surfaces, real-interface emphasis, legible state presentation, and suitability for connections, projects, context freshness, history, and needs-attention views.

alice. will not copy Keel source, assets, screenshots, identity, claims, or deployment terminology. The implementation derives an original alice. design system with its own wordmark, tokens, components, product screenshots, responsive behavior, and accessibility. The same system covers marketing, authentication, onboarding, project/context selection, saved context, files, collaborators, permissions, connections, history, privacy, and deletion controls.

Functional, database, authorization, file, provider-capability, and deployment foundations precede final presentation work. The product owner reviews and explicitly approves public and in-product copy before the friend-facing UI is complete. Copy must describe shipped behavior and must not position alice. as a chatbot, AI model, router, or agent orchestrator.

The copy review must cover at least:

- the one-sentence product promise and target user;
- project/context selection and cross-host continuation;
- exact-preview save/cancel, saved context, and needs-attention language;
- direct uploads and host-attachment save offers;
- invitations, roles, context visibility, and personal drafts;
- what alice. stores and what is sent to ChatGPT or Claude;
- removal, archive, export, permanent deletion, retention, and backups;
- connection recovery and revocation; and
- invite-only alpha limitations and prohibited sensitive data.

No fabricated testimonials, customer logos, accuracy/ROI claims, compliance badges, provider-training promises, residency promises, or deletion promises may appear. The final UI requires keyboard and screen-reader semantics, visible focus, sufficient contrast, reduced-motion behavior, responsive desktop/mobile layouts, and comprehensible loading, empty, error, denied, revoked, upload, scanning, extraction, and deletion states.

## Privacy and friend-testing boundary

Until Milestone 06 is complete, testers must be told that this is a local/private prototype and must not enter sensitive, regulated, or client-confidential information.

Before invitations open, alice. must publish an understandable private-alpha notice describing:

- data collected and why;
- project and context collaborator visibility;
- what selected context is sent to ChatGPT or Claude and that those providers apply their own account terms and settings;
- storage region and subprocessors once selected;
- encryption and operational-access controls once verified;
- retention, backups, archive, removal, export, and permanent deletion behavior;
- connection revocation and security-event visibility;
- incident and privacy contact; and
- prohibited alpha data categories.

Do not promise that providers do not train on submitted context, that data remains in a particular country, that deletion is instantaneous, or that infrastructure staff can never access data unless the selected services, account configurations, contracts, and implemented controls make those statements true.

Privacy-preserving instrumentation records events and bounded identifiers needed to measure setup, selection, retrieval, save offers, confirmation/cancellation, removal, restatement, and repeat use. It must not record passwords, bearer tokens, exact evidence payloads, complete prompts, model responses, or restricted-context metadata.

## Verification boundary

Milestone 06 is not complete on local happy paths alone. Verification must cover:

- a clean PostgreSQL migration and restored backup;
- hosted web and MCP OAuth/read/write/revocation flows from both target hosts;
- dated surface-by-surface OAuth, project selection, accepted-context read, save/confirm/cancel, file reference/transfer fallback, and permission-denial runs for Claude web, Desktop, iOS, Android, and Claude Code; ChatGPT web and desktop; and Codex desktop, CLI, and IDE;
- a visible deterministic package preview plus last-read receipts and skipped/failed-invocation states that do not mutate project state;
- project and context selection across multiple projects and concurrent sessions;
- exact-preview save confirmation and cancel behavior;
- direct file upload, validation, scanning, preview, versioning, authorized download, removal, export, erasure, and backup-expiry behavior;
- ChatGPT and Claude attachment-save offers, confirmed transfer where supported, file-only and extraction choices, cancellation, duplicates, failures, generated files, and the pre-targeted alice. upload fallback;
- malicious file content and prompt-injection attempts that cannot call tools, broaden access, activate context, or mutate evidence/accepted state;
- removal from active consumption without provenance loss;
- invitations, role changes, context restrictions, ownership edge cases, and per-user connections;
- non-disclosure under cross-tenant, non-member, insufficient-role, guessed-ID, revoked-token, and restricted-context requests;
- deterministic, budgeted, provenance-bearing context after collaboration filtering;
- Keel-directed visual consistency, desktop/mobile accessibility, copy approval, and first-time-user comprehension; and
- agreement between participant-facing privacy statements and actual system behavior.

Private-alpha recruitment begins only after these checks and the full repository verification contract pass.
