# Provider Project Acquisition Capability Test

Status: Required product gate; not yet run

## Decision

Alice will not add another project-migration implementation phase or expose the current controlled bootstrap/import as complete migration until this test is run on the actual target ChatGPT and Claude surfaces.

The test answers one question with observed evidence:

> What project information can ChatGPT or Claude, together with the tested host environment and model, make available to the model and marshal into an MCP tool call today?

The probe does not observe a raw provider project API. MCP calls are model-controlled and their arguments conform to the advertised tool schema. Model self-report is not evidence. Official documentation informs expectations, but only the exact arguments delivered to the controlled test tool establish observed capability. Results are dated and scoped to the tested provider, account type, region, client/surface, project state, host version, model when visible, exact prompt, and diagnostic contract.

The provider-backup-expiry reconciliation is independent of this gate and may proceed when its dated window becomes eligible.

## Terms

- **Ambient host context**: information the host has already placed in the model's current context without an active retrieval operation.
- **Host retrieval**: information the model or host can actively request from the current provider project and then supply to Alice.
- **User-mediated acquisition**: information available only after the user explicitly attaches, selects, pastes, downloads, or exports it.
- **Unavailable**: information that cannot be delivered through the tested supported path.
- **Complete**: every expected fixture item, byte, field, order, and relationship in the tested category is observed.
- **Reliable**: the same capability and completeness result repeats across the required independent trials. A one-off success is not a supported migration dependency.
- **Exact bytes**: Alice receives the original file bytes and verifies their hash. A filename, reference, model summary, extracted text, or regenerated file is not exact bytes.

## Safety and non-goals

- Use synthetic projects and non-sensitive fixture content only.
- Use official host and MCP surfaces; do not scrape, collect cookies/passwords, extract hidden provider tokens, or use undocumented provider APIs.
- The diagnostic path must not create Alice project, migration, artifact, file, candidate, accepted, or trusted state and must not mutate the source provider project. It may write only isolated short-lived diagnostic session and evidence records.
- Do not click the production `Migrate` action merely to measure host acquisition.
- Store raw diagnostic payloads only in the approved test environment, redact bearer/authority tokens from evidence, and remove temporary data according to the test runbook.
- This test measures acquisition and preservation. It does not ask a model to semantically reconcile decisions or judge project truth.
- Do not build an export parser as part of this test. Record export availability and contents only if the user-mediated leg requires evaluation.

## Test matrix identity

Record one row set for every tested combination:

| Field | Required value |
| --- | --- |
| Test date/time | UTC timestamp |
| Provider | ChatGPT or Claude |
| Account/plan | Exact tested account capability, without credentials |
| Region | Actual account/surface region when known |
| Surface | Web, desktop, mobile, or another exact client |
| Host/app version | Exact visible version or `not exposed` |
| Model/version | Exact visible model/version or `not exposed` |
| Alice MCP version | Exact deployed diagnostic contract |
| Entry position | New project conversation or existing conversation |
| Trial | Independent trial number |
| Exact prompt | Exact text and SHA-256 used for the repeated trial |

Do not inherit a passing result from one surface, account, region, or provider to another.

## Synthetic source fixture

Create equivalent isolated projects in ChatGPT and Claude. Preserve a machine-readable manifest containing expected identifiers, markers, hashes, counts, order, and relationships.

Minimum fixture:

```text
1 project
1 project instruction
5 conversations
43 messages distributed across those conversations
4 uploaded files
1 generated artifact
6 significant decisions
3 open questions
1 deliberately superseded decision
1 identified current working artifact
```

Place a unique, non-secret marker in every retrievable unit. Example shapes:

```text
ALICE_TEST_INSTRUCTION_7391
ALICE_CHAT_ONE_4382
ALICE_MESSAGE_17_6043
ALICE_DECISION_CURRENT_6624
ALICE_OPEN_QUESTION_8821
ALICE_FILE_PDF_2716
ALICE_ARTIFACT_CURRENT_5194
```

Markers must be generated for the real run and recorded in the manifest. They provide deterministic coverage; resemblance or a plausible model paraphrase does not count as exact recovery.

Add plausible negative controls that do not occur in any provider-visible project source. A returned negative marker is a false-marker result and must be reported even when positive-marker recall is high.

Include a reusable temporal conflict:

```text
Earlier conversation: Pricing will be $24/month.
Later conversation:   Pricing changed to $10/month.
```

Acquisition scoring asks only whether both source statements, their order, and their provenance arrive. Determining that `$10` is current belongs to the later interpretation and continuation benchmark.

## File fixture

Include at least:

| Type | What to measure |
| --- | --- |
| TXT | Existence, name, metadata, full text, exact bytes, hash |
| PDF | Existence, name, metadata, extracted text, exact bytes, hash |
| CSV | Existence, name, metadata, rows/schema, exact bytes, hash |
| Image | Existence, name, metadata, dimensions, visual/derived description, exact bytes, hash |
| DOCX when supported | Existence, name, metadata, extracted structure/text, exact bytes, hash |

Record these separately for every file:

```text
existence known
filename supplied
provider/source identifier supplied
size supplied
MIME type supplied
timestamps supplied
parsed or summarized content supplied
original bytes supplied
SHA-256 matches fixture
project/conversation relationship preserved
```

## Acquisition legs

Run each important leg at least three independent times. Start a fresh eligible conversation or session when necessary so a prior trial does not contaminate ambient context.

Use the identical saved prompt for all three repetitions of a leg. Do not improve or expand the prompt after seeing an incomplete first result; prompt revisions require a newly versioned test row set.

### A. Ambient host context

From the defined entry position, ask the host to send only information already available in its current context to the controlled Alice capability tool. Do not ask it to search, retrieve, reopen, attach, or reconstruct other material.

