# Milestone 01 Spike Results

Status: In progress

## Test environment

- Date: 2026-08-26
- Runtime: Node.js 24.0.2 on macOS arm64
- MCP SDK: `@modelcontextprotocol/server` 2.0.0
- Transport: Streamable HTTP with legacy 2025 protocol compatibility
- Public transport during the recorded probe: temporary Cloudflare Quick Tunnel
- Persistent application store: local SQLite; runtime database excluded from Git

Secrets, bearer tokens, passphrases, and unsaved conversation content are intentionally absent from this record.

## Endpoint evidence

Recorded at 2026-08-26 22:23 Asia/Dubai:

- A probe from outside the local listener returned `200` from `/health` over public HTTPS.
- The path-aware RFC 9728 resource document returned the public `/mcp` resource, the co-located authorization server, and separate `mcp:read` and `mcp:write` scopes.
- An unauthenticated public `initialize` request returned `401` and a `WWW-Authenticate` challenge containing the protected-resource metadata URL.
- Automated integration coverage completed dynamic client registration, authorization-code + S256 PKCE, access and refresh token issuance, authenticated MCP initialization, access-token revocation, and rejection of the revoked token.
- The public hostname was an ephemeral `trycloudflare.com` address and is not a production deployment. Its URL is omitted because it is invalid after the recorded tunnel stops.

Verification command: `npm test`

Result: 3 tests passed, 0 failed.

## Round-trip runs

### ChatGPT capture leg

Recorded at 2026-08-27 Asia/Dubai from the target personal ChatGPT Plus account:

- Developer mode was enabled deliberately after reviewing its elevated-risk warning.
- A read-only OAuth authorization requested only `mcp:read`. `list_projects` and `get_project_context` succeeded, while `save_project_update` was rejected because the token lacked `mcp:write`. No evidence, candidates, or trusted state were created.
- The connection was recreated with `mcp:read` and `mcp:write`. The first run failed before any write because ChatGPT had not yet received the updated action schema; per the fixture protocol, this was recorded as a failed run rather than silently retried.
- The MCP tool descriptors were updated to advertise per-tool OAuth scopes through the ChatGPT-compatible `_meta.securitySchemes` field. ChatGPT then exposed `list_projects` and `get_project_context` as read actions and `save_project_update` as a write action.
- In a fresh run, ChatGPT listed the project, retrieved empty trusted context, submitted the exact A-C values as three separate candidate claims in one explicit write, and retrieved trusted context again.
- ChatGPT required an explicit write confirmation before invoking `save_project_update`.
- The write created immutable evidence `evidence_3966ba5e-2ae6-4430-8c2f-c963ff265191` and pending candidates `candidate_888018c8-f572-4e1e-9a37-728f2ada95b2`, `candidate_51d36acd-7bf6-4abd-a696-c61bdd1acb17`, and `candidate_b8a32582-659f-46af-a432-5ed01619cdf2`.
- The write response reported `trusted_state_changed: false`. The post-write trusted-context response still contained no accepted decisions, open questions, or artifacts, and direct database verification found zero accepted-state rows.
- The separate authenticated alice. review page displayed only the three canonical pending candidates. The human reviewer accepted each exact value individually.
- Database verification found all three candidates accepted as version-1 trusted state: `accepted_0db05e04-77e9-45dc-ae4d-009651a52f22` for A, `accepted_f60e46fb-28cd-4493-88ed-c2da0692dbf5` for B, and `accepted_25dd65b8-7f16-4ab2-af28-30d5a704e915` for C. Every row retains the original candidate and evidence identifiers.

This verifies authenticated ChatGPT reads, explicit candidate capture, fail-closed trusted state, and human-governed acceptance of A-C. It does not by itself satisfy the complete round-trip success criteria.

### Claude continuation run 1

Recorded at 2026-08-27 Asia/Dubai from the target personal Claude Pro account:

- Claude added the public alice. endpoint as a custom remote MCP connector. Its initial OAuth request asked for `mcp:read offline_access`; the issued access token contained only `mcp:read`.
- In a new conversation, the tester supplied only the fixture's continuation prompt. A-C were not restated, and other data connectors were disabled.
- Claude listed alice. projects and retrieved the accepted Switchboard Launch context after separate explicit confirmations for both read actions.
- Claude correctly used all three accepted decisions: the dual-ChatGPT/Claude consultant ICP, the web control-plane plus MCP product form with no chatbot or routing role, and the exact USD 24 monthly price.
- Claude proposed a measurable two-account activation decision, but it used a seven-day cross-host write/read criterion. This is not semantically equivalent to the precommitted requirement that both hosts retrieve accepted context within 10 minutes, so rubric item D failed.
- After an explicit confirmation, Claude attempted `save_project_update`. alice. rejected it because the token lacked `mcp:write`. Claude reported the scope failure, and database verification found no new evidence or candidate.

Run 1 therefore proves Claude's authenticated read and correct use of A-C without restatement, but fails the complete Claude leg. A retry must be recorded as a new run.

