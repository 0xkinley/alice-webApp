# Host-Surface Compatibility and Private-Alpha Evaluations

Status: Local harness verified; live surface matrix initialized with no advertised surfaces

Decision date: 2026-09-01

## Purpose

alice. records compatibility per exact host surface. A result from one client never applies to another client, even when both clients belong to the same provider or use the same account. The machine-readable capability source of truth is `evals/host-surface-compatibility.json`; its linked invocation source is `evals/host-invocation-denominators.json`. This document explains how both are maintained and how their results may be used.

The matrix begins conservatively. All 70 capability cells across the ten required surfaces are explicitly `untested`, every surface is unadvertised, and every untested capability is treated as unsupported. The earlier generic hosted OAuth verifier proved alice.'s server-side PKCE, refresh rotation, revocation, and post-revocation HTTP 401 behavior, but it was not initiated by one of these exact provider surfaces and therefore does not promote any matrix cell.

The retained hosted MCP runtime reports server version `0.6.0`. The local branch reports `0.6.2` and contains the confirmed host-attachment transfer contract. No native or fallback attachment-transfer run may be recorded against `0.6.2` until that exact runtime and migration are separately built, scanned, deployed, and verified.

## Required surfaces and current status

| Provider | Exact surface | Current status | Advertised |
| --- | --- | --- | --- |
| Anthropic | Claude web | Not tested — unsupported | No |
| Anthropic | Claude Desktop | Not tested — unsupported | No |
| Anthropic | Claude iOS | Not tested — unsupported | No |
| Anthropic | Claude Android | Not tested — unsupported | No |
| Anthropic | Claude Code | Not tested — unsupported | No |
| OpenAI | ChatGPT web | Not tested — unsupported | No |
| OpenAI | ChatGPT desktop | Not tested — unsupported | No |
| OpenAI | Codex desktop | Not tested — unsupported | No |
| OpenAI | Codex CLI | Not tested — unsupported | No |
| OpenAI | Codex IDE extension | Not tested — unsupported | No |

ChatGPT mobile is outside the initial advertised set. It must not inherit ChatGPT web or desktop results.

Each exact surface has explicit entries for:

- OAuth connect, reconnect, refresh, revoke, and post-revocation denial;
- permitted project discovery and alice.-controlled active project/context selection;
- accepted-context retrieval without manual restatement;
- candidate save followed by exact authenticated human confirmation or cancellation;
- permission-filtered file references and native attachment transfer or the alice.-controlled fallback;
- permission denial with no restricted metadata or mutation; and
- cross-host reuse of only human-confirmed state.

The allowed cell statuses are `pass`, `fail`, `provider_blocked`, and `untested`. A surface may be advertised only when every capability cell is `pass` and its exact denominator record is `measurable`. `Fail`, `provider_blocked`, and `untested` remain unsupported and use the exact fallback recorded in the matrix.

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
- candidate-only save offers, one human confirmation, and cancellation;
- direct upload, native attachment transfer, alice.-controlled fallback, threat denial, and PDF extraction-to-candidate behavior;
- append-only removal, project/context sharing, connection revocation, concurrent exact-once behavior, and permission non-disclosure; and
- ChatGPT-to-Claude confirmed reuse, cancelled-value exclusion on return to ChatGPT, and cross-host use of a saved file strictly as untrusted data.

The scorer rejects host-performed human actions, activation without a prior exact human check, file references without confirmation and both clean gates, candidate creation without evidence-producing capture, successful reads after revocation, permission-denial metadata leakage, and cross-host accepted-state use before human confirmation. Every capability also names existing runtime test files; missing evidence paths fail the evaluation.

Run the bounded local gate with:

```sh
npm run eval:private-alpha
npm run eval:invocation
```

The scripts print only aggregate pass/fail evidence. They validate exactly ten surfaces, seven explicit capability cells per surface, live-run references for any non-untested result, the consented synthetic denominator formula and retention allowlist, and the rule that no incomplete or unmeasured surface is advertised. They perform no network request, provider login, database write, AWS action, model call, or paid operation.

This deterministic harness verifies the repository policy and its test coverage. It does not claim that any current provider client invokes alice. correctly. Live, dated surface runs remain required before the compatibility-matrix milestone task can close.