This measures what the host supplied automatically, not what the model claims exists elsewhere.

### B. Active host retrieval

Explicitly ask the host to retrieve all project information available through supported host capabilities and then send the retrieved material to the controlled Alice capability tool.

Record every user or host action required, whether retrieval can target one exact conversation/file, and whether identifiers, timestamps, ordering, and relationships survive.

### C. User-mediated acquisition

Explicitly attach, select, paste, download, or export the fixture material using supported user controls, then ask the host to send it to the controlled Alice capability tool.

Record the exact amount of user work, whether unrelated account history is exposed, whether the user can select only the intended project, and whether original bytes or only representations arrive.

## Capability results

For every provider/surface/entry-position combination, complete this matrix from actual tool arguments:

| Capability | Ambient | Retrieval | User-mediated | Unavailable | Expected | Observed | Complete | Reliable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Project name | | | | | 1 | | | |
| Stable project identifier | | | | | 1 | | | |
| Project instructions | | | | | 1 | | | |
| Conversation inventory | | | | | 5 | | | |
| Conversation contents | | | | | 5 | | | |
| Messages | | | | | 43 | | | |
| Message roles | | | | | 43 | | | |
| Message ordering | | | | | 43 | | | |
| Message identifiers | | | | | 43 | | | |
| Message timestamps | | | | | 43 | | | |
| Uploaded-file inventory | | | | | fixture count | | | |
| Uploaded-file exact bytes | | | | | fixture count | | | |
| Generated artifacts | | | | | 1 | | | |
| Artifact exact bytes/content | | | | | 1 | | | |
| Project/conversation/file relationships | | | | | manifest count | | | |

Also record:

```text
expected markers
recovered exact markers
marker coverage percentage
unexpected/duplicated markers
expected content bytes where applicable
received content bytes
truncation or transformation
ordering preserved
relationships preserved
stable IDs preserved
timestamps preserved
original hashes matched
actions required
errors and nondeterministic behavior
```

`Reliable` requires the agreed result across at least three independent trials. Report the distribution when counts differ; do not average away missing conversations, messages, files, or bytes.

## Current implementation comparison

Compare observed provider capability with the current controlled bootstrap/import contract:

```text
alice_project_name
provider_project_id? / provider_project_name?
supplied_material[1..40]
  kind
  content (maximum 12,000 characters)
  speaker?
  occurred_at?
  capture_state
idempotency_key
```

Explicitly identify provider material that the current flat payload cannot preserve, including inventories, nested conversation/message relationships, file bytes, artifact structure, stable source versions, ordering, and incremental updates. Do not interpret a fully accepted current payload as complete project acquisition.

## Acquisition-path decision

Select the smallest supported path only after both provider result sets are complete:

```text
Reliable structured project retrieval
    -> direct MCP acquisition

Reliable partial retrieval plus safe explicit selection
    -> hybrid host + user-mediated acquisition

Only current/ambient conversation is reliable
    -> controlled bootstrap plus a validated fallback

No sufficiently private and reliable path
    -> do not advertise project migration on that surface
```

Choose the maximum common acquisition model only where it produces an honest cross-provider experience. Provider-specific extensions may add fidelity but may not weaken provenance or make the weaker provider appear complete.

An export workflow is not the default assumption. Consider it only after recording the actual direct/hybrid gap, inspecting a specific current export format, confirming project-level filtering and user consent, and defining failure on unknown versions without silently dropping data.

## Normalization gate

Acquisition success does not itself authorize implementation. Before building normalization, write the smallest schema justified by observed material and map it to existing Alice records where their meaning already fits.

The target conceptual structure is:

```text
Imported project
├── project instructions
├── conversations
│   ├── ordered messages
│   └── linked artifacts
└── files
```

Every normalized object must retain a pointer to its immutable raw source, provider, acquisition run, stable source identifier when supplied, content hash, capture state, and transformation/parser version. Missing IDs, timestamps, bytes, ordering, or relationships remain explicit; Alice must not invent them.

## Project-state review gate

Imported source material is not trusted project truth, but retaining it does not require fact-by-fact approval. A later interpretation phase may propose one bounded current-state review containing:

- goal;
- current direction;
- important current decisions with superseded history preserved;
- current working artifact;
- recent meaningful changes;
- open questions.

The user accepts or edits the proposed project state through the existing human-authority boundary. Alice must not present an unbounded queue of extracted sentences as the ordinary review experience.

## Cross-host continuation benchmark

The migration product is successful only when another supported host can continue the work, not when ingestion returns `COMPLETE`.

After acquisition, normalization, and explicit acceptance of the fixture's current project state, connect the other host and ask:

> Continue this project. What were we doing, what had we decided, and what should we work on next?

Then ask it to continue or modify the latest artifact without naming that artifact.

Score whether the receiving host:

- identifies the correct project and goal;
- reports the current decision rather than the superseded one;
- identifies and retrieves the current artifact;
- distinguishes immutable source material from accepted Alice state;
- names the unresolved questions;
- can retrieve or cite the relevant original source when needed;
- produces useful continuation work without manual restatement.

## Required evidence and decision record

The completed test report must include:

- the dated matrix identity and sanitized fixture manifest;
- exact expected/observed counts for every trial;
- marker coverage and byte-hash results;
- redacted raw MCP argument evidence;
- all required user actions and surfaced warnings;
- inconsistent, partial, truncated, transformed, or failed results;
- provider/surface-specific limitations;
- the recommended direct, hybrid, fallback, or unsupported acquisition path;
- the minimum normalized model justified by the evidence;
- an explicit product-owner decision before implementation resumes.

Until that record exists, Alice may describe the current source as a controlled project bootstrap/import only. It must not claim that it migrates an existing ChatGPT or Claude project.
