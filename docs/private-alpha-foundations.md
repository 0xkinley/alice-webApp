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

After connection and target selection, supported hosts should retrieve the active project/context without requiring the user to repeat “use alice.” in every prompt. Tool contracts and host instructions may make normal retrieval discoverable, but host capabilities differ. The product must retain an honest per-surface support record and an explicit fallback when a host cannot bind a conversation reliably to the active target. Completing an exhaustive provider-surface matrix is not a Milestone 06 gate.

Read/fetch operations remain side-effect free. They cannot alter active selection, freshness, evidence, candidates, accepted state, membership, or permissions.

alice. cannot force a host model to invoke an MCP tool. Active selection, tool descriptions, and server instructions can reduce friction, but they do not prove that a particular conversation consulted alice. The product therefore exposes both a deterministic package preview and a last-read receipt containing the host, surface, project, context, package version, and time. A skipped or failed invocation must be distinguishable from a successful read, and copy must not imply otherwise.

The implemented preview is an authenticated project/context route that renders the exact deterministic JSON package for an explicit task and 2,000–32,000 UTF-8 byte budget, including freshness, omissions, and per-item provenance when entries are present. Opening it is explicitly not a host read and creates no receipt. MCP `get_active_context` and `get_project_context` append immutable success or bounded-failure receipts to the connection owner's private workspace. A success proves retrieval only, not that the host used the package in an answer. Receipts contain no task text or package content, and destination metadata is displayed only while the user retains access to that context.

### Saving with one human confirmation

The desired routine flow is:

1. the AI produces useful work;
2. a save offer names the exact project and context;
3. the user sees the exact proposed entries and source material;
4. the user chooses the single authenticated `Save` action, or leaves the preview with no write; and
5. confirmed entries appear under Saved context.

The check must be an alice.-verified authenticated human action. A model-generated `confirmed: true`, a phrase in a prompt, or the host calling an MCP tool is not sufficient. If a host supports a secure interactive component, it may render the alice.-controlled confirmation. Otherwise the host opens the smallest possible alice. confirmation page and returns the user to their work.

The Save transaction creates the immutable evidence, internal candidate provenance, accepted-state version, and audit records together only when the human action is authenticated and bound to the exact unexpired preview. The routine MCP call before that click stores only short-lived preview state and creates no evidence, candidate, Needs attention entry, accepted state, or audit event. Historical and file-extraction candidate reviews remain available, but routine ChatGPT/Claude saving no longer enters that queue. In neither path may an ordinary AI tool directly create accepted state.

The product UI uses `Saved context`, `Needs attention`, `Removed`, and `History`. These labels reduce conceptual overhead; they do not remove the internal evidence/candidate/accepted-state boundary.

### Project files and host attachments

Users may attach bounded PDFs, DOCX/XLSX/PPTX files, PNG/JPEG/WebP images, and UTF-8 plain-text, Markdown, CSV, TSV, or JSON files to project-wide context or a permitted work context. The type and size allowlist must be explicit in schemas and UI rather than delegated to browser filenames or caller-supplied MIME types. Modern Office files are reference/download only in the private alpha; legacy binary Office files, arbitrary ZIP files, and native Google Docs links remain unsupported.

PostgreSQL stores file identifiers, original display names, verified media types, byte sizes, content hashes, uploader and source-host provenance, project/context references, permissions, lifecycle status, versions, extraction status, and audit references. File bytes live in private object storage. Downloads and previews use short-lived authorization after rechecking current project/context access; permanent public object URLs are prohibited.

The upload boundary must verify signatures and media types, sanitize display names and response headers, scan malicious content, bound decompression and page/image processing, avoid executable rendering, and prevent artifact URLs or document instructions from driving tools. Identical content may be deduplicated behind the authorization layer, but no hash lookup or deduplication result may disclose another tenant or restricted context.

A direct authenticated-human upload may immediately create an active artifact reference because the user chose its destination and audience. Statements inside the artifact do not become active project assertions. Deterministic bounded extraction produces provenance-bearing candidate suggestions, and every suggestion requires the same exact authenticated confirmation as other saved context. Extraction, preview, reads, OCR when later admitted, and context assembly cannot alter accepted state.

When a user attaches a file during a ChatGPT or Claude conversation, the desired offer is:

1. show the exact filename, verified type/size when available, active project, active context, and access scope;
2. offer one `Save` action for the exact active context, with closing, ignoring, and expiry treated as no action;
3. require an alice.-controlled or provider-verified authenticated user confirmation before transferring or storing bytes; and
4. return a receipt linking to the saved artifact and destination.

A model statement that the user approved, a generated `confirmed` argument, or awareness of a host attachment is not transfer authority. alice. must not copy every host attachment automatically. If a provider cannot securely transfer attachment bytes and provenance through its supported integration, the offer opens a minimal alice. upload page with the permitted project/context preselected. It must not claim success until alice. has received, validated, scanned, stored, authorized, and audited the object.

