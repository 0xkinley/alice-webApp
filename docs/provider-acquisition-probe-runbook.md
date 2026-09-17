# Provider Acquisition Probe Runbook

Status: Local diagnostic preparation only; revised design review requires a code change before use, and deployment and provider-account use are not authorized.

## Purpose and measurement boundary

The probe measures:

> What project information can ChatGPT or Claude, together with the tested host environment and model, make available to the model and marshal into one MCP tool call?

It does not observe a raw provider project API. The model chooses whether to call the tool and constructs arguments that conform to the advertised schema. Results therefore describe the exact tested provider, account, surface, configuration, model when visible, prompt, and date. They must not be generalized to another surface or treated as proof of an undocumented provider API.

This package is deliberately separate from the Alice MCP runtime under `diagnostics/acquisition-probe/`. The production Docker build does not copy that directory. The probe imports no Alice database, domain, project, migration, file, artifact, OAuth, or trusted-state service.

## Four deployment-review surfaces

No deployment may be approved without reviewing these exact surfaces.

### 1. Tool schema

The server advertises exactly one tool named `submit_acquisition_evidence` with this input schema:

```json
{
  "type": "object",
  "additionalProperties": true
}
```

There are no declared properties, required fields, conversation or file shapes, item-count limits, or normalization rules. The HTTP transport has an 8 MiB request ceiling to protect the temporary service; this is larger than the complete synthetic fixture and is not a semantic fixture limit.

### 2. Tool description

The approved design requires this complete model-visible description:

> Submit diagnostic acquisition evidence for this test.

The exact title is `Submit acquisition evidence`. The annotations remain `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, and `openWorldHint: false`. The name, title, description, schema, and annotations are held byte-for-byte constant across Ambient, Active retrieval, and User-mediated trials so that only the saved user prompt and defined user actions change. The description does not instruct the model to maximize retrieval, use Alice's existing flat migration schema, or invent a provider structure.

The current local prototype still advertises the superseded description `Send all information currently available for this diagnostic acquisition test.` It must not be used for provider trials. Updating the implementation and test assertion requires the next explicit implementation approval.

### 3. Diagnostic data written

Every run has an operator-created session with a random 256-bit URL token. Only the SHA-256 token digest is stored. The token is shown once to the operator in the temporary MCP URL and is never written into the evidence record.

One session accepts at most one diagnostic tool call. The record contains only:

- diagnostic contract, record, and session identifiers;
- receipt and expiry timestamps;
- operator-supplied run metadata: fixture, provider, account plan, region, surface, host version, entry position, acquisition leg, trial, exact prompt, and prompt hash;
- the exact tool name;
- the exact argument object serialized immediately from the parsed JSON-RPC request before MCP schema validation or application transformation, plus its SHA-256 and UTF-8 byte count;
- a parsed duplicate of that same argument object for deterministic analysis.

The operator report separately records whether evidence was captured and whether the provider observed a successful tool response. A stored first call followed by a provider retry and `already used` response is a response-delivery outcome, not an acquisition-content failure.

The record does not contain HTTP headers, authorization headers, cookies, source IP addresses, user agents, Alice users, Alice projects, migration sessions, artifacts, files, accepted state, provider passwords, or hidden provider tokens. Only synthetic fixture data may be used. If real personal or confidential information appears in a call, stop, delete the session immediately, and do not include the record in a report.

### 4. Expiry and deletion

The default session and record TTL is 24 hours. An operator may choose between one minute and 72 hours, but never longer. Expired session and record files are removed at server startup, before a session is created, or by the explicit prune command. The exact session and its record can be deleted immediately by session ID. Deployment design must add an independent storage lifecycle backstop before approval; application pruning alone is insufficient for a hosted environment.

## Synthetic fixture

Generate a fresh marker set for the real experiment:

```sh
npm run acquisition:fixture -- --output .data/provider-acquisition-fixtures
```

The generated fixture contains:

- one uniquely marked project name;
- one project instruction;
- five ordered conversation scripts with 43 designated marked message units;
- six decisions, including an earlier `$24/month` decision and later `$10/month` superseding decision;
- three open questions;
- four required uploads: TXT, PDF, CSV, and visibly marked PNG;
- one optional valid DOCX for surfaces that support it;
- one current working artifact;
- five plausible negative markers that occur only in the local operator manifest;
- exact identical prompts for ambient, active-retrieval, and user-mediated trials;
- file and artifact SHA-256 values, relationships, ordering, and counts in `operator-only/manifest.json`.

Upload only `provider-upload/`. Never upload `operator-only/`, `conversations/`, `prompts/`, the fixture README, or the manifest. Those files contain expected evidence or negative controls and would contaminate the experiment.

Create equivalent isolated projects in ChatGPT and Claude through supported ordinary project controls. Before trials, verify the real source state against the local manifest. Provider-required setup messages that are not one of the 43 designated units must be recorded as setup contamination; they cannot be silently counted as recovered fixture messages. If an exact 43-unit replay is not feasible through the supported interface, revise both provider fixtures symmetrically and version the manifest before any trial rather than claiming a false inventory.

For the strongest boundary checks:

- place the instruction marker only in the project instruction;
- place each cross-conversation marker only in its designated conversation;
- upload the four required files without pasting their markers into chat;
- place the artifact marker through a supported artifact editor when available, without pasting the exact marker into a conversation;
- if a host requires the exact artifact marker in a setup prompt, record that contamination and do not claim the run proves artifact-only retrieval;
- verify that no negative marker occurs in any provider-visible source.

## Local probe verification

Run the focused test:

```sh
node --conditions=development --test test/acquisition-probe.test.ts
```

The test verifies fixture counts and formats, absent negative markers, unrestricted tool schema, neutral description, pre-validation capture, one-call sessions, TTL pruning, explicit deletion, scoring, no Alice-state imports, and exclusion from production image inputs.

Start the local server only for local protocol checks:

```sh
npm run dev:acquisition-probe
```

Localhost cannot be connected from ChatGPT or Claude web. A remote HTTPS deployment requires a separate reviewed design and explicit approval.

## Create one run session

Create a separate session for every independent trial. Example placeholders must be replaced with observed, non-secret values:

```sh
npm run acquisition:session -- \
  --manifest .data/provider-acquisition-fixtures/FIXTURE/operator-only/manifest.json \
  --prompt-file .data/provider-acquisition-fixtures/FIXTURE/prompts/ambient.txt \
  --provider chatgpt \
  --account-plan PLAN \
  --region REGION_OR_NOT_EXPOSED \
  --surface web \
  --host-version VERSION_OR_NOT_EXPOSED \
  --entry-position new-project-conversation \
  --leg ambient \
  --trial 1 \
  --base-url https://APPROVED_TEMPORARY_HOST
