# alice. Milestones

This file is the persistent implementation roadmap for alice. Milestones are evidence-gated: later work should not begin merely because earlier code exists.

## Frozen Milestone 01-05 scope

The first product test is the complete ChatGPT to alice. to Claude to alice. to ChatGPT round trip.

Approved defaults:

- The first cohort contains only users whose ChatGPT and Claude accounts support the required authenticated remote MCP read/write flow. Plan name alone is not the eligibility test; the actual account, region, surface, and applicable policy must expose the required capabilities.
- Each user receives one private workspace containing projects. Teams, roles, sharing, and organizations were deferred through Milestone 05.
- Host-generated tool arguments are stored as evidence and candidate claims. They never directly mutate trusted state.
- Success requires meaningful continuation across two AI switches without manually restating saved project context.

Frozen non-goals for the spike:

- Routing between models
- Embeddings or vector search
- Secondary extraction or reconciliation models
- Teams, roles, sharing, or organizations
- Token and usage dashboards
- File intelligence
- Passive conversation access
- Browser scraping or a browser extension
- Additional AI providers
- An alice. chatbot

## Roadmap amendment before private alpha

The completed Milestone 01-05 trust and provenance foundation remains authoritative. Product testing on 2026-08-30 showed that friend testing would otherwise require too much manual connection, project selection, capture, and review work, while the current SQLite topology and single-user tenancy are not suitable for the intended hosted, collaborative alpha.

Milestone 06 therefore adds private-alpha foundations before recruiting participants. It admits PostgreSQL, stable hosting, projects with selectable work contexts, streamlined user-confirmed saving and removal, project sharing, and context permissions. These additions do not relax the central invariant: an AI host can create evidence and candidate claims, but only an explicit authenticated human action on an exact preview can make that content active project context. Collaboration grants access; it does not make host-generated material alice.-verified.

## Milestone 01 — Round-Trip MCP Compatibility Spike

Status: Complete

Branch: `milestone-01-mcp-compatibility-spike`

Objective:

Prove that eligible ChatGPT and Claude accounts can complete the full authenticated consumption and capture loop, with human-governed trusted state and preserved provenance.

Tasks:

- [x] Define the canonical four-decision round-trip fixture and baseline copy/paste comparison.
- [x] Create the minimum publicly reachable authenticated MCP endpoint.
- [x] Add an authenticated project-context read tool.
- [x] Add an append-only candidate-update write tool.
- [x] Store the exact submitted payload as immutable evidence before creating candidate claims.
- [x] Add the minimum review action required to accept candidates into trusted state.
- [x] Verify that the target personal ChatGPT Plus account exposes Developer mode and record the provider-adapter fallback decision.
- [x] Verify authenticated read and write calls from the target ChatGPT account.
- [x] Save and approve decisions A-C: ICP, product form, and monthly price.
- [x] Verify Claude retrieves and correctly uses A-C without them being restated.
- [x] Save and approve decision D from Claude.
- [x] Verify ChatGPT retrieves and correctly uses A-D after the second switch.
- [x] Compare the recurring Alice workflow with manual copy/paste and record the result.
- [x] Document protocol behavior, host differences, limitations, and go/no-go recommendation.

Success criteria:

- Both ChatGPT and Claude can read authenticated alice. context.
- Both can explicitly write candidate updates.
- Candidate updates cannot silently modify trusted state.
- Provenance survives the complete round trip.
- Claude correctly uses A-C without manual restatement.
- ChatGPT correctly uses A-D without manual restatement after returning from Claude.
- Excluding first-time connection setup, the tester finds Alice easier than copying context manually.
- The working tree is clean and all spike results are documented.

Notes:

- MCP connectivity alone is not success.
- The initial hidden successful-retrieval and 10-minute D details were not inferable from A-C or the unchanged Claude prompt. The dated fixture correction now scores the disclosed decision shape plus explicit human acceptance; the original failed-run evidence remains recorded.
- The inspected target ChatGPT Plus account exposes `Settings > Security and login > Developer mode`. It was off during the failed setup attempt; Business is not a documented prerequisite for this target account.
- Native MCP remains the preferred spike path. Explicit handoff is the supported fallback and copy/paste baseline. A browser companion remains a frozen non-goal unless a later evidence-gated milestone explicitly admits it.
- Current provider findings and dated official references are in `docs/provider-adapters.md`; revalidate them because provider capabilities can change.
- If an account cannot complete the required official integration flow, it is ineligible for the first cohort; the spike is testing continuity, not general provider compatibility.
- Completed on 2026-08-27. The full ChatGPT → alice. → Claude → alice. → ChatGPT round trip passed the corrected disclosed rubric with human-governed trusted state and end-to-end provenance. Milestone 02 was not started.
- Two earlier Claude D candidates remain pending as preserved failed-run evidence and are excluded from trusted context.

## Milestone 02 — Repository and CI Scaffold

Status: Complete

Branch: `milestone-02-repository-scaffold`

Objective:

Turn the successful spike into a small, maintainable TypeScript repository with repeatable local and CI verification.

Tasks:

- [x] Establish the workspace layout for web, MCP, shared schemas, domain logic, and database access.
- [x] Add formatting, linting, typechecking, unit tests, and production builds.
- [x] Add environment validation and secret-leak checks.
- [x] Add CI that runs all required checks from a clean checkout.
- [x] Document local setup and deployment boundaries.

Success criteria:

- A clean checkout installs, typechecks, tests, and builds both deployables.
- Secrets and provider configuration remain server-side.
- Spike behavior is preserved or explicitly documented as deferred to later milestones.