AI-generated files follow the same flow and are labelled with their source host. The integration stores no host password, session cookie, unrelated conversation history, or reusable attachment URL. Provider capabilities and limits are dated and evaluated separately for ChatGPT and Claude.

Normal context packages include bounded, permission-filtered artifact references and omission reporting rather than automatically embedding every file. A separate explicit read retrieves a selected supported file or bounded excerpt when the host capability and context budget allow it. Remove-from-context stops normal retrieval without erasing history; permanent object erasure follows the published project/account retention and backup policy.

#### Implemented local file foundation — 2026-08-30

Migration `007_project_files.sql` adds immutable per-workspace file objects and context references. PostgreSQL retains SHA-256, verified media type, byte size, opaque storage key/version metadata, scan lifecycle, uploader/source provenance, and inherited context access; bytes are not stored in PostgreSQL. Normal application roles can advance only the storage/scan lifecycle and cannot rewrite content metadata, references, or terminal scan results.

The authenticated web fallback accepts exact raw bytes only from the configured same origin. It normalizes and sanitizes display names, checks filename/type consistency, verifies PDF/PNG/JPEG/WebP signatures, bounded modern Office ZIP structure and primary package parts, or fatal UTF-8 structured text, applies 25 MiB/10 MiB/2 MiB type-specific limits, and hashes the accepted bytes. Office validation rejects malformed, encrypted, multi-disk, Zip64, macro-enabled, ambiguous, mismatched, or renamed generic ZIP packages. Exact content may reuse one immutable object only within the same workspace; every authorized context retains a separate immutable reference and no hash/dedup result crosses an authorization boundary.

An authenticated user who can read a current clean reference may explicitly add that exact immutable object to another context where they currently have write access. The preview names only eligible destinations, excludes every context that already references the object (including an excluded reference), and binds the source object/reference state plus destination identity, visibility, and freshness into a one-use decision version. Submission reauthorizes both sides under an advisory lock, creates a new context-local logical reference without storing bytes or another file object, preserves original uploader/source provenance, and appends content-free audit identifiers. Stale, replayed, guessed, foreign, non-clean, removed, superseded, or permission-lost requests fail closed without disclosing the source or destination.

The optional production adapter uploads to a private versioned S3 bucket, observes the exact-version GuardDuty result tag, and treats missing, pending, threat, unsupported, access-denied, and failed results as non-downloadable. Only `NO_THREATS_FOUND` maps to `clean`. A current alice. authorization check is required before issuing a 60-second exact-version signed download; the browser receives no AWS credential and permanent object URLs are never persisted or rendered. A clean scan means only that the configured scanner reported no known threat. It never verifies claims or authorizes document instructions.

Migration `008_file_reference_exclusions.sql` adds exact-preview, append-only removal for a context reference. One authenticated human decision inserts an immutable exclusion and safe audit event; it never deletes or rewrites the file object/reference. Removed references disappear from active listings and immediately fail download and scan-reconciliation authorization, while a separate Removed section and metadata detail retain filename, type, size, source, destination, scan state, immutable receipts, removal time, and optional reason. A stale or concurrent second decision cannot create another exclusion. Re-uploading the exact removed bytes cannot silently reactivate the immutable reference; adding a changed replacement remains part of the unfinished version-control flow.

Migration `009_file_reference_versions.sql` groups immutable references into a logical file with monotonic versions. A replacement must contain changed bytes and target the latest terminal version. The previous clean version remains current while a replacement scans or when it fails; only a newer `clean` version supersedes it. Concurrent replacements against one version produce one next version. Old receipts remain visible but cease download authorization after a newer clean version exists.

Clean UTF-8 text, Markdown, CSV, TSV, and JSON previews are fetched by exact object version, rechecked against immutable size and SHA-256, escaped, and labelled untrusted. Clean PNG/JPEG/WebP previews receive the same integrity check plus `nosniff`, no-store, and sandbox/default-deny response headers. PDF and modern Office content is deliberately not rendered inline. The authorized context metadata export contains version, hash, provenance, scan, and removal history but no storage key, storage version, credential, or signed URL.

This remains a local/provider-adapter foundation rather than completion of the broader file milestone tasks. Consumption contract `2.2` exposes only current clean, permission-filtered file references in bounded context packages. With the same private-storage capability configured, `read_project_file_text` retrieves exact clean UTF-8 text, Markdown, CSV, TSV, or JSON and `read_project_file_pdf_text` deterministically extracts bounded PDF embedded text. Both are independently budgeted, paginated, integrity-checked, explicitly untrusted, and read-only. DOCX, XLSX, and PPTX remain reference/download only. Foreign, guessed, superseded, removed, non-clean, and inaccessible references fail without disclosure. The shared S3 adapter keeps exact object key/version metadata server-side.