```

The command prints a session ID, expiry, and one secret MCP URL. Do not paste the URL into the report, Git, chat transcripts, screenshots, or evidence. Store the session ID separately so its data can be deleted after scoring.

Use the exact prompt file without edits for all three repetitions of a leg. Start a fresh eligible conversation or session for every trial so prior results do not contaminate ambient context. Complete ChatGPT before beginning Claude.

## Score without normalizing the evidence

```sh
npm run acquisition:score -- \
  --manifest .data/provider-acquisition-fixtures/FIXTURE/operator-only/manifest.json
```

The scorer reports every run separately and retains the distribution across repetitions. It deterministically measures exact marker recall, negative-marker returns, duplicates, recovered marker order, JSON paths, and matching exact file/artifact byte hashes. It does not infer message roles, provider identifiers, timestamps, relationships, or whether a field was retrieved rather than reconstructed; those require manual review of the exact recorded arguments and observed host actions.

## Delete or expire evidence

Delete one session and its record immediately after the sanitized evidence and score are retained:

```sh
npm run acquisition:delete -- --session-id SESSION_UUID
```

Remove every expired record:

```sh
npm run acquisition:prune
```

After the experiment, confirm both session and record directories are empty. A future hosted run must additionally verify the independent storage lifecycle and delete the temporary service and storage resources.

## Stop boundaries

Stop and request product-owner review before any of the following:

- adding AWS resources or deploying this probe;
- configuring the temporary URL in ChatGPT or Claude;
- creating or modifying provider projects for the live test;
- adding cloud storage, OAuth, logs, observability, or a second probe tool;
- changing the schema, description, TTL, stored fields, fixture counts, prompts, or scoring rules;
- implementing normalization, semantic reconstruction, migration UI, or migration state logic from unobserved assumptions.