Notes:

- Avoid orchestration or infrastructure that two small deployables do not yet require.
- The npm workspace now separates `apps/web`, `apps/mcp`, `packages/config`, `packages/schemas`, `packages/domain`, and `packages/database`. The Milestone 01 review authority remains server-side in the web deployable; MCP capture remains candidate-only.
- The root scripts are the single verification interface: Prettier formatting, ESLint, TypeScript project-reference typechecking, the 15-test Milestone 01 regression suite plus configuration-policy tests, and production compilation for both deployables.
- Server configuration now fails closed on missing or ambiguous secrets, weak passphrases, invalid ports, and non-HTTPS public origins. Repository checks reject tracked environment files, high-confidence credential patterns, and secret-like browser-public environment names.
- GitHub Actions runs on Node.js 24 with read-only repository permissions, installs only from `package-lock.json`, and executes formatting, linting, typechecking, secret scanning, tests, and both production builds as separate gates.
- Local setup, server-only configuration ownership, two-process startup, build artifacts, and the transitional same-host SQLite constraint are documented in `docs/repository-and-deployment.md`.
- Completed on 2026-08-27. A fresh local clone installed with `npm ci`, passed `npm run check` with 18 tests, and emitted both `apps/web/dist/server.js` and `apps/mcp/dist/server.js`. Candidate-only MCP writes, immutable evidence, human-governed trusted state, authenticated context retrieval, and provenance remain covered by the preserved regression suite. Milestone 03 was not started.

## Milestone 03 — Authentication and Data Foundation

Status: Complete

Branch: `milestone-03-auth-and-database`

Objective:

Implement production-shaped user authentication, one private workspace per user, projects, tenant isolation, evidence, candidate claims, accepted state, integration connections, and audit history.

Tasks:

- [x] Implement user authentication and automatic private-workspace creation.
- [x] Implement projects inside the user's private workspace.
- [x] Add immutable evidence events and append-only audit events.
- [x] Add candidate claims and versioned accepted project state.
- [x] Add integration connection records without storing host passwords or bearer tokens.
- [x] Add deny-by-default tenant authorization policies.
- [x] Add cross-tenant negative tests for every project data path.

Success criteria:

- A user can authenticate, create projects, and revisit the same private workspace.
- Evidence and audit history remain immutable through normal application roles.
- Candidate creation cannot change trusted state; only explicit human review can do so.
- Accepted state is versioned and traceable to its candidate and evidence.
- Two users cannot read or mutate each other's workspace or project data, including with guessed identifiers.
- Pending candidates remain excluded from trusted context by default.
- A clean checkout installs, format-checks, lints, typechecks, scans for secrets, tests, and builds both deployables.
- CI passes, documentation is current, and the working tree is clean.

Notes:

- Do not add team or sharing UI.
- Started on 2026-08-27 after verifying Milestone 02 complete. Merge `04182ac` is present on synchronized local and remote `main`, the starting tree was clean, and GitHub Actions run `33065649076` passed the Milestone 02 merge verification.
- First-party registration and login now use salted scrypt password digests, opaque hashed web sessions, and transactional creation of exactly one private workspace. MCP OAuth grants resolve the authenticated alice. user rather than a shared spike identity. The shared spike passphrase has been removed from runtime configuration.
- Authenticated users can create bounded projects, list them in their private workspace, open project details, and revisit the same projects after a new login. Identifiers are server-generated, names are unique per workspace, and foreign or guessed identifiers return a non-disclosing not-found response.
- Evidence capture retains the exact validated payload and content hash, while database triggers reject all evidence updates and deletes. Registration, sessions, projects, integration grants/revocation, candidate submission, and human acceptance append identifier-only audit events; audit updates and deletes are also database-rejected.
- Candidate content is immutable with a single pending-to-terminal review transition. Explicit web review appends immutable accepted-state versions; database constraints bind every accepted version to the exact candidate/evidence pair, and current context returns only the latest accepted version with provenance while retaining prior history.
- OAuth grants now create tenant-bound integration connection records with client classification, bounded scopes, usage timestamps, and revocation state. Authorization codes, confidential client secrets, access tokens, and refresh tokens are stored only as hashes; connection audit metadata contains no bearer values or host credentials.
- Shared deny-by-default policies now resolve project access only from a server-authenticated user/private-workspace scope. MCP writes additionally require an active connection whose user, workspace, and registered client all match the verified bearer token. Missing, unknown, mismatched, and revoked principals perform no project read or write; composite tenant foreign keys remain the database backstop.
- A two-user integration matrix now tests both tenant directions across web project list/create/detail, review queue/acceptance, MCP project list/context/capture, and database evidence/candidate/accepted-state/audit references. Real foreign identifiers and random guessed identifiers produce the same non-disclosing failures; denied mutations leave evidence, candidates, accepted state, and audit counts unchanged.
- Completed on 2026-08-28. GitHub Actions run `33120153227` passed implementation commit `44c2795`. A fresh local clone at documentation commit `cf82e07` installed with `npm ci`, passed the complete `npm run check` contract with 33 tests, and emitted both `apps/web/dist/server.js` and `apps/mcp/dist/server.js`. Authentication, one private workspace per user, tenant-scoped projects, immutable evidence and audit history, candidate-only MCP writes, human-only versioned acceptance, hash-only integration credentials, and both-direction guessed-identifier isolation are verified. Milestone 04 was not started.

## Milestone 04 — Capture Loop

Status: Complete

Branch: `milestone-04-capture-loop`

Objective:

Productionize explicit capture from supported AI hosts into immutable evidence, candidate claims, review, and trusted state.

