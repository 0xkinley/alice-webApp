# Milestone 01 Round-Trip Fixture

## Purpose

This fixture tests project continuity, not merely MCP connectivity. A run passes only when the two hosts retrieve, use, capture, review, and re-retrieve governed project decisions without the tester manually restating saved decisions.

## Eligibility

The tester must use the target ChatGPT and Claude accounts through their official remote MCP integration flows. The accounts must support authenticated reads and explicit write actions. First-time connection setup is recorded but excluded from the recurring-workflow comparison.

## Canonical project

- Project name: `Switchboard Launch`
- Project brief: Define the launch position and first onboarding experiment for alice., the independent project intelligence layer for people who use more than one AI on the same project.

## Canonical decisions

The first host must submit A-C exactly as separate candidate claims:

| ID | State key | Accepted value |
| --- | --- | --- |
| A | `launch.icp` | Independent product consultants and fractional product leads who actively use both ChatGPT and Claude on the same client project. |
| B | `launch.product_form` | A web control plane plus an authenticated remote MCP server; alice. is not a chatbot and does not route work between models. |
| C | `launch.monthly_price_usd` | 24 |

Claude must propose and explicitly save D after retrieving A-C:

| ID | State key | Required decision shape |
| --- | --- | --- |
| D | `launch.onboarding_success` | A single measurable activation criterion that requires both AI accounts. |

The initial fixture precommitted a 10-minute, successful-retrieval value for D,
but the continuation prompt disclosed only that the criterion must be measurable
and require both accounts; A-C contained neither the hidden event definition nor
the time window. Requiring Claude to guess those details tested model preference
rather than project continuity. On 2026-08-27, after observing the mismatch, the
human reviewer corrected the rubric: D passes when it matches the disclosed
required shape and the reviewer explicitly accepts it. The accepted value is
authoritative even when a host would recommend a different event or time window.

The human-accepted D for this run is:

> A user is activated when alice. has ingested at least one project-relevant event from each connected AI account (ChatGPT and Claude) within the same project, within 7 days of signup.

This correction is recorded after the affected runs rather than presented as
their original scoring rule. It does not change the exact Claude prompt or erase
the failed-run evidence.

## Round-trip procedure

### Leg 1 — ChatGPT to alice.

1. In a new ChatGPT conversation, enable the alice. MCP app.
2. Ask ChatGPT to list projects and retrieve the `Switchboard Launch` context.
3. State A-C in the conversation and explicitly ask: `Save decisions A-C to alice. as three separate candidate claims.`
4. Record the tool result identifiers and confirm trusted state is unchanged.
5. In the alice. review control plane, accept A-C one by one.
6. Confirm each accepted state record references its candidate and immutable evidence event.

### Leg 2 — alice. to Claude to alice.

1. Start a new Claude conversation with the alice. connector enabled.
2. Provide only this task prompt; do not restate A-C:

   > Retrieve the accepted Switchboard Launch context from alice. Using the saved ICP, product form, and monthly price, draft a three-bullet onboarding plan. Then propose one measurable activation decision that requires both AI accounts and explicitly save it to alice. as `launch.onboarding_success`.

3. Score whether Claude used A-C correctly before inspecting or accepting D.
4. Confirm D is pending and trusted state is unchanged.
5. Accept D in the alice. review control plane.

### Leg 3 — alice. back to ChatGPT

1. Start another new ChatGPT conversation with the alice. app enabled.
2. Provide only this task prompt; do not restate A-D:

   > Retrieve the accepted Switchboard Launch context from alice. Write a compact launch card with: target customer, product form, monthly price, and activation criterion. End with one sentence explaining why the activation criterion fits this product.

3. Score whether ChatGPT used A-D correctly.

## Correctness rubric

Each item is binary and must pass:

- Claude identifies the ICP as independent product consultants/fractional product leads who use both ChatGPT and Claude on one client project.
- Claude treats alice. as a web control plane plus remote MCP server, not as a chatbot or model router.
- Claude uses a monthly price of exactly USD 24.
- Claude's saved D has the documented required decision shape, is stored under `launch.onboarding_success`, and is explicitly accepted by the human reviewer.
- Returning ChatGPT correctly states A, B, C, and the accepted D.
- Neither host presents a pending candidate as trusted context.
- Every presented decision includes or can be resolved to accepted-state, candidate, and evidence identifiers.

Any missing item fails the round trip. A retry is a new run and must be recorded as such.

## Manual copy/paste baseline

Run the same two continuation prompts in fresh host conversations with MCP disabled. Before each switch, manually assemble and paste the smallest packet that allows the next host to answer correctly. Include A-C for the Claude leg and A-D for the returning ChatGPT leg.

For both the MCP and manual runs, record:

- recurring operator actions after initial connector setup;
- elapsed time from starting the switch until the destination host has the required context;
- number of saved decisions manually restated or pasted;
- rubric score;
- provenance available at the destination;
- tester preference and a one-sentence reason.

The ease criterion passes only if the tester prefers the recurring alice. workflow after excluding first-time connection setup. Equal preference or a preference based only on richer output does not pass.

## Evidence record

Use `docs/spike/results.md` for timestamps, host/account eligibility, request and response identifiers, rubric scores, timings, limitations, and the final recommendation. Do not store access tokens, passwords, or unsaved conversation history.