Before a new run, the dynamic client-registration response was corrected to return the bounded RFC 7591 default `scope` metadata (`mcp:read mcp:write offline_access`). A reconnect probe showed Claude still derived `mcp:read offline_access` from the resource challenge, so the unauthenticated challenge was corrected to advertise the `mcp:read mcp:write` union. The authorization page now describes only the scopes actually requested. Integration coverage verifies these behaviors and confirms that read-only tokens still fail closed at the write tool.

### Claude continuation run 2

Recorded at 2026-08-27 Asia/Dubai:

- Claude continued to reuse the old read-only discovery result after disconnecting and reconnecting the same endpoint. A fresh temporary tunnel hostname forced clean discovery of the corrected challenge.
- The fresh OAuth request asked for `mcp:read mcp:write offline_access`, and direct database verification confirmed the issued access token contains both MCP scopes.
- In a new conversation with only alice. enabled, the exact fixture prompt was supplied without A-C. Claude again retrieved and correctly used all three accepted decisions.
- Claude proposed a two-account criterion requiring a context retrieval from both ChatGPT and Claude, but set a seven-day window and added a three-accepted-claim condition. The seven-day window is not semantically equivalent to the precommitted 10-minute criterion, so D correctness failed.
- After explicit confirmation, Claude successfully created pending candidate `candidate_04f4e885-1d16-4743-89b7-68a6bbf24216` from immutable evidence `evidence_13fd610e-0b73-480f-bc6f-666f87b020fd`.
- Database verification found zero accepted `launch.onboarding_success` rows. The incorrect candidate remains pending and must not be approved.

Run 2 proves authenticated Claude read and write compatibility and preserves fail-closed trusted state, but it fails the D rubric. A further attempt must be a fresh recorded run.

### Claude continuation run 3

Recorded at 2026-08-27 Asia/Dubai:

- A third new conversation used the unchanged fixture prompt with no hint about the hidden canonical value. Claude again retrieved and correctly used A-C.
- Claude again chose a seven-day activation window, this time requiring both authenticated connections and cross-assistant retrieval of an accepted state key. This is still not semantically equivalent to the precommitted 10-minute criterion.
- Claude saved pending candidate `candidate_72928e14-0300-44c4-887b-5368f0e0d969` from immutable evidence `evidence_10308f3e-6afd-426f-b4dc-ba1a013a240d`. Database verification found zero accepted D rows.
- After Run 2's `Allow once`, Run 3's write completed without a new actionable confirmation remaining in the controlled page state. The conversation prompt itself explicitly requested the save, and trusted state still required independent alice. review.

Run 3 fails D correctness. Both non-equivalent D candidates remain pending and must not be approved.

### Claude continuation run 4 and rubric correction

Recorded at 2026-08-27 Asia/Dubai:

- A fourth new conversation used the unchanged fixture prompt, with only alice. enabled, on Claude Sonnet 5 at Medium reasoning. Claude retrieved and correctly used A-C without restatement.
- Claude proposed: “A user is activated when alice. has ingested at least one project-relevant event from each connected AI account (ChatGPT and Claude) within the same project, within 7 days of signup.”
- Claude saved pending candidate `candidate_246a292a-acce-4a58-a508-0ef21726c0ce` from immutable evidence `evidence_0534d3ff-8236-40a0-9b59-d045cac20186`.
- The run exposed a fixture defect: the hidden precommitted 10-minute window was absent from both A-C and the unchanged Claude prompt. Scoring an open-ended proposal against that undisclosed value tested whether Claude guessed the fixture author's preference, not whether alice. preserved project context.
- The human reviewer corrected the rubric to require D's disclosed structural shape rather than the hidden exact time window, then explicitly accepted Run 4's exact proposal through the alice. review control plane.
- Accepted state `accepted_0d911feb-9e2c-4d85-b2fa-95a7e5cc6a9f` is version 1 of `launch.onboarding_success` and retains candidate and evidence provenance. The two earlier seven-day alternatives remain pending.

This completes the governed Claude capture task under the corrected rubric. The correction and its timing are preserved in the fixture; the earlier run records are not rewritten.

## ChatGPT Plus eligibility investigation

Recorded at 2026-08-26 Asia/Dubai:

- The signed-in target is a personal ChatGPT Plus account.
- The account can open the Plugins Directory and use installed plugins with external actions.
- `Settings > Security and login` exposes a `Developer mode` switch with an elevated-risk warning for unverified connectors.
- Developer mode was off. In that state, the Plugins Directory did not expose the plus control documented for adding an MCP server.
- No setting was changed and no MCP connection was created during this read-only investigation.

Root-cause finding: the failed setup attempt does not establish a Business-plan requirement. The target Plus account exposes the documented prerequisite, but it must be deliberately enabled before the native ChatGPT MCP read/write test can continue.

The supported transport comparison and fallback decision are recorded in `docs/provider-adapters.md`. Milestone 01 remains the native MCP round-trip because the actual target Plus account has the required Developer mode gate. Explicit handoff remains the baseline and fallback; a browser companion remains out of scope unless native availability or measured friction fails.

Repository verification after recording this decision: `npm run check` — 15 tests passed, 0 failed.

## Manual copy/paste baseline

Not run yet.

## Go/no-go recommendation

Pending the complete two-switch round trip and recurring-workflow comparison. MCP connectivity is not treated as success.