Tasks:

- [x] Finalize the `save_project_update` contract and validation limits.
- [x] Make evidence, candidates, provenance, and audit creation transactional and idempotent.
- [x] Build the candidate review queue.
- [x] Implement accept and reject actions.
- [x] Implement explicit supersession without overwriting history.
- [x] Add capture evaluations for correct and incorrect tool selection.

Success criteria:

- Ordinary AI work does not change alice. state.
- An explicit save creates immutable evidence and pending candidates exactly once.
- Idempotent retries cannot duplicate or alter captured state.
- Only an authenticated human review action can accept or reject candidates.
- Rejection and supersession preserve complete provenance and history.
- Candidate creation cannot change trusted state.
- Cross-tenant negative tests continue to pass for every capture and review path.
- Capture evaluations cover correct and incorrect tool-selection behavior.
- A clean checkout installs, format-checks, lints, typechecks, scans for secrets, tests, and builds both deployables.
- CI passes, documentation is current, and the working tree is clean.

Notes:

- Host-generated does not mean alice.-verified.
- Started on 2026-08-28 after verifying Milestone 03 complete. Merge `e27e546` is present on synchronized local and remote `main`, the starting tree was clean, and GitHub Actions run `33120961142` passed the Milestone 03 merge verification. The complete local `npm run check` contract also passed with 33 tests and both deployable builds before this branch was created.
- `save_project_update` now exposes a strict, explicit-save-only contract: 1-20 unique state keys, bounded summaries and deliberately supplied source material, safe 8-128 character retry keys, 8 KiB/depth-8/256-node candidate values, and a 32 KiB validated payload ceiling. Unknown fields and attempts to imply acceptance, rejection, or supersession are outside the tool contract; the exact normalized validated payload remains the immutable evidence body.
- Capture idempotency is now resolved inside the same immediate transaction as evidence, candidates, provenance, and one correlated audit event. Commit requires a complete receipt; forced candidate or audit failures roll every capture row back. Identical retries return the original evidence, audit, correlation, provenance, and payload-ordered candidate identifiers without another write, while different-payload key reuse and incomplete receipts fail closed.
- The authenticated web control plane now provides a private-workspace review dashboard and per-project queues with pending-only defaults, terminal-history filters, counts, bounded pagination, proposed values, deliberately saved source material, accepted-version references, and evidence/client/tool/hash/timestamp provenance. Workspace and project queries remain server-scoped, and both-direction tests keep foreign projects and queue counts undisclosed.
- Pending candidates now expose separate accept and reject forms only behind an authenticated alice. web session. Acceptance creates versioned trusted state; rejection creates none. Each terminal transition shares a transaction with an immutable human-review audit event, failed audit insertion restores `pending`, repeat or conflicting decisions fail without mutation, retries only report terminal status, and both review operations remain absent from MCP.
- Replacing trusted state now requires a separate authenticated supersession form naming the exact current accepted-state identifier; ordinary acceptance fails once a state key exists. The transaction rejects stale, guessed, foreign, project-mismatched, and key-mismatched targets, appends the next accepted version plus an immutable audit link from old to new, and rolls back the new version and candidate transition if audit creation fails. Prior accepted rows remain immutable and current context selects the highest version.
- A versioned 20-case capture tool-selection fixture now covers ChatGPT, Claude, and provider-neutral traces: ten compliant explicit-save/read/no-op cases and ten correctly rejected false-positive, false-negative, forbidden-review-tool, and duplicate-write cases. `npm run eval:capture` is a standalone local and CI gate and is also exercised by the test suite. This deterministic policy evaluation does not claim live-host invocation rates; the candidate-only runtime boundary remains authoritative.
- Completed on 2026-08-29. Implementation commit `a515cdf` passed GitHub Actions run `33271672295`. A fresh detached checkout installed with `npm ci`, passed formatting, linting, typechecking, secret scanning, all 20 capture evaluations, all 43 tests, and production builds for both deployables. Explicit capture is atomic and idempotent; review is authenticated and human-only; rejection and supersession retain immutable history and provenance; tenant-negative coverage remains both-directional. Milestone 05 was not started.

## Milestone 05 — Consumption Loop

Status: Complete

Branch: `milestone-05-consumption-loop`

Objective:

Deliver compact, trustworthy, task-specific project context to ChatGPT and Claude.

Tasks:

- [x] Finalize `list_projects` and `get_project_context` contracts.
- [x] Build deterministic context packages from accepted state.
- [x] Include relevant open questions, artifact references, and unresolved conflicts when available.
- [x] Add package version, freshness, provenance references, budget, and omission reporting.
- [x] Add cross-host context evaluations using the canonical fixture.

Success criteria:

- [x] Context contains accepted state rather than unreviewed candidates by default.
- [x] Every accepted assertion is traceable to accepted-state, candidate, and evidence provenance.
- [x] Context assembly is deterministic for the same authenticated project state and request.
- [x] Package version and persisted-source freshness are explicit.
- [x] The complete serialized package stays within its declared budget and reports per-section omissions.
- [x] Relevant open questions, artifact references, and unresolved conflicts are represented without being presented as trusted decisions.
- [x] Pending and rejected candidate values remain excluded from trusted context by default.
- [x] Both target-host evaluations correctly use the required project decisions without manual restatement.
- [x] Cross-tenant negative tests continue to pass for every consumption path.
- [x] Ordinary reads and context assembly cannot mutate captured or trusted project state.
- [x] A clean checkout installs, format-checks, lints, typechecks, scans for secrets, runs evaluations, tests, and builds both deployables.
- [x] CI passes, documentation is current, and the working tree is clean.