Migration `014_pdf_evidence_sources.sql` and capability-gated `suggest_project_updates_from_file` add the bounded file-intelligence checkpoint. The server re-extracts an exact current clean PDF and validates the host's range/hash receipt before atomically storing an immutable evidence/file-source link and pending candidate claims. A selected-context PDF cannot feed another active work context; project-wide PDFs may feed the selected target. The exact alice.-controlled review page shows filename, file version, content hash, extraction contract/range, excerpt hash, and untrusted source before human confirmation. No extraction or host call changes trusted state.

Migration `015_file_upload_intents.sql` adds the Lambda-compatible direct-upload boundary. An authenticated browser computes the exact SHA-256 and requests an immutable intent bound to its user, project, context, sanitized name, declared type/size/hash, optional replacement, random staging key, and expiry. A ten-minute presigned S3 PUT carries checksum, metadata, and SSE-S3 requirements but no AWS credential. A staging object alone creates no alice. file object or reference. Finalization accepts only the initiating user with current write access, an exact S3 version, and a clean GuardDuty verdict; only then may the server read and independently validate the bytes before passing them through the existing immutable reference/version flow. Pending and non-clean scans are not read, foreign intents disclose nothing, mismatches fail closed, and immutable completion receipts make ordinary retries idempotent. The legacy server-mediated route remains a local adapter fallback, while the S3-backed web UI uses the direct flow so Lambda's 6 MB request limit does not reduce alice.'s admitted file limits.

Migration `017_host_file_save_offers.sql` adds the metadata-only host-attachment authority boundary. A ChatGPT- or Claude-classified connection with `mcp:write` and a writable active target may create one idempotent 30-minute offer containing a sanitized filename, optional host-declared type/size/hash, source-host classification, and at most one opaque bounded conversation identifier. The exact active work context is the immutable destination. The strict MCP schema has no field for bytes, an attachment URL, host credential, cookie, prompt/message text, destination override, or confirmation flag. Unsupported client classifications are not assumed compatible.

Migration `021_single_action_save_previews.sql` makes an undecided attachment offer short-lived preview state. The offer and its active-target selection version remain immutable while present. The MCP App and authenticated web fallback require the same signed-in user, current destination write access, unchanged active project/context, and exact preview version before the only available decision, `Save`. The app additionally requires a random authority whose digest alone is stored and whose raw value is confined to tool-result `_meta`. Advisory locks make idempotent creation and one-time Save races deterministic. A host tool call, model statement, or caller-supplied field cannot create the decision. Save records bounded transfer authority only and says that no file is saved yet. Closing, ignoring, or expiry creates no decision, audit, bytes, file object/reference, candidate, Needs attention item, or accepted state; expired undecided preview rows and authorities are purged. A later capability-gated transfer or pre-targeted browser upload must consume the confirmed authority and still pass byte validation, malware scanning, storage, authorization, and audit before alice. can issue a saved-file receipt.

Migration `018_host_file_transfers.sql` implements that later boundary without weakening the confirmation. A natively capable host must declare the exact signed-PUT capability, original filename, normalized media type, byte size, SHA-256, and idempotency key to `begin_host_file_transfer`; attachment bytes, host URLs, cookies, credentials, prompts, and unrelated conversation history are not tool inputs. The server derives the user, connection, project, context, decision, source host, and optional opaque conversation reference from the immutable offer. If the surface cannot securely expose the original bytes and issue the exact HTTPS PUT, the same authenticated offer page shows one file input with the project/context locked and sends the same declaration to a same-origin alice. endpoint. The selected browser filename must equal the confirmed filename.

Both paths create the existing short-lived exact-object staging intent and preserve a relational link to the offer and decision. A generic direct-upload finalizer cannot consume a host-linked intent. Finalization accepts only the initiating user or connection, exact path, exact intent, and immutable S3 version. It reads no bytes while the staging GuardDuty result is pending or non-clean, then independently validates signature, type, size, and SHA-256 before creating the normal immutable object/reference with the offer's source host and authenticated uploader. The final object remains unavailable until its own exact version is scan-clean. One offer-level advisory lock, completion row, and availability row make simultaneous attempts converge on one reference and one saved receipt. The bounded conversation identifier remains on the offer rather than the file reference; its presence is reported in safe audit evidence without copying conversation content.

New ChatGPT and Claude attachment saves always use the exact active work context and return `suggestions_requested: false`. A later explicit PDF extraction/suggestion request must still use the existing exact extraction receipt and human review. No-action expiry, active-target change before an attempt, lost destination write access, guessed/foreign IDs, metadata mismatch, threat or failed scans, and replay through the wrong finalizer produce no available reference. Historical receipts may retain the earlier `save_and_suggest_context` or `cancelled` decision values, but the current UI and decision handler do not offer or accept either one. The provider compatibility matrix remains the authority for native host capability: local contract coverage is not a claim that any ChatGPT or Claude surface can currently perform the transfer.

