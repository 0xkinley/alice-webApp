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

Status: In Progress

Branch: `milestone-02-repository-scaffold`

Objective:

Turn the successful spike into a small, maintainable TypeScript repository with repeatable local and CI verification.

Tasks:

- [x] Establish the workspace layout for web, MCP, shared schemas, domain logic, and database access.
- [ ] Add formatting, linting, typechecking, unit tests, and production builds.
- [ ] Add environment validation and secret-leak checks.
- [ ] Add CI that runs all required checks from a clean checkout.
- [ ] Document local setup and deployment boundaries.

Success criteria:

- A clean checkout installs, typechecks, tests, and builds both deployables.
- Secrets and provider configuration remain server-side.
- Spike behavior is preserved or explicitly documented as deferred to later milestones.

Notes:

- Avoid orchestration or infrastructure that two small deployables do not yet require.
- The npm workspace now separates `apps/web`, `apps/mcp`, `packages/schemas`, `packages/domain`, and `packages/database`. The Milestone 01 review authority remains server-side in the web deployable; MCP capture remains candidate-only.

## Milestone 03 — Authentication and Data Foundation

Status: Not Started

Branch: `milestone-03-auth-and-database`

Objective:

Implement production-shaped user authentication, one private workspace per user, projects, tenant isolation, evidence, candidate claims, accepted state, integration connections, and audit history.

Tasks:

- [ ] Implement user authentication and automatic private-workspace creation.
- [ ] Implement projects inside the user's private workspace.
- [ ] Add immutable evidence events and append-only audit events.
- [ ] Add candidate claims and versioned accepted project state.
- [ ] Add integration connection records without storing host passwords or bearer tokens.
- [ ] Add deny-by-default tenant authorization policies.
- [ ] Add cross-tenant negative tests for every project data path.

Success criteria:

- A user can create and revisit private projects.
- Evidence remains immutable through normal application roles.
- Two users cannot read or mutate each other's workspace or project data, including with guessed identifiers.
- Accepted state remains traceable to candidate claims and evidence.

Notes:

- Do not add team or sharing UI.

## Milestone 04 — Capture Loop

Status: Not Started

Branch: `milestone-04-capture-loop`

Objective:

Productionize explicit capture from supported AI hosts into immutable evidence, candidate claims, review, and trusted state.

Tasks:

- [ ] Finalize the `save_project_update` contract and validation limits.
- [ ] Make evidence, candidates, provenance, and audit creation transactional and idempotent.
- [ ] Build the candidate review queue.
- [ ] Implement accept and reject actions.
- [ ] Implement explicit supersession without overwriting history.
- [ ] Add capture evaluations for correct and incorrect tool selection.

Success criteria:

- Ordinary AI work does not change alice. state.
- Explicit saves create evidence and candidates exactly once.
- Only a human review action can change trusted state.
- Rejection and supersession preserve complete provenance.

Notes:

- Host-generated does not mean alice.-verified.

## Milestone 05 — Consumption Loop

Status: Not Started

Branch: `milestone-05-consumption-loop`

Objective:

Deliver compact, trustworthy, task-specific project context to ChatGPT and Claude.

Tasks:

- [ ] Finalize `list_projects` and `get_project_context` contracts.
- [ ] Build deterministic context packages from accepted state.
- [ ] Include relevant open questions, artifact references, and unresolved conflicts when available.
- [ ] Add package version, freshness, provenance references, budget, and omission reporting.
- [ ] Add cross-host context evaluations using the canonical fixture.

Success criteria:

- Context contains accepted state rather than unreviewed candidates by default.
- Every assertion is traceable.
- Both target hosts correctly use the required project decisions without manual restatement.
- The package stays within its declared budget and discloses omissions.

Notes:

- Begin with deterministic full-text and structured selection. Do not add embeddings in this milestone.

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