Notes:

- Begin with deterministic full-text and structured selection. Do not add embeddings in this milestone.
- Started on 2026-08-30 after verifying Milestone 04 complete. Merge `263e010` is present on synchronized local and remote `main`, the starting tree was clean, and GitHub Actions run `33272229448` passed the Milestone 04 merge verification.
- Consumption contract `1.0` now gives both read tools strict input/output schemas and side-effect-free semantics. Project discovery exposes current accepted-state count/freshness, while context requests declare a 2,000-32,000 UTF-8 byte package budget and receive separately typed trusted decisions, open questions, artifact references, conflict notices, deterministic package metadata, provenance, freshness, and omissions.
- Context assembly now selects only the latest accepted version of each key, ranks it with fixed structured-key and full-text weights against a normalized task, and uses state key plus accepted identifier as deterministic tie-breakers. Repeated reads of unchanged state and request are byte-equivalent; pending, rejected, and superseded values remain excluded.
- Accepted question- and artifact-prefixed state now appears in separately typed sections with full provenance and reference-only handling. Read-time conflict signals cite the trusted current version plus pending candidate/evidence references while omitting pending values and summaries; rejected and identical-value candidates create no signal, and detection cannot resolve or mutate state.
- Package versions hash the normalized request, selected output, complete consulted source inventory, freshness, and omissions, so even budget-omitted state changes invalidate the version. Freshness comes only from persisted timestamps; every accepted item carries accepted-state/candidate/evidence identifiers plus the evidence hash and capture time. Exact full-package UTF-8 accounting is enforced before each selection, per-section omissions are explicit, and undersized envelopes fail closed without a project-state write.
- A versioned canonical evaluation now seeds the real tenant/evidence/candidate/accepted-state model for the Claude A-C and returning ChatGPT A-D legs. Both disclosed traces retrieve and exactly use the required accepted decisions with zero manual restatement, complete provenance, deterministic budget-compliant packages, and no pending-value leakage. `npm run eval:context` is an offline local and CI gate; it adds no model orchestration and does not replace dated live-host validation.
- Completed on 2026-08-30. GitHub Actions run `33273541250` passed implementation commit `3a1c32b`. A true fresh local clone installed with `npm ci` with zero reported vulnerabilities, passed formatting, linting, typechecking, secret scanning, all 20 capture evaluations, both canonical cross-host context evaluations, all 48 tests, and production builds for both deployables. Deterministic accepted-state selection, complete provenance and freshness, exact byte budgets and omissions, separately typed questions/artifacts/conflicts, pending/rejected exclusion, read-side project-state immutability, and both-direction tenant isolation are verified. Milestone 06 was not started.

## Milestone 06 — Private Alpha Foundations

Status: In Progress

Branch: `milestone-06-private-alpha-foundations`

Objective:

Make alice. safe and low-friction enough for an invite-only friend alpha without weakening provenance, explicit human authority, tenant isolation, or provider-secret boundaries.

Tasks:

- [x] Replace production SQLite persistence with PostgreSQL and an async database boundary while preserving the complete accepted-state, evidence, candidate, audit, idempotency, supersession, and tenant-isolation model.
- [x] Add versioned PostgreSQL migrations, real PostgreSQL CI coverage, backup/restore verification, and a documented SQLite development-data disposition; keep exact immutable evidence payload bytes in text rather than normalizing them through JSON storage.
- [ ] Deploy stable HTTPS web and MCP origins backed by the same managed PostgreSQL database, with server-only secrets, encryption in transit and at rest, redacted logs, health checks, migration controls, and no reliance on ephemeral local filesystems or quick tunnels.
- [x] Add an invite-only alpha gate and an alice. connection center for ChatGPT and Claude with per-user OAuth connection status, stable setup instructions, recovery, and revocation; never share host credentials or integration bearer tokens between collaborators.
- [ ] Maintain a dated, versioned host-surface compatibility matrix and record live results for Claude web, Claude Desktop, Claude iOS, Claude Android, Claude Code, ChatGPT web, ChatGPT desktop, Codex desktop, Codex CLI, and the Codex IDE extension. On every surface, test OAuth connection/reconnection/revocation, permitted project discovery and selection, accepted-context reads, candidate save plus exact human confirmation/cancellation, file references and attachment-transfer fallback, and permission non-disclosure. An untested or provider-blocked surface remains explicitly unsupported rather than inheriting another surface's result.
- [x] Let each user list and select a project in alice. before working in a host, then select an existing work context or create a new one. Make the active project/context target explicit, visible, and safely scoped per user and connected host so concurrent work cannot silently land in the wrong project.
- [x] Add durable project work contexts with project-wide context plus context-scoped entries, context history, and deterministic structured/full-text similarity suggestions. Similar contexts may be suggested or grouped only after human confirmation; do not add embeddings in this milestone.
- [x] Update consumption so supported hosts can use the selected project/context without the user repeatedly typing “use alice.”, while retaining an explicit fallback when a host cannot reliably honor an active selection.
- [x] Replace the routine two-step capture/review journey with one exact, user-visible save preview naming the destination project and context. A check is an explicit authenticated human acceptance action; a cross cancels. The host tool call alone must still create immutable evidence and candidate claims only and must never activate project context.
- [x] Provide a saved-context view using user-facing language such as Saved context, Needs attention, Removed, and History rather than requiring users to understand the internal trusted-state model.
- [ ] Add private project and context file uploads for bounded PDF, PNG, JPEG, WebP, plain-text, and Markdown files. Store bytes in private object storage and only metadata, hashes, provenance, permissions, and lifecycle state in PostgreSQL; verify file signatures, scan uploads, use short-lived authorized access, and never expose permanent public object URLs.
- [ ] Add file upload, progress, preview, download, version, access, remove-from-context, export, and permanent-deletion controls. Files inherit project/context permissions, and one immutable object may be referenced from multiple authorized contexts without duplicating bytes or silently broadening access.
- [ ] When a user attaches a file while working in ChatGPT or Claude, offer an exact `Save this file to alice.?` preview naming filename, project, context, and access. The user may save the file only, save it and request context suggestions, or cancel; no host attachment is copied to alice. without an explicit authenticated confirmation.
- [ ] Add a capability-gated host attachment-transfer path and the smallest alice.-controlled upload fallback when a provider cannot securely expose the attachment. Preserve source host, uploader, time, content hash, and available conversation provenance without storing host credentials or unrelated conversation history.
- [ ] Add deterministic bounded text extraction and retrieval for supported files. Extracted statements remain evidence-backed candidate suggestions until individually confirmed, file contents are untrusted for instruction-following, and artifact delivery observes context budgets, omission reporting, and permission filtering. Do not add embeddings or model orchestration.
- [x] Let authorized users remove an item from active context through an append-only exclusion or superseding version that preserves provenance and audit history. Keep remove-from-context, project archive, and permanent privacy deletion as distinct actions.
- [ ] Add project archive, export, and policy-governed permanent deletion workflows, including documented retention and backup-deletion timelines and a privileged erasure path outside ordinary application roles; normal roles must remain unable to rewrite immutable evidence or audit history.
- [x] Add project invitations and membership lifecycle with Owner, Editor, and Viewer capabilities, including explicit ownership transfer or safe project disposition before the last owner can leave.
- [x] Add context-level access for all project members, selected project members, or a personal draft, with Viewer, Editor, and Manager capabilities bounded by the user's project role. Define and display whether project owners can administer restricted contexts.
- [ ] Extend deny-by-default authorization, database constraints, audits, and negative tests to every membership, invitation, project, context, active-selection, capture, review, export, archive, removal, and deletion path. Denied users must not learn restricted identifiers, names, counts, freshness, conflicts, artifacts, or provenance.
- [ ] Add privacy-preserving product instrumentation and an in-product access view showing who can access each project/context, which AI connections are active, and when relevant security actions occurred without logging bearer tokens or submitted evidence content.
- [x] Make successful and failed consumption visible: show the exact bounded package a host would receive, package size/freshness/provenance/omissions, and a last-read receipt naming the host, surface, project, context, and time. Never imply alice. was consulted when the host did not call it.
- [x] Add a repair path for stale, contradicted, or superseded saved context without rewriting accepted state, evidence, provenance, or history.
- [ ] Measure confirmation burden, save-offer completion, host invocation rate, cross-host reuse, and repeated weekly use without logging project content.
- [ ] Publish private-alpha privacy and security disclosures covering collected data, purposes, recipients and AI-provider boundaries, retention, backups, exports, removal and erasure, subprocessors, incident contact, and the prohibition on sensitive, regulated, or client-confidential test data until the corresponding controls are verified.
- [ ] After the functional, security, permission, file, and deployment foundations are verified, implement the complete friend-facing website and authenticated product UI using Keel as the single visual-system reference. Adapt its calm, product-first hierarchy to alice.; do not copy Keel assets, code, claims, or deployment-specific language.
- [ ] Review and approve the public website and in-product copy with the product owner before final UI completion. Copy must explain the actual project/context workflow, connections, file handling, collaboration, privacy, and AI-provider boundaries without calling alice. a chatbot or orchestrator or making unverified security, training, residency, deletion, customer, or performance claims.
- [ ] Verify the Keel-directed UI at supported desktop and mobile sizes for keyboard access, semantic controls, focus treatment, contrast, loading/empty/error states, reduced motion, and comprehension of project/context destination, permissions, save/cancel, file transfer, and deletion consequences.
- [ ] Add capability and cross-host evaluations for project/context selection, read/fetch, save offer and fallback, one-confirmation activation, cancellation, file upload/transfer/extraction, removal, sharing, revocation, concurrent users, and permission non-disclosure.
- [ ] Run the clean-checkout contract against both deployables and PostgreSQL: install, format-check, lint, typecheck, scan for secrets, run all evaluations and tests, build, migrate an empty database, exercise backup/restore, and verify the hosted web and MCP paths.

Success criteria:

- Production web and MCP deployables use one managed PostgreSQL database; no production request depends on SQLite or an ephemeral filesystem.
- PostgreSQL concurrency and constraints preserve transactional idempotent capture, immutable evidence/audit history through normal roles, versioned accepted context, rejection/supersession history, and complete provenance.
- A friend can accept an invitation, connect each supported host, select a permitted project/context, retrieve context, save an exact preview with one authenticated confirmation, see it under Saved context, and remove it from active context without using a terminal, tunnel, custom endpoint, or repeated “use alice.” phrasing.
- AI output never becomes active context because the model called a tool, inferred consent, or generated a confirmation. The exact authenticated human check remains the authority boundary and the cross remains a no-write/no-activation path.
- A user can upload a supported file directly to an authorized project/context, preview it, control its audience, and retrieve it without the object becoming public or its contents automatically becoming active assertions.
- When a supported host can transfer an attached file, the user sees the exact filename, destination project/context, access scope, and file-only versus extraction choice before alice. stores it. Cancellation performs no alice. file write, and unsupported host transfer falls back to an alice.-controlled upload without pretending the file was saved.
- Extracted file content is traceable to the immutable uploaded object and remains untrusted candidate material until confirmed. Malicious document instructions cannot select tools, expand access, activate context, or mutate captured/trusted state.
- Pending, rejected, removed, and inaccessible content remains excluded from normal consumption; none is presented as an active decision.
- Multiple users can collaborate only within explicit project and context permissions, and every user's AI connection remains separately authorized and revocable.
- Every project and context path remains deny-by-default. Cross-tenant, non-member, insufficient-role, guessed-identifier, revoked-connection, and restricted-context tests disclose neither content nor metadata and perform no mutation.
- Every listed host surface has a dated pass, fail, or provider-blocked record for OAuth, project selection, accepted-context read, save/confirm/cancel, file references/transfer fallback, and permission denial. Only passing capabilities may be advertised; a blocked capability has an explicit alice.-controlled fallback and is never silently inferred from another surface.
- Users can preview what alice. would send and can see whether a host actually retrieved it. Failed or skipped invocation is distinguishable from a successful read, and a host that cannot reliably offer save has an alice.-controlled review/confirmation path.
- Users can distinguish active-context removal, project archive, export, and permanent deletion, and the implemented behavior matches the published retention and backup policy.
- Privacy/security copy makes alice. storage, collaborator access, AI-provider transfer, subprocessors, retention, and user controls understandable without making unverified promises about provider training, residency, or deletion.
- The public site and authenticated product use one coherent Keel-directed visual system, the product owner has approved the copy, and first-time testers can identify the active project/context, connected hosts, saved context, files, collaborators, access level, and next safe action without terminal instructions.
- A clean checkout and the hosted environment pass all verification gates, documentation and `MILESTONES.md` are current, CI passes, and the working tree is clean.

Notes:

- Started on 2026-08-30 after verifying Milestone 05 complete. Merge `08717cd` and private-alpha planning commit `377cfd0` are present on synchronized local and remote `main`, the starting tree was clean, and GitHub Actions run `33279054848` passed commit `377cfd0`. Implementation is sequenced to verify the single-user project/read/save/repair loop before collaboration and final presentation work.
- Production persistence now uses the pooled asynchronous `pg` adapter and PostgreSQL migration `001_initial.sql`; runtime configuration accepts no SQLite path and requires database TLS away from loopback. PostgreSQL-native advisory and row locks replace `BEGIN IMMEDIATE` for capture, review, and credential-consumption races. The real-PostgreSQL gate verifies repeatable migration, twelve-way identical capture, conflicting idempotency reuse, concurrent supersession, byte-exact evidence text/hashes, immutable-history DML rejection, and tenant denial. The fast in-memory SQLite adapter is isolated to `@alice/database/testing` and is unreachable from production configuration.
- Migrations are now an explicit operator action using a separate owner credential. Deployables only verify the exact migration ledger and run as a constrained PostgreSQL role that cannot manage schema or rewrite immutable history. CI provisions PostgreSQL 17, migrates an empty database, runs the real concurrency/constraint gate, and dump/restores the database. A local PostgreSQL 17 restore matched 48 protected tables across every fixture schema. Pre-alpha SQLite files are deliberately discarded rather than silently imported.
- Registration now requires a single-email, expiring, one-time alpha invitation whose random token is stored only as a digest; concurrent PostgreSQL acceptance creates exactly one account. The authenticated connection center shows only that user's ChatGPT/Claude OAuth metadata and stable MCP address, provides recovery guidance, and atomically revokes the selected connection plus its access/refresh tokens. Foreign connection identifiers disclose nothing. Collaborators never inherit these grants.
- Every project now has one durable project-wide context and an initial `General` work context, with append-only content-free context history. Immutable candidate-target and accepted-entry mappings preserve exact context destinations without rewriting pre-context history; old entries backfill to project-wide. The authenticated web flow shows an exact creation preview and deterministic normalized structured/full-text suggestions; suggestions never create, merge, move, select, or broaden a context. Foreign project/context paths disclose nothing, and no embeddings or model calls are used.
- Each OAuth connection can now have one human-selected project/work-context target, visible and editable in the connection center. Composite tenant/context foreign keys, opaque selection versions, ordered PostgreSQL row locks, and stale-form rejection prevent cross-user selection and silent concurrent overwrite; an explicit apply-to-all action is the only bulk path. Selection remains absent from MCP and appends content-free history/audit records.
- Consumption contract `2.0` adds permitted work-context discovery and the read-only `get_active_context` normal path. It resolves the exact connection target without host-supplied identifiers, layers project-wide plus selected-context accepted state, excludes other contexts, and uses selected-context precedence for duplicate keys. Explicit `get_project_context` remains the fallback, and candidate capture can omit destination only when the active target supplies it; explicit mismatches fail without a write.
- Candidate capture receipts now open one evidence-bound alice. save preview naming the exact project, work context, access mode, proposals, source material, and any replaced versions. One authenticated check atomically accepts the complete capture; one authenticated cross rejects it with no activation. Opaque preview versions, stable advisory-lock ordering, candidate row locks, and both-direction tenant tests make stale, concurrent, foreign, and guessed decisions fail closed. The Needs attention queue remains the alice.-controlled fallback when a host cannot render a secure native confirmation.
- Every project-wide and work context now has a private lifecycle view using Saved context, Needs attention, Removed, and History. Current saved values and pending proposals are separated, pending items link to the exact confirmation preview, and rejected/cancelled proposals are described as not saved rather than removed. Technical provenance remains available in optional details; foreign and guessed project/context routes disclose no content or lifecycle counts.
- Active-context removal now uses an exact authenticated preview and an immutable context-entry exclusion rather than deleting or rewriting accepted state. Removed values and optional reasons remain visible with provenance and audit history, normal consumption excludes them, selected-scope removal can reveal an active project-wide fallback, concurrent PostgreSQL confirmations produce one exclusion, and a later confirmed save creates a new version while the removal remains history. Archive, export, and privileged permanent deletion remain separate unfinished workflows.
- The approved read-only infrastructure comparison recommends two Railway services in Amsterdam, Neon Launch PostgreSQL in Frankfurt, and private S3 Standard with GuardDuty Malware Protection in Frankfurt. Railway best matches the two always-on Express/Streamable HTTP deployables, Neon preserves TLS/role/restore requirements, and GuardDuty supplies a managed scan disposition that R2 alone cannot. The provisional low-volume envelope is USD 20-45/month with a USD 50 stop condition. No resource, paid plan, public origin, invitation, or user-data transfer has been created; provisioning and spend remain a separate product-owner approval gate. Full rationale and dated official references are in `docs/private-alpha-infrastructure-selection.md`.
- The local private-file foundation now has immutable PostgreSQL object/context-reference metadata, constrained lifecycle-only runtime updates, per-workspace content deduplication, signature/type/name/size validation, same-origin authenticated upload with progress, an optional server-only S3 adapter, GuardDuty-tag reconciliation, and 60-second exact-version authorized downloads. Pending, threat, unsupported, access-denied, scan-failed, and storage-failed objects remain unavailable; file content never becomes trusted context. SQLite route tests and real PostgreSQL role/transition tests pass, migration `007` is repeatable, and the protected file tables survive the logical dump/restore gate. File audience now inherits verified project/context permissions, but the two file task checkboxes remain open because no bucket/scanner/IAM policy has been provisioned or live-tested and privileged erasure, host transfer, extraction, and MCP file retrieval are not implemented.
- File remove-from-context now uses an exact authenticated preview plus immutable migration `008` exclusions. Removal immediately blocks download/scan access through that reference, preserves object bytes/metadata/provenance/audit history in a distinct Removed view, and remains different from permanent deletion. Stale, concurrent, foreign, guessed, and insufficient-context-role decisions fail closed in SQLite routes and real PostgreSQL. The broader file-controls task stays open because privileged erasure and live provider verification remain unfinished.
- Immutable migration `009` adds logical file versions and a replacement UI. Changed replacements cannot displace the old clean version while scanning or after a threat/failure; the newest clean version alone becomes current, and concurrent replacements create one next version. Clean text/Markdown is escaped and labelled untrusted, clean images are exact-version hash-verified and served with sandbox/default-deny headers, PDFs are never rendered inline, and authorized JSON export omits all storage locations and credentials. Foreign preview/replacement/export identifiers disclose nothing. The file-controls task remains open for privileged permanent erasure and live object-store/scanner verification.
- Migration `010` adds protected Owner/Editor/Viewer membership rows and expiring single-recipient project invitations with hash-only tokens, exact-email accept/decline, revoke, replacement, role change, non-owner removal, and safe append-only audits. Concurrent PostgreSQL acceptance creates one active membership; runtime roles cannot delete invitation/membership history, rewrite ended rows, or demote the last Owner.
- Migration `011` completes the current membership/context authorization slice. Project, context, active-target, capture, review, saved-context, file, and MCP consumption paths now resolve active membership plus required context capability. All-member contexts derive access from project role; selected-member contexts use immutable explicit grants; personal contexts are creator-only; and project Owners do not bypass restricted access. Viewer mutation controls are absent and domain writes fail closed. Ownership transfer is atomic, departure ends grants, and unsafe personal/unmanaged-context departure is blocked. A collaborator's private AI connection can target and capture into a separately anchored project workspace without sharing credentials. The regression suite passes 87 SQLite tests and 14 PostgreSQL tests, including grant concurrency/immutability and immediate revoked-target invalidation; a PostgreSQL 17 logical dump/restore matched 586 protected table instances across the accumulated disposable schemas. Broader archive/export/deletion and unimplemented file/host paths keep the milestone-wide authorization task open.
- Migration `012` adds immutable successful/failed MCP context-read receipts bound to the exact user-owned connection and client. Receipts store route, bounded failure reason, currently authorized destination, package version/byte size, and time, but no task or package content. Project and connection views show only the signed-in user's receipts and recheck current context access before revealing historical destination metadata. The authenticated project preview renders the exact deterministic package for a chosen task and budget without creating a host receipt; copy states that retrieval does not prove use in an answer and absence does not imply alice. was consulted. The complete gate passes 89 SQLite tests and all 14 real-PostgreSQL tests, including role-level immutability and mismatched-connection rejection; the new table also passed logical backup/restore verification.
- Saved context now has an exact, write-authorized repair flow for values the human classifies as stale, contradicted, or wrong. Repair reuses the append-only exclusion transaction, retains accepted state/evidence/provenance/audit history, and requires any corrected replacement to enter as a new candidate with a new human confirmation. History labels older accepted values as superseded and names the replacement version. The complete gate passes 91 SQLite tests and 14 PostgreSQL tests, including real-PostgreSQL supersession-history derivation. Privacy-preserving repair and confirmation-burden measurement remains a separate unfinished instrumentation task.
- This milestone intentionally changes the pre-alpha roadmap based on direct product testing. It does not retroactively alter what Milestones 01-05 proved.
- PostgreSQL is the production system of record. A local SQLite adapter may remain only if its supported purpose and semantic differences are explicit and it cannot be selected accidentally in production.
- Vercel is an acceptable target only after both deployables, long-lived protocol behavior, PostgreSQL connectivity, migrations, and stable OAuth origins pass hosted verification. Another platform may be selected if those requirements cannot be satisfied; the decision must be recorded before deployment.
- Provider surfaces may not support a native post-answer check/cross card. Record a capability matrix and use the smallest explicit alice.-controlled confirmation fallback rather than pretending a host behavior is guaranteed.
- Provider surfaces may also differ in whether and how an MCP integration can receive a user-attached file. Never infer transfer capability from the model's description of a file; verify the provider path and fall back to a pre-targeted alice. upload page.
- Provider behavior is surface-specific. Do not infer Claude mobile behavior from Claude web, ChatGPT desktop behavior from ChatGPT web, or Codex desktop behavior from Codex CLI. Record the provider/client version, account type, region, date, transport, and observed result for every live compatibility run.
- ChatGPT mobile is not part of the initial advertised compatibility set unless its custom remote MCP/plugin path is separately documented and live-tested. Its absence must not be hidden behind a generic “works everywhere” claim.
- The product's defensible promise is a user-governed, versioned, provenance-bearing project record that can travel across supported AI hosts. Cross-tool convenience is important, but it must not outrank visible confirmation, repairability, or honest evidence that alice. was actually used.
- “Saved context” is product language. Internally, evidence, candidate, accepted-state version, provenance, freshness, budgeting, omissions, conflicts, and audit boundaries remain intact.
- Keel is the single approved visual-system reference for Milestone 06. It informs hierarchy, restrained dark surfaces, product-first demonstrations, status presentation, and responsive card behavior; alice. retains its own brand, content, accessibility requirements, and interaction semantics.
- Complete product, data, permission, deletion, deployment, and privacy decisions are recorded in `docs/private-alpha-foundations.md`.