Migration `019_popular_file_formats.sql` expands the local upload and host-transfer allowlist to DOCX, XLSX, PPTX, CSV, TSV, and JSON. Office Open XML packages receive bounded ZIP-directory and primary-part validation and reject macros, renamed generic archives, and malformed or ambiguous containers. CSV, TSV, and JSON join the exact UTF-8 text read path; Office files remain scan-gated reference/download only with metadata-only preview. Legacy `.doc`, `.xls`, `.ppt`, arbitrary ZIP, and native Google Docs links remain unsupported. This source and migration are not deployed until a later separately reviewed release.

Migration `020_context_provider_authorizations.sql` separates human context access from provider availability. Each user has an independent ChatGPT and Claude decision for each readable context; missing or disabled authorization denies the provider even when project membership, context access, and an active routing row exist. Provider authorization is enforced again on model-visible discovery, active and explicit reads, captures, file disclosure and exact reads, file-backed proposals, attachment paths, and cross-context file linking. A collaborator does not inherit another member's provider choices. Application-role grants permit only bounded enablement/version updates and preserve authorization identity and history.

The local MCP `0.8.0` workspace and Save apps use the stable 2026-01-26 MCP Apps contract, standard `ui.resourceUri`, `text/html;profile=mcp-app`, app-only human mutation tools, and the ChatGPT compatibility alias. The self-contained UI bundles serve both ChatGPT and Claude. Because the current host context contains presentation and tool metadata but no stable server-verifiable conversation identity, routing remains explicitly connection-wide and the workspace warns about its cross-conversation effect. This is an honest fallback, not a native sidebar or exact-conversation claim. Project and context creation record exact human-access and provider choices; existing scan-clean objects can be referenced without copying bytes, and new uploads continue through the authenticated pre-targeted alice. file route and both scan gates. The single-action Save app shows the exact context payload or host attachment and has no Cancel control; the initial tool call cannot place routine content in Needs attention or trusted state.

The 2026-09-01 hosted proof exercised direct browser-to-S3 upload, exact-origin CORS, exact immutable versions, clean/threat GuardDuty gating, and short-lived authorized download. A 168-byte clean fixture was returned with its original SHA-256; a 69-byte EICAR fixture created no active reference or download and its exact S3 version denied direct access. A separate local privileged-erasure foundation now covers exact S3-version inventory/deletion, PostgreSQL dependency deletion, shared-object retention, ordinary-role denial, and prepared/completed retry receipts, but its hosted run and Aurora backup-expiry observation remain unverified. The exact host attachment save offer, capability-gated transfer contract, and pre-targeted upload fallback are implemented and verified locally but are not deployed or live-tested on a provider surface. OCR, image understanding, and non-PDF binary extraction also remain unimplemented. The pinned in-process PDF parser has page/item/character bounds but is not a separate memory sandbox. File audience inherits the active project/context authorization policy, including restricted and personal contexts. Removal applies to one logical context reference only and is explicitly not permanent object deletion. Web file routes and all MCP file tools stay disabled when server-only storage configuration is absent. The detailed boundary is in `docs/file-retrieval.md`.

### Removal, archive, export, and erasure

These are distinct controls:

- **Remove from active context:** append an exclusion or superseding version. Consumption stops returning the item, while provenance and audit history remain.
- **Archive project:** hide and disable ordinary use without erasing its records. It can be restored by an authorized user.
- **Export project:** provide the user's permitted project data, provenance, and history in a documented portable format without disclosing restricted contexts.
- **Permanently delete:** execute a policy-governed privacy erasure workflow, including the published backup-expiry behavior. This is a privileged lifecycle operation, not a normal role rewriting individual evidence or audit rows.

Implementation boundary on 2026-09-01: migration `013` and the authenticated Owner lifecycle page implement exact reversible archive/restore, permission-filtered JSON export, and a cancellable deletion request with a seven-day cooling-off period. Archive revokes pending invitations and clears active AI-connection targets but preserves all records. The export queries only contexts currently visible to the Owner and excludes raw multi-destination evidence envelopes, storage locations, credentials, tokens, signed URLs, and file bytes. Migration `016` plus the separate two-phase operator implement the local privileged PostgreSQL/S3 erasure and reconciliation boundary. The working alpha policy allows seven days for cancellation, seven additional days for active-data erasure, and seven-day Aurora automated-backup retention, but hosted execution and observed provider expiry remain required before any friend-facing deletion promise; see `docs/project-lifecycle.md`.

The project retention policy now defines project deletion, collaborator removal, automated and manual backups, security/audit records, exceptional legal/incident holds, and the maximum project-data window. Account-wide erasure remains explicitly separate and unimplemented. These boundaries must be repeated in the friend-facing disclosure, and provider expiry must be verified before recruitment.

## Collaboration and permissions

### Project membership

Initial project roles are:

- **Owner:** project administration, membership, project-level settings, export, archive, deletion request, and ownership transfer.
- **Editor:** create and edit permitted contexts, propose and confirm saves where permitted, and remove entries from active permitted contexts.
- **Viewer:** read permitted active context and its permitted provenance without mutation.

