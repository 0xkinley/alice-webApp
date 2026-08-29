# Cross-Host Context Evaluations

Status: Verified for Milestone 05

Decision date: 2026-08-30

## Purpose

The versioned fixture at `evals/cross-host-context.json` turns the canonical `Switchboard Launch` round trip from `docs/spike/round-trip-fixture.md` into a deterministic consumption regression gate. `npm run eval:context` seeds the production-shaped tenant database, immutable evidence, candidate claims, and accepted-state provenance separately for the Claude A-C leg and returning ChatGPT A-D leg, then invokes the production `getProjectContext` assembler.

Each continuation prompt is the disclosed canonical task and contains zero manually restated decision values. The scorer requires project discovery followed by context retrieval, exact use of every required accepted value in the recorded host response, complete accepted-state/candidate/evidence provenance, deterministic repeated assembly, zero canonical omissions, compliance with the declared UTF-8 budget, and exclusion of the two retained pending D values.

The returning ChatGPT case intentionally retains the two failed-run pending D candidates. The package may report their identifiers as unresolved alternatives to accepted D, but their values must not appear anywhere in context.

## Coverage

- Claude continuation: retrieves and uses canonical A-C, then selects the existing explicit candidate-save tool for D.
- ChatGPT return: retrieves and uses canonical A-D in the launch card.
- Both prompts record `manually_restated_decision_ids: []`.
- Both cases assemble from authenticated accepted state through the same domain path used by MCP.
- Every accepted item resolves to accepted-state, candidate, evidence, evidence hash, and capture timestamp.
- Pending candidate values are excluded even when an unresolved-conflict notice is relevant.

## Interpretation and limits

This is an offline, deterministic repository evaluation of context assembly and disclosed host traces. It does not call a model, add model orchestration, or claim a fresh live-host invocation rate. The successful live ChatGPT and Claude round trip remains dated evidence in `docs/spike/results.md`; provider behavior must still be revalidated before cohort expansion.

The runtime trust boundary does not depend on a trace response being correct. MCP writes remain candidate-only, and only explicit authenticated human review can change trusted state.
