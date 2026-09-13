# Private Alpha Product Signals

Status: Implemented for observable signals and controlled per-surface denominator policy

Decision dates: 2026-08-30 (signals); 2026-09-01 (denominator policy); 2026-09-07 (single-action Save observability)

## Purpose and boundary

The authenticated `Alpha signals` view helps evaluate whether alice. reduces continuity and confirmation friction without reading project content. It derives aggregates from existing tenant-bound connection metadata, immutable context-read receipts, candidate statuses, and content-free decision/repair audits. It does not add session replay or analytics-provider transmission.

The aggregation queries do not select prompts, task text, model responses, evidence payloads, candidate values or summaries, accepted values, context names/descriptions, emails, tokens, or credentials. The response contains counts, percentages, durations, booleans, and the documented observability limitation only. Each user sees aggregates for their own integration connections and captures; collaborator content and identities are not returned.

## Defined signals

- **Observed read attempts:** successful plus failed MCP context-package calls actually received by alice.
- **Read success among observed attempts:** successful package receipts divided by all received attempts. This is not called host invocation rate.
- **Cross-host reuse:** a project with successful reads from two different safe client classifications no more than seven days apart. Project identifiers are used only for grouping and are not returned.
- **Repeated weekly use:** successful reads in at least two distinct UTC weeks.
- **Retained capture outcomes:** exact evidence captures whose candidates are accepted, historically rejected, or still pending. Routine single-action saves enter this population only after Save; ignored and expired previews create no durable evidence or analytics event and are not counted as offers.
- **Retained review burden:** entries per retained capture and median elapsed seconds from evidence creation to a historical aggregate accept/reject audit. A routine atomic Save normally has a zero-second interval because evidence and acceptance share the authenticated Save transaction.
- **Repairs:** append-only removal audits carrying only the bounded `stale`, `contradicted`, or `wrong` classification. The optional human explanation is excluded from audit metadata and aggregation.

## Host invocation denominator

alice. cannot observe an ordinary conversation turn where an AI host never invokes its MCP tool. Ordinary private-alpha traffic therefore has no valid host-turn denominator, and the product must not infer skipped calls from missing receipts or call the success-among-observed-attempts figure an invocation rate.

The implemented denominator contract is limited to a controlled compatibility cohort on one exact host surface:

1. A user explicitly consents to and starts a synthetic trial before the host turn. The trial uses a non-sensitive fixture and an isolated test connection.
2. Every started eligible trial receives exactly one durable outcome: `successful_read`, `failed_read`, or `no_call`. A failed read means alice. received a call that failed; `no_call` means the declared trial ended without alice. receiving a read attempt.
3. The numerator is eligible trials with any received read attempt: `successful_read + failed_read`. The denominator is all explicitly started eligible trials, including `no_call`.
4. Results belong only to the exact surface, provider/client version, account type, region, deployment commit, and dated run. No web, desktop, mobile, CLI, or IDE result may be inherited by another surface.
5. Retained trial data is limited to opaque trial ID, exact surface/run metadata, outcome class, aggregate counts, and the calculated percentage. Prompts, model responses, conversation or project content, file bytes, credentials, authorization codes, and access or refresh tokens are prohibited.

The machine-readable contract is `evals/host-invocation-denominators.json`. `npm run eval:invocation` validates the formula, explicit outcomes, content-free allowlist, exact-surface registry, and compatibility-matrix gate. A surface cannot be advertised until it has its own dated `measurable` denominator record. A `provider_blocked` or `untested` surface remains unsupported.

This contract makes future controlled compatibility rates defensible; it does not create or claim a population-wide rate for ordinary private-alpha use. The current registry has no live denominator run, so all seven exact Claude and ChatGPT surfaces remain untested and no current invocation percentage is published. Codex is outside the private-alpha denominator and participant product scope.

## Single-action Save denominator

Routine preview state is intentionally short-lived and contains the exact user-visible payload. Closing, ignoring, or expiry must not create a durable candidate, Needs attention item, accepted state, file reference, or content-bearing analytics record. For that reason the current alpha does not retain an ordinary-user denominator for Save cards presented, dismissed, or expired, and it must not relabel completed saves as all offers received. A future completion-rate study must use a separately consented, synthetic, content-free cohort declared before presentation, analogous to the host invocation denominator, rather than weakening the no-action deletion boundary.