Invitations are explicit, expiring, single-recipient grants with accept, decline, revoke, and resend lifecycle. The final owner cannot leave or be removed until ownership transfers or the project is safely archived/deleted under policy.

Migration `010_project_memberships.sql` implements the invitation and membership-history boundary. Every existing and new project has a protected Owner membership. Owners can issue hash-only Editor/Viewer invitation links, replace or revoke pending links, change a non-owner role, and remove a non-owner while retaining the membership row and append-only safe audit history. Only the exact signed-in recipient email can preview, accept, or decline; foreign and guessed tokens disclose no project or recipient metadata, and concurrent PostgreSQL acceptance creates one membership.

Migration `011_context_access.sql` completes the current project/context authorization conversion. Every project read and write now resolves an active membership; every context, selection, capture, review, saved-context, file, and consumption path additionally resolves the required context capability. The project's originating workspace remains its immutable data anchor but is no longer authority for its original user to bypass a membership or context grant. A collaborator's AI connection remains anchored to that collaborator's private workspace while active targets and evidence record the separate destination project workspace.

Ownership transfer is atomic: the successor becomes Owner before the actor becomes Editor. An Owner must transfer before leaving. Member removal or departure ends active grants in the same transaction and is blocked when an active personal context lacks disposition or a selected context created by that member lacks another explicit Manager. The database continues to reject deletion and ended-history rewrites.

### Context permissions

A context can be visible to:

- all project members;
- selected project members; or
- only its creator as a personal draft.

Context capabilities are Viewer, Editor, and Manager, bounded by the user's project role. A context grant cannot elevate a project Viewer into a project Owner or reveal a project they cannot access. The UI must clearly disclose whether project owners can administer restricted contexts; the implementation and participant copy must agree.

The implemented rule is deliberately privacy-preserving: project-wide and `all_members` contexts derive Manager/Editor/Viewer behavior from the project role; `selected_members` contexts require an explicit grant except that their active creator is an implicit Manager; and `personal` contexts are visible only to their active creator. A project Owner does not automatically see or administer a selected-members or personal context. An Owner or Editor may receive Viewer, Editor, or Manager context access, while a project Viewer is bounded to context Viewer and never writes. Context grant creation, role change, and ending append content-free context history and audit records; identities and ended rows remain immutable.

Item-level access control is not part of the first collaboration version. If information needs a different audience, it belongs in a separate context. Moving or grouping content across contexts requires authorization for both source and destination and must never broaden access silently.

### Isolation requirements

Authorization derives from the authenticated user, accepted project membership, context grant, action capability, and active per-user integration connection. It never derives from a caller-supplied project, workspace, membership, context, or role identifier alone.

Denied paths disclose no restricted content or metadata, including project/context names, identifiers, membership, counts, freshness, omissions, conflict presence, artifact references, provenance, search hits, similarity suggestions, or active-selection state. Every new path requires both-direction cross-tenant and cross-permission negative tests.

The 2026-09-01 current-surface authorization audit preserves that rule in both query order and test coverage. Invitation, membership, context-grant, lifecycle-request, direct-upload, and file-reference operations carry the authorized workspace/project/context scope through their seed lookups and terminal updates; they do not rely on an opaque identifier being globally unique after authorization has already been established. The existing composite foreign keys, immutable-history triggers, constrained-role column grants, exact-preview locks, and content-free mutation audits remain the database boundary.

The aggregate regression matrix covers every implemented project, context, membership, invitation, access, active-selection, capture, review, export, archive, removal, deletion, connection, MCP, and file path. Its central HTTP regression sends the same operation to a real foreign identifier and a random guessed identifier in both tenant directions: 35 read/mutation surfaces per direction, 140 denied requests total. Responses are equal after normalizing only the opaque identifiers supplied by the caller, disclose none of the target tenant's names, values, restricted descriptions, counts, conflicts, artifacts, or provenance, and leave the row counts of 13 protected state/audit tables unchanged. Focused suites separately cover restricted/personal context roles, connection ownership and revocation, MCP scope and mismatched principals, direct upload and exact file access, database composite-key failures, immutable history, concurrency, lifecycle, and privileged erasure denial. Any new route or host-transfer path must extend this matrix before it can be considered supported.

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

The alice. web application provides Add alice. to ChatGPT and Add alice. to Claude surfaces with current connection status, supported-account requirements, reconnect, and revoke controls. For the private alpha, each add action copies only the exact public MCP address already displayed on the page and opens the provider's current installation surface in a separate tab. ChatGPT opens the Plugins directory under Customize for manual custom-app entry because OpenAI does not document a URL-prefill contract; Settings > Plugins only manages plugins that are already installed. Claude uses Anthropic's documented custom-connector install link to prefill only the display name and percent-encoded MCP URL. The user still reviews and approves every connection; alice. never submits a provider form, bypasses provider approval, or transfers credentials. The displayed address remains available as a manual fallback. Directory-based installation remains the future no-copy path for ChatGPT after provider review. Provider destinations are dated conveniences, not compatibility evidence, and must be rechecked when provider UI changes.

