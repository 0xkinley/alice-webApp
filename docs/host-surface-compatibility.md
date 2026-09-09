# Host-Surface Compatibility and Private-Alpha Evaluations

Status: Optional evidence registry ready; just-in-time participant-surface validation planned for Milestone 07; no advertised surfaces

Decision date: 2026-09-06

## Purpose

alice. records compatibility per exact host surface. A result from one client never applies to another client, even when both clients belong to the same provider or use the same account. The machine-readable evidence registry is `evals/host-surface-compatibility.json`; its linked invocation source is `evals/host-invocation-denominators.json`. This document explains how both are maintained and how their results may be used. Completing the full registry is not a Milestone 06 requirement.

The registry is intentionally limited to the two participant products: Claude and ChatGPT. All 49 capability cells across its seven enumerated surfaces are explicitly `untested`, every surface is unadvertised, and every untested capability is treated as unsupported. Milestone 07 needs to validate only an exact surface that will actually be used by a participant; it does not need to complete unrelated rows. Codex is outside the private-alpha product scope; internal use of alice. from Codex is development evidence only and cannot be advertised or inherited by a ChatGPT result. The earlier generic hosted OAuth verifier proved alice.'s server-side PKCE, refresh rotation, revocation, and post-revocation HTTP 401 behavior, but it was not initiated by one of these exact provider surfaces and therefore does not promote any matrix cell.

The retained hosted MCP runtime reports server version `0.6.2`. Hosted source commit `43febda` is deployed as immutable ECR digest `sha256:f03b9d1276b25415d59e528b15cf23c851265978c570181c9c6dbd35a00b7b60`; its automatic scan returned no findings, and the earlier private task verified all 18 migrations before runtime restoration. Native or fallback attachment-transfer results for the previously deployed allowlist may now be recorded against that exact identity, but only through a dated run on the exact surface. The local branch reports MCP `0.8.0`, includes migrations 019–021 for the expanded format allowlist, retained provider-authorization records, and short-lived single-action Save previews. Its newer source-only contract exposes the same permission-filtered project catalog to connected ChatGPT and Claude clients, stores no private-alpha active target, and requires an exact project for every save or file action. Those changes have no hosted deployment evidence yet. Deployment eligibility does not promote any capability cell by itself.

## Enumerated surfaces and current status

| Provider | Exact surface | Current status | Advertised |
| --- | --- | --- | --- |
| Anthropic | Claude web | Not tested — unsupported | No |
| Anthropic | Claude Desktop | Not tested — unsupported | No |
| Anthropic | Claude iOS | Not tested — unsupported | No |
| Anthropic | Claude Android | Not tested — unsupported | No |
| Anthropic | Claude Code | Not tested — unsupported | No |
| OpenAI | ChatGPT web | Not tested — unsupported | No |
| OpenAI | ChatGPT desktop | Not tested — unsupported | No |

ChatGPT mobile is outside the initial advertised set. It must not inherit ChatGPT web or desktop results.

Each exact surface has explicit entries for:

- OAuth connect, reconnect, refresh, revoke, and post-revocation denial;
- permitted project discovery and alice.-controlled active project/context selection;
- accepted-context retrieval without manual restatement;
- an exact short-lived preview followed by one authenticated human Save, with no candidate, Needs attention item, activation, or file reference when the user takes no action;
- permission-filtered file references and native attachment transfer or the alice.-controlled fallback;
- permission denial with no restricted metadata or mutation; and
- cross-host reuse of only human-confirmed state.

The allowed cell statuses are `pass`, `fail`, `provider_blocked`, and `untested`. A surface may be advertised only for capabilities with current `pass` evidence and the required measurable denominator. `Fail`, `provider_blocked`, and `untested` remain unsupported and use the exact fallback recorded in the registry. An untested surface does not block Milestone 06 or an independently verified surface.

Registry contract `alice.host-surface-compatibility.v2` and the deterministic harness describe the local single-action Save flow. Local MCP `0.8.0` contains the portable workspace and Save apps plus migrations `020` and `021`; the version change does not promote any live provider capability cell. Every exact surface remains untested, unsupported, and unadvertised until its own dated live run.

## Recording a live run

Never overwrite a prior live run. Append a new run record, increment the matrix version, and point only the capabilities exercised by that run to its identifier. A qualifying record contains:

- exact surface identifier and run date;
- provider/client version, account type, and account region;
- transport and authorization scopes;
- exact deployed repository commit or immutable image identity;
- content-free observed outcomes for each exercised capability;
- one consented synthetic invocation cohort for this exact surface, or a durable `provider_blocked` denominator record; and
- a durable repository evidence location containing no password, authorization code, access token, refresh token, client secret, signed upload URL, file bytes, prompt content, or project content.

Run each surface independently. Reconnection and revocation use a disposable connection. Permission denial uses a fixture the test identity cannot access and records only response class, safe counts, and no-mutation evidence. File transfer uses a synthetic non-sensitive fixture, verifies both staging and final scan-clean gates, and removes any temporary local copy after evidence is recorded. Stop at the first unexplained failure; record it as `fail` until diagnosed rather than retrying blindly.

For the invocation cohort, declare every eligible trial before its host turn and finish it as exactly `successful_read`, `failed_read`, or `no_call`. Count both successful and failed received reads in the numerator and every declared trial in the denominator. Never infer ordinary missing turns, retain conversation content, or inherit another surface's result. Full definitions are in `docs/product-signals.md`.

## Deterministic capability harness

`evals/private-alpha-capabilities.json` defines 27 disclosed traces across ChatGPT, Claude, provider-neutral, and cross-host behavior. Twenty-two compliant traces and five intentionally unsafe traces cover:

- project/context selection and read-only active-context or exact-file retrieval;
- preview-only save offers, one human Save, and dismissal/expiry with no project write;
- direct upload, native attachment transfer, alice.-controlled fallback, threat denial, and PDF extraction-to-candidate behavior;
- append-only removal, project/context sharing, connection revocation, concurrent exact-once behavior, and permission non-disclosure; and
- ChatGPT-to-Claude confirmed reuse, ignored-preview exclusion on return to ChatGPT, and cross-host use of a saved file strictly as untrusted data.

The scorer rejects host-performed human actions, activation without a prior exact human Save, file references without Save and both clean gates, candidate creation without an evidence-producing Save or explicit file suggestion, successful reads after revocation, permission-denial metadata leakage, and cross-host accepted-state use before human Save. Every capability also names existing runtime test files; missing evidence paths fail the evaluation.

Run the bounded local gate with:

```sh
npm run eval:private-alpha
npm run eval:invocation
```

The scripts print only aggregate pass/fail evidence. They validate exactly seven private-alpha surfaces, seven explicit capability cells per surface, live-run references for any non-untested result, the consented synthetic denominator formula and retention allowlist, and the rule that no incomplete or unmeasured surface is advertised. They perform no network request, provider login, database write, AWS action, model call, or paid operation.

This deterministic harness verifies the repository policy and its test coverage. It does not claim that any current provider client invokes alice. correctly. A live, dated run remains required before an exact surface or capability can be used with a participant or advertised, but completion of the exhaustive registry is not a Milestone 06 gate.