## Milestone 07 — Private Alpha

Status: Not Started

Branch: `milestone-07-private-alpha`

Objective:

Test whether real users repeatedly prefer Alice continuity over manual context transfer using the verified Milestone 06 foundations.

Tasks:

- [ ] Recruit 5-10 eligible users who already switch between ChatGPT and Claude.
- [ ] Run the full round trip on sustained real projects.
- [ ] Measure restatement, review behavior, capture quality, switching friction, permission comprehension, and repeated use.
- [ ] Verify participant-facing privacy expectations against actual storage, sharing, provider transfer, removal, export, and deletion behavior.
- [ ] Record product findings and the next go/pivot/stop decision.

Success criteria:

- At least 8 of 10 participants complete the full loop.
- At least 70% of continuation tasks need no restatement of accepted decisions.
- At least 80% of saved proposals are confirmed as-is or need only minor editing.
- Provenance is available for every active assertion.
- There are zero silent accepted-state mutations, zero cross-workspace or restricted-context disclosures, and zero shared host credentials.
- Users voluntarily repeat the workflow in another session, context, or project.

Notes:

- Thresholds are provisional until recruitment begins; any change must be documented before observing results.
- Recruitment must not begin until Milestone 06 is complete and the participant disclosure accurately describes the verified deployment.

## Milestone 08 — Context Intelligence

Status: Not Started

Branch: `milestone-08-context-intelligence`

Objective:

Improve continuation quality by selecting less but more relevant trusted project context.

Tasks:

- [ ] Establish the full accepted-state package as the measured baseline.
- [ ] Add task-to-state relevance ranking.
- [ ] Separate core context from task-specific context.
- [ ] Prioritize relevant open questions and artifact references.
- [ ] Add explicit user feedback for missing, irrelevant, or outdated context.
- [ ] Compare smaller packages against the baseline.

Success criteria:

- Smaller packages match or outperform the baseline on continuation evaluations.
- Users report less irrelevant context without increased restatement.
- Selection remains explainable and provenance-preserving.

Notes:

- Embeddings are permitted only if deterministic retrieval is shown to be insufficient.

## Milestone 09 — Richer Project Intelligence

Status: Not Started

Branch: `milestone-09-project-intelligence`

Objective:

Test which additional governed project knowledge materially improves continuity and trust.

Tasks:

- [ ] Prioritize one intelligence extension using private-alpha evidence.
- [ ] Define a measurable continuation or trust outcome.
- [ ] Implement the smallest experiment.
- [ ] Compare it with the prior behavior.
- [ ] Keep or remove it based on evidence.

Success criteria:

- The selected extension measurably improves continuation, capture quality, or trust.
- It does not bypass evidence, review, provenance, conflict, or supersession rules.

Notes:

- Candidate extensions include decision timelines, contradiction maps, stale-assumption warnings, and richer artifacts. None is pre-approved.

## Milestone 10 — Provider Expansion

Status: Not Started

Branch: `milestone-10-provider-expansion`

Objective:

Generalize the proven project intelligence layer to additional official AI integrations without changing canonical project or collaboration semantics.

Tasks:

- [ ] Define provider capabilities independently of project state.
- [ ] Validate a third provider's official integration and security model.
- [ ] Add the provider without changing canonical project semantics.
- [ ] Verify the provider respects project/context selection, explicit save confirmation, per-user credentials, revocation, and collaboration permissions.

Success criteria:

- A third provider uses the same consumption and capture contracts where its capabilities permit.
- Provider-specific behavior remains isolated to the integration layer.
- The provider cannot bypass collaboration or context-visibility boundaries.

Notes:

- Read-only providers may consume context without supporting capture; capability differences must be explicit.