The deployment shares one managed PostgreSQL database, injects secrets server-side, applies migrations deliberately, redacts evidence and bearer values from logs, and verifies both deployables through stable health and protocol checks.

Vercel may host the deployables only if the built Express applications, MCP request/transport behavior, stable OAuth origins, PostgreSQL connection strategy, migration process, and operational limits pass hosted tests. Platform choice is subordinate to these properties.

The initial Railway/Neon provider recommendation was superseded before provisioning after the product owner chose to investigate the account's AWS credit. The dated AWS-native checkpoint is recorded in `docs/private-alpha-aws-compatibility.md`: Lambda Function URLs plus auto-pausing Aurora Serverless v2 are selected for a bounded proof, while ECS Express Mode is the compatible but higher-baseline-cost fallback and App Runner is rejected because AWS has closed it to new customers. The production Docker build and dormant public probe remain reusable. The final unapplied CloudFormation template now uses separate Lambda roles, no IAM users/access keys, private Aurora, a retained S3/GuardDuty boundary, and a temporary private migration task. Exact resources, costs, security settings, staged activation, and stop rules are in `docs/private-alpha-aws-deployment-runbook.md`. No workload resource, paid upgrade, public origin, invitation, access key, or external data transfer exists merely because these artifacts are present; provisioning remains an explicit product-owner approval gate.

Current hosted state on 2026-09-02: the remediated private migration task verified all 18 migrations, its nine temporary resources were removed, and the Frankfurt runtime was restored before source commit `43febda` replaced both Lambda images in place. Both functions resolve immutable ECR digest `sha256:f03b9d1276b25415d59e528b15cf23c851265978c570181c9c6dbd35a00b7b60`, whose automatic scan returned no findings. The stack is `UPDATE_COMPLETE` with 32 resources, eight outputs, services and exact origins enabled, every temporary-operation flag disabled, and zero interface endpoints. Web and MCP health routes return HTTP 200 with PostgreSQL reachable. The exact tasks, digests, change sets, origins, cost state, and stop evidence are recorded in `docs/private-alpha-aws-deployment-runbook.md`.

## Host-surface compatibility

Remote MCP is the integration architecture, but capability claims are made per host surface rather than per provider brand. A successful result on one client does not establish support on another client, even when they use the same account or server URL.

The versioned machine-readable evidence registry is `evals/host-surface-compatibility.json`; its maintenance and bounded evaluation procedure are documented in `docs/host-surface-compatibility.md`. The registry remains available, but completing every row is not a Milestone 06 gate. Milestone 07 records a dated result only for an exact ChatGPT or Claude surface before that surface is used with a participant or advertised:

| Provider | Surface | OAuth connect, reconnect, revoke | Project list and active selection | Accepted-context read | Candidate save and exact confirmation | File reference and attachment fallback | Permission denial/non-disclosure | Current evidence state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Anthropic | Claude web | Not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Unsupported |
| Anthropic | Claude Desktop | Not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Unsupported |
| Anthropic | Claude iOS | Not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Unsupported |
| Anthropic | Claude Android | Not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Unsupported |
| Anthropic | Claude Code | Not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Unsupported |
| OpenAI | ChatGPT web | Not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Unsupported |
| OpenAI | ChatGPT desktop | Not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Unsupported |

Each result records the date, provider/client version, account type, region, transport, authorization scopes, tool exposure, observed confirmation behavior, and durable evidence location. `Pass`, `Fail`, `Provider-blocked`, and `Not tested` are distinct states. Only passing capabilities may appear in onboarding or marketing copy. Provider-blocked or failed native save and file-transfer paths use an alice.-controlled confirmation or pre-targeted upload fallback; they are not reported as native support. This just-in-time validation rule does not require unrelated clients to be tested before the alpha can proceed.

The private alpha is intentionally limited to the ChatGPT and Claude products. Codex is outside participant onboarding, support claims, interactive save-card work, invocation denominators, and completion gates. A Codex connection may remain available for internal development or testing, but its behavior is not private-alpha evidence and cannot be inherited by a ChatGPT surface.

The local deterministic private-alpha harness covers all required product capabilities and cross-host invariants, validates runtime-test evidence paths, and prevents incomplete matrix records from being advertised. It is deliberately not live-host evidence. The generic hosted OAuth/MCP verifier is also server-side deployment evidence rather than a result for any exact provider surface.

ChatGPT mobile remains unadvertised because current support has not been established for alice.'s custom remote integration path. It may be added only through a dated documentation review and separate live run; generic “ChatGPT support” must not imply mobile support.

Official capability references must be revalidated at implementation time because provider behavior changes:

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

