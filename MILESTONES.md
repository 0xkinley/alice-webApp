# alice. Milestones

This file is the persistent implementation roadmap for alice. Milestones are evidence-gated: later work should not begin merely because earlier code exists.

## Frozen MVP scope

The first product test is the complete ChatGPT to alice. to Claude to alice. to ChatGPT round trip.

Approved defaults:

- The first cohort contains only users whose ChatGPT and Claude accounts support the required authenticated remote MCP read/write flow. Plan name alone is not the eligibility test; the actual account, region, surface, and applicable policy must expose the required capabilities.
- Each user receives one private workspace containing projects. Teams, roles, sharing, and organizations are deferred.
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

## Milestone 06 — Private Alpha

Status: Not Started

Branch: `milestone-06-private-alpha`

Objective:

Test whether real users repeatedly prefer Alice continuity over manual context transfer.

Tasks:

- [ ] Recruit 5-10 eligible users who already switch between ChatGPT and Claude.
- [ ] Add privacy-preserving product instrumentation.
- [ ] Add connection recovery and revocation paths.
- [ ] Run the full round trip on sustained real projects.
- [ ] Measure restatement, review behavior, capture quality, switching friction, and repeated use.
- [ ] Record product findings and the next go/pivot/stop decision.

Success criteria:

- At least 8 of 10 participants complete the full loop.
- At least 70% of continuation tasks need no restatement of accepted decisions.
- At least 80% of candidates are accepted or need only minor editing.
- Provenance is available for every trusted assertion.
- There are zero silent trusted-state mutations and zero cross-workspace disclosures.
- Users voluntarily repeat the workflow on another session or project.

Notes:

- Thresholds are provisional until recruitment begins; any change must be documented before observing results.

## Milestone 07 — Context Intelligence

Status: Not Started

Branch: `milestone-07-context-intelligence`

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

## Milestone 08 — Richer Project Intelligence

Status: Not Started

Branch: `milestone-08-project-intelligence`

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

## Milestone 09 — Provider and Collaboration Expansion

Status: Not Started

Branch: `milestone-09-platform-expansion`

Objective:

Generalize the proven project intelligence layer to additional official AI integrations and, separately, multi-user workspaces.

Tasks:

- [ ] Define provider capabilities independently of project state.
- [ ] Validate a third provider's official integration and security model.
- [ ] Add the provider without changing canonical project semantics.
- [ ] Validate demand for shared workspaces.
- [ ] Design collaboration permissions only after demand is established.

Success criteria:

- A third provider uses the same consumption and capture contracts where its capabilities permit.
- Provider-specific behavior remains isolated to the integration layer.
- Collaboration work begins only with evidence of demand.

Notes:

- Read-only providers may consume context without supporting capture; capability differences must be explicit.