The implemented first repair path is deliberately append-only. An authorized Editor/Owner or context Editor/Manager can classify the exact current value as stale, contradicted, or wrong and confirm its removal from active context. The accepted version, evidence, provenance, and audit history are retained; replacement still requires a separate candidate and exact human confirmation. History labels older accepted values as superseded and names the replacing version rather than presenting every accepted row as current.

## Visual system and copy approval

Keel (`https://keel.framer.ai/`) is the single visual-system reference for the Milestone 06 public site and authenticated product. The choice is based on its calm product-first hierarchy, restrained dark surfaces, real-interface emphasis, legible state presentation, and suitability for connections, projects, context freshness, history, and needs-attention views.

alice. will not copy Keel source, assets, screenshots, identity, claims, or deployment terminology. The implementation derives an original alice. design system with its own wordmark, tokens, components, product screenshots, responsive behavior, and accessibility. The same system covers marketing, authentication, onboarding, project/context selection, saved context, files, collaborators, permissions, connections, history, privacy, and deletion controls.

The friend-facing entry point is the unauthenticated `/about` route. Its hero uses direct participant language—keep the decisions, questions, and files the user chooses to save in one place so the same project can continue across AI tools—rather than leading with internal governance or project-intelligence terminology. The rest of the page explains the human-only save boundary, project/context loop, private-file and collaboration scopes, visible read receipts, provider boundary, invitation requirement, and prohibited-data rule without advertising an untested provider surface. Invited registration, the privacy/security notice, and the remaining public, authenticated, disclosure, and status pages link back into this small public information architecture; sign-in deliberately shows only the alice. identity and invite-only credential flow.

The current hosted image was replaced in place from source commit `eebbf7b` on 2026-09-06 after its automatic ECR scan returned no findings; the preceding private migration task had verified all 18 hosted migrations. Both web and MCP functions resolve immutable digest `sha256:be127a68ac5f3adb3412f4a4d6274439cfc12c4cb1ee92cc32b42dcb39c6cbd1`. Their health routes return HTTP 200 with PostgreSQL reachable, logged-out web `/` returns HTTP 303 to its own sign-in route, and `/about` plus `/privacy-security` return HTTP 200. The image includes the current ChatGPT Customize > Plugins destination and Claude connector-prefill destination, but deployment is not provider-surface compatibility evidence. Every surface remains `untested` and unadvertised until its own dated live run. The complete friend-facing task remains dependent on the permanent file-erasure controls and must not be used to advertise an unverified provider surface or deletion promise.

Product-owner visual feedback on 2026-09-01 established one additional interaction rule: every anchor must look clickable rather than relying on underlined text alone. Primary navigation or continuation actions use the filled green button treatment; secondary navigation, contextual actions, footer links, and inline links use the quieter bordered dark button treatment. Both retain the shared visible focus outline, hover contrast, responsive wrapping, and semantic anchor behavior.

Product-owner copy feedback on 2026-09-02 establishes a punctuation rule for the website and any private invitation message: avoid em dashes. Use complete sentences, commas, colons, or parentheses where appropriate.

The approved no-send private-alpha invitation copy is maintained in [`docs/private-alpha-invitation-template.md`](private-alpha-invitation-template.md). It uses the approved message “Switch AI tools. Keep the plot.” and must be manually delivered only after a separately approved one-time registration link is created for the exact recipient.

Product-owner feedback on 2026-09-02 removes the public `What alice. does` and `Privacy and security` navigation links plus the matching `About alice.` and `Privacy and security` footer links from the invite-only sign-in page only. The sign-in page remains focused on the alice. identity, workspace explanation, credentials, and invitation requirement. The public `/about` and `/privacy-security` routes and their links on registration, public, disclosure, authenticated, and status pages remain unchanged; invitees still see the required prohibited-data notice before account creation.

That sign-in-only change is live in source commit `43febda` at the retained web origin. A bounded unauthenticated fetch returned HTTP 200 and contained zero occurrences of the two navigation labels, two information-route links, matching footer labels, or a footer element while retaining the sign-in form and invitation message. The information routes each still return HTTP 200. Live visual inspection showed only the wordmark, private-workspace explanation, credential form, and invitation note, with no horizontal overflow or console warning/error.

Functional, database, authorization, file, provider-capability, and deployment foundations precede final presentation work. The product owner reviews and explicitly approves public and in-product copy before the friend-facing UI is complete. Copy must describe shipped behavior and must not position alice. as a chatbot, AI model, router, or agent orchestrator.

The copy review must cover at least:

- the one-sentence product promise and target user;
- project/context selection and cross-host continuation;
- exact single-action Save/no-action behavior, saved context, and historical Needs attention language;
- direct uploads and host-attachment save offers;
- invitations, roles, context visibility, and personal drafts;
- what alice. stores and what is sent to ChatGPT or Claude;
- removal, archive, export, permanent deletion, retention, and backups;
- connection recovery and revocation; and
- invite-only alpha limitations and prohibited sensitive data.

No fabricated testimonials, customer logos, accuracy/ROI claims, compliance badges, provider-training promises, residency promises, or deletion promises may appear. The final UI requires keyboard and screen-reader semantics, visible focus, sufficient contrast, reduced-motion behavior, responsive desktop/mobile layouts, and comprehensible loading, empty, error, denied, revoked, upload, scanning, extraction, and deletion states.

## Privacy and friend-testing boundary

Until Milestone 06 is complete, testers must be told that this is a private prototype and must not enter sensitive, regulated, or client-confidential information. Version `2026-09-01.1` of the published operational notice is the durable disclosure in [`docs/private-alpha-privacy-security.md`](private-alpha-privacy-security.md); the unauthenticated web route is `/privacy-security`, every rendered product page links to it, and the prohibition appears before invited account creation.

The published notice describes:

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

No public incident-response address or legal entity name has been approved for the alpha. The notice therefore identifies the operator as the person who delivered the private invitation and sends privacy/security reports through that same private invitation channel. It must be updated only after a monitored public contact or formal operator identity is actually approved; neither may be inferred from Git metadata or a personal account.

Privacy-preserving instrumentation records events and bounded identifiers needed to measure setup, selection, retrieval, completed saves, historical review decisions, removal, restatement, and repeat use. It must not record passwords, bearer tokens, exact evidence payloads, complete prompts, model responses, or restricted-context metadata. Routine ignored or expired Save previews are deliberately not converted into durable analytics events, so the product must not claim an ordinary-user Save-card completion denominator from retained project history.

The implemented `Alpha signals` view derives content-free aggregates from existing connection ownership, immutable read receipts, retained evidence/candidate outcomes, and decision/repair audits. It measures observed read outcomes, retained capture outcomes, cross-host reuse within seven days, and repeat UTC-week use without selecting project values or evidence payloads. Routine single-action saves appear there only after Save, while ignored and expired previews leave no durable project event; the view labels that limitation rather than treating completed saves as all offers. Ordinary host turns where no call occurs also remain unobservable, so the page does not turn received attempts into an invocation rate. Machine-readable contract `alice.host-invocation-denominator.v1` instead defines a consented synthetic trial cohort for each exact surface: every trial is declared before the turn, finishes as successful read, failed read, or no call, and retains only opaque IDs, run metadata, outcome classes, and aggregates. A surface cannot be advertised without a dated measurable cohort. No current surface has such a live run, so no current invocation percentage is claimed. Detailed definitions are in `docs/product-signals.md`.

The implemented project `Access and security` view is an authorization-derived explanation surface, not a second permissions system. It shows active project members, the current audience of each context the viewer is already allowed to know exists, the signed-in user's own active AI connections, and a bounded recent security history. It never reveals another collaborator's connection state. Security rows are mapped through a fixed action allowlist and display only a human-readable action, a currently permitted context name when applicable, a privacy-bounded actor label, and time; raw audit metadata, identifiers, tokens, correlation values, and submitted evidence are never rendered. Full rules are in `docs/project-access-and-security.md`.

## Verification boundary

Milestone 06 is not complete on local happy paths alone. Verification must cover:

- a clean PostgreSQL migration and restored backup;
- hosted web and MCP OAuth/read/write/revocation flows from both target hosts;
- standards-level and local MCP App verification for the ChatGPT and Claude project/context picker, conversation binding or disclosed connection-wide fallback, single-action Save card, and alice.-controlled web fallback; live exact-surface results are recorded just in time in Milestone 07 rather than gating Milestone 06 on every provider client;
- a visible deterministic package preview plus last-read receipts and skipped/failed-invocation states that do not mutate project state;
- project and context selection across multiple projects and concurrent sessions;
- exact-preview Save confirmation plus closing, ignoring, and expiry behavior that creates no durable project state;
- direct file upload, validation, scanning, preview, versioning, authorized download, removal, export, erasure, and backup-expiry behavior;
- ChatGPT and Claude attachment-save offers, confirmed transfer where supported, file-only and extraction choices, no-action expiry, duplicates, failures, generated files, and the pre-targeted alice. upload fallback;
- malicious file content and prompt-injection attempts that cannot call tools, broaden access, activate context, or mutate evidence/accepted state;
- removal from active consumption without provenance loss;
- invitations, role changes, context restrictions, ownership edge cases, and per-user connections;
- non-disclosure under cross-tenant, non-member, insufficient-role, guessed-ID, revoked-token, and restricted-context requests;
- deterministic, budgeted, provenance-bearing context after collaboration filtering;
- Keel-directed visual consistency, desktop/mobile accessibility, copy approval, and first-time-user comprehension; and
- agreement between participant-facing privacy statements and actual system behavior.

Private-alpha recruitment begins only after these checks and the full repository verification contract pass. Before a participant uses a specific ChatGPT or Claude client, Milestone 07 separately records a dated result for the exact surface and capabilities that participant needs.
