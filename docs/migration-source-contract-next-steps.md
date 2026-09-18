# Migration Source Contract and Next Steps

Status: Source contract implemented locally; hosted rollout and cross-host proof pending

Date: 2026-09-18

Milestone: 06.5 — Controlled Project Import Foundation

## Why this note exists

The hosted migration path can create an Alice project and retain the exact material
supplied by ChatGPT as one immutable, unverified `HOST_SNAPSHOT`. The currently
hosted release exposes that snapshot through Imported material, but predates the
normalized source contract and safe projections described below.

That safety boundary is correct, but the product experience is incomplete. A user
who authorizes migration must be able to inspect what Alice received, distinguish
complete content from references or missing bytes, and review any proposed project
information without Alice silently upgrading source material into trusted state.

This note records the agreed contract and the remaining Milestone 06.5 work. It does
not authorize implementation or deployment by itself.

## Implementation progress

The bounded source contract is implemented locally in migration contract `1.1` and
database migration `030`. New imports preserve the original content-hashed
`HOST_SNAPSHOT` and append individually addressable immutable source objects plus
only provider-supplied relationships. Reported scope/completeness remains separate
from the conservative backend-effective scope. Legacy sessions are normalized by
the migration with `unknown`/`unavailable` evidence rather than silently upgraded.

The authenticated migration preview now supports creating a project from supplied
material, adding the material to an independently authorized existing project, or
creating an empty project. Conversation scope is effective only for the bounded
`visible_conversation_only` evidence combination; unsupported provider-project
claims remain effective `unknown` until a trusted provider evidence channel exists.

Imported material groups conversations, instructions, artifacts/file references,
and other material while exposing representation, completeness, scope, and capture
limitations. Complete supplied artifact content is projected into the existing
artifact machinery as `Imported · Unverified`; references do not create artifacts
or files, and the current text contract cannot claim original bytes. Proposed facts
must cite immutable source-object positions and enter the existing Review queue as
pending candidates. They do not create accepted state. The Change log receives one
content-free import summary rather than one entry per message.

Authorized export includes source objects, relationships, and proposal citations;
privileged erasure deletes their exact dependency graph. Constrained-role
PostgreSQL tests cover immutable source/citation records, concurrent idempotency,
export, and erasure. A PostgreSQL 17 logical dump/restore has verified all 30
migrations across 58 protected tables. Hosted rollout, ChatGPT/Claude acquisition
matrix completion, and the cross-host continuation benchmark remain pending.

## Product invariants

> Acquisition fidelity and project authority are different dimensions.

> Alice preserves what it received with maximum fidelity, but only a human can
> determine what becomes trusted project state.

> Scope is evidence, not model interpretation.

> Destination does not imply origin. Creating an Alice project from a conversation
> does not turn the source conversation into a provider project.

The following rules are mandatory:

- Host-generated does not mean Alice-verified.
- Alice may create a project from any supported source scope, but it must never
  claim a broader source scope or greater completeness than the evidence supports.
- The immutable original acquisition payload is never rewritten or discarded by
  normalization, interpretation, review, supersession, or rejection.
- Imported material is immediately inspectable, but it does not become trusted
  project state merely because it was retained or displayed.
- Source conversations do not become Change-log entries. The Change log records
  concise operational events and human-authorized trusted-state mutations.
- A file reference is not a file, extracted text is not the original bytes, and an
  artifact description is not a complete artifact.
- Proposal generation may fail or be deferred without losing the imported source.
- The source ChatGPT or Claude project/conversation is never edited or deleted.

## Source and destination contract

An Alice project may be created from provider-project material, one conversation,
selected supplied material, or no imported source. Provenance remains distinct for
the lifetime of the Alice project.

Canonical source scope is bounded:

```text
source_scope:
- provider_project
- conversation
- unknown

scope_basis:
- provider_metadata
- explicit_tool_context
- user_statement
- visible_conversation_only
- unavailable

scope_completeness:
- provider_claimed_complete
- bounded_complete
- partial
- unknown

completeness_basis:
- provider_metadata
- explicit_tool_result
- observed_truncation
- user_statement
- unavailable
```

`bounded_complete` means Alice received the complete bounded result returned by one
documented operation. It never means Alice received everything the provider holds.
`provider_claimed_complete` is allowed only when a supported provider-controlled
surface supplies that claim; a model or user assertion cannot manufacture it.

Tool arguments are themselves host-derived input. The backend must distinguish a
reported scope from the canonical effective scope. It must compute or validate the
effective scope and basis from the strongest supported evidence channel, defaulting
to `unknown` rather than trusting an arbitrary natural-language or enum claim from a
model. Human-facing copy is generated from bounded canonical fields.

Destination action is independent:

```text
destination_action:
- create_project_from_source
- add_source_to_existing_project
- create_empty_project
```

For `add_source_to_existing_project`, the authenticated human selects the target in
Alice. A host model cannot authorize a target by inventing or supplying a project ID.

Invalid combinations fail closed. Examples include
`provider_project + visible_conversation_only`,
`provider_claimed_complete + user_statement`, and an unauthorized model-supplied
existing-project target.

## Capture and authority dimensions

Capture fidelity is not one linear enum. Representation, completeness, and
authority are recorded separately.

```text
representation:
- exact_bytes
- structured_content
- extracted_text
- metadata
- reference

completeness:
- complete
- partial
- unknown
- unavailable

authority:
- source_unverified
- proposal_unverified
- human_accepted
- superseded
- rejected
```

Examples:

```text
brief.pdf
Representation: exact_bytes
Completeness: complete
Text extraction: partial
Authority: source_unverified
```

```text
Northstar current working brief
Representation: structured_content
Completeness: complete
Original DOCX bytes: unavailable
Authority: source_unverified
```

```text
costs.csv
Representation: reference
Completeness: unavailable
Original bytes: unavailable
Authority: source_unverified
```

## Information layers

```text
IMMUTABLE SOURCE
Import session
├── Conversations and ordered messages
├── Artifact source objects and captured versions
├── File source objects, exact bytes, metadata, or references
├── Project instructions
├── Source relationships
└── Acquisition scope and limitation metadata

             ↓ append-only normalization and interpretation

UNVERIFIED PROPOSALS
├── Proposed decisions
├── Proposed goals
├── Proposed constraints
├── Proposed open questions
├── Proposed next steps
└── Proposed project facts

             ↓ explicit authenticated human review

TRUSTED STATE
├── Accepted current information
├── Superseded information
└── Rejected proposals

             ↓

CHANGE LOG
Concise operational events and human-authorized state changes
```

The existing immutable `HOST_SNAPSHOT` remains the authoritative record of exactly
what the host supplied. Normalized source objects and relationships are appended and
linked to it; they never replace it.

## Target product experience

The project navigation becomes:

```text
Overview
Imported material
  ├── Conversations
  ├── Instructions
  ├── Artifacts and file references
  └── Acquisition scope and limitations
Artifacts
Files
Review
Change log
```

`Imported material` is a provenance view over immutable source objects, not a
parallel storage or authority system. Conversations begin as a content type in this
view rather than a new top-level navigation item.

### Artifacts

- Complete captured document, code, or canvas content may appear immediately as an
  artifact version labelled `Imported · Unverified` with source, representation,
  completeness, capture time, and limitations.
- A description or filename alone appears only as a reference with
  `Original unavailable`; Alice must not manufacture content or original bytes.
- An exact binary document may appear in Files while an independently extracted or
  structured representation appears in Artifacts. The two are linked but are not
  asserted to be identical without appropriate evidence.

### Files

- Only bytes actually received through an authorized, scan-gated path appear as an
  available file.
- Metadata-only and reference-only files remain visible in Imported material with
  explicit missing-byte status.

### Review

- Derived decisions, goals, constraints, questions, next steps, and facts remain
  unverified proposals with citations to immutable source objects.
- Acceptance, editing, rejection, and supersession are explicit authenticated human
  actions using Alice's existing authority model.
- Review acts on meaningful bounded project-state proposals, not an unbounded list
  of every imported sentence.

### Change log

An import creates one concise operational event, for example:

```text
Imported from ChatGPT project context
21 source items retained
1 complete-content artifact identified
4 file references found
0 original file bytes received
7 proposals awaiting review
```

Later human review creates separate trusted-state events, for example:

```text
Pricing set to $10/month
Accepted by Alice Ho
Source: ChatGPT import
Previous trusted value: none
```

Every contradictory or superseded source message remains preserved underneath.

## Source-aware migration flow

```text
User says “Migrate to Alice”
             ↓
Resolve the strongest supported acquisition-scope evidence
             ↓
┌──────────────────┬────────────────────┬────────────────────────┐
│ provider_project │ conversation       │ unknown                │
│ Project-material │ Create project     │ Create project from    │
│ preview          │ from this chat     │ supplied material      │
└──────────────────┴────────────────────┴────────────────────────┘
             ↓
Show exact supplied scope, completeness, and limitations
             ↓
Authenticated human chooses destination action
             ↓
Persist immutable source
             ↓
Normalize source objects without rewriting raw input
             ↓
Generate cited unverified proposals when supported
             ↓
Human review may change trusted state
```

For conversation-only material, Alice says:

> Alice can currently access this conversation, but no surrounding project context
> was supplied.

For unknown scope, Alice says:

> Alice received material from the current AI session, but the host did not identify
> whether it represents a full project or an individual conversation.

The unknown-scope choices are `Create a project from supplied material`, `Add
supplied material to an existing project`, `Create an empty project`, and `Cancel`.
Alice does not require the user to resolve the provider's technical ambiguity.

## Work required

### 1. Contract and compatibility

- Add bounded source-scope, completeness, evidence-basis, destination-action,
  representation, completeness, and authority schemas.
- Separate reported host claims from backend-canonical effective fields.
- Define fail-closed combination validation and human-readable copy generated only
  from canonical enums.
- Preserve compatibility for existing migration sessions. Legacy sessions without
  sufficient recorded evidence use `unknown`/`unavailable`; they are not silently
  upgraded from optional provider names or model prose.

### 2. Normalized immutable source graph

- Retain every original `migration_source_records.exact_content` value and hash.
- Add individually addressable immutable source objects for conversations, messages,
  instructions, artifact content/descriptions, and file metadata/references.
- Add immutable relationships such as contains, replies-to, attached-to, produced,
  version-of, and reported-supersedes only when actually supplied.
- Record ordering, timestamps, provider identifiers, and capture limitations as
  missing when not supplied rather than generating them.
- Make normalization deterministic, idempotent, retryable, append-preserving, and
  independently failure-reporting.

### 3. Visible Imported material

- Add an authenticated project `Imported material` route and navigation item.
- Show import sessions, source scope, completeness basis, counts, limitations, and
  every authorized source object.
- Support conversation/message reading and filtering without placing messages in the
  Change log.
- Display content, metadata, references, and missing original bytes with distinct
  badges and accessible text.
- Make the already-hosted Northstar import inspectable without mutating its raw
  snapshot or claiming stronger legacy scope evidence.

### 4. Artifact and file projection

- Create unverified artifact versions only from complete captured structured/content
  representations or an explicit human classification.
- Preserve provenance links from artifact versions to source objects and raw import
  sessions.
- Keep metadata/reference-only objects in Imported material rather than creating fake
  artifacts or files.
- Reuse the current private upload, scan, immutable-version, hashing, and authorization
  path for exact bytes; link resulting files to their source references.

### 5. Review proposals and trusted-state transition

- Add a Review view for bounded cited proposals without writing accepted state.
- Determine and document the supported proposal-generation mechanism after source
  normalization and provider-acquisition evidence. Any model-generated proposal is
  unverified regardless of model or host.
- Reuse existing candidate, review, accepted-state, conflict, and supersession paths.
- Require explicit authenticated human acceptance/edit/rejection for every trusted
  state transition.
- Ensure proposal-generation failure never changes or hides imported source.

### 6. Source-aware command and preview

- Update the MCP contract so `Migrate to Alice` routes through project,
  conversation-only, or unknown-scope previews without natural-language scope labels.
- Add the three destination actions; select existing targets only in authenticated
  Alice UI.
- Show exact observed items and missing/truncated limitations before confirmation.
- Preserve preview-only/no-action behavior and source-provider non-mutation.

### 7. Change log, export, lifecycle, and erasure

- Add one concise import operational event with source-scope and retained-count
  summary; do not add each chat message as an event.
- Add human-review events only when trusted state changes.
- Include normalized source objects, relationships, projections, and proposals in
  authorized project export and privileged erasure dependency order.
- Preserve archive, membership, tenant, non-disclosure, and deletion boundaries.

### 8. Verification and rollout

- Test project, conversation, and unknown routing; invalid combinations; truncation;
  partial material; missing metadata; legacy sessions; and idempotent retries.
- Test exact-byte versus extracted/content/reference distinctions and ensure no fake
  file or artifact is created.
- Test prompt injection as inert imported data, citation integrity, proposal isolation,
  human authority, conflict/supersession, tenant denial, export, and erasure.
- Test that Change log stays concise and that imported messages remain readable.
- Complete the empirical ChatGPT and Claude acquisition matrix and cross-host
  continuation benchmark before advertising whole-project migration.
- Run the complete clean-checkout, PostgreSQL, backup/restore, evaluation,
  accessibility, production-build, deployment-plan, hosted health, and clean-tree
  gates before a staged deployment.

## Suggested implementation sequence

```text
1. Approve this contract
2. Add compatible schema and domain records
3. Normalize existing and new raw snapshots append-only
4. Ship Imported material read-only UI
5. Add safe artifact/file projections
6. Add Review proposals and human acceptance
7. Add source-aware chat/project/unknown preview routing
8. Verify export, erasure, security, accessibility, and cross-host continuation
9. Review and deploy through the existing staged AWS runbook
```

The first useful product increment is steps 2–4: users can see exactly what Alice
retained before any semantic proposal or trusted-state automation is introduced.

## Success criteria

- A user can open a migrated Alice project and inspect every authorized imported
  source item without downloading a raw export.
- The UI states source scope, basis, completeness, representation, and missing data
  without claiming more than the acquisition evidence supports.
- Complete captured artifacts are readable as unverified artifacts; references do
  not become fake artifacts, and unavailable bytes do not appear in Files.
- Conversations remain readable in Imported material and do not flood Change log.
- Every proposal cites immutable source, remains unverified, and changes trusted state
  only through an authenticated human action.
- Existing raw snapshots remain hash-identical, exportable, and erasable after
  normalization and projection.
- Chat-only, provider-project, selected-material, and empty-project creation retain
  permanently distinct provenance.
- A receiving ChatGPT or Claude host can continue useful work from accepted Alice
  state while still exposing source limitations and historical evidence when asked.

## Deferred and prohibited behavior

- No hidden provider API, scraping, cookie/token extraction, password collection, or
  automatic provider-project mutation.
- No claim of complete provider-project acquisition without supported evidence.
- No automatic acceptance of host/model interpretations.
- No fabrication of missing messages, ordering, timestamps, file bytes, hashes,
  artifact content, or relationships.
- No deletion or rewriting of contradictory, rejected, or superseded source evidence.
- No requirement to build an internal LLM before immutable source visibility works.
- No provider-export parser until a real supported export path and exact format are
  validated by the acquisition test.

## Implementation decisions and remaining questions

- Normalized objects use `migration_source_objects`; a single bounded
  `migration_source_relationships` edge table records only relationships explicitly
  supplied in the acquisition payload.
- Strongly typed, complete `artifact` content projects automatically to an existing
  artifact version with `IMPORTED_UNVERIFIED` authority and a source-object link.
  Artifact descriptions and file references never project content.
- Proposal generation remains external to Alice's trusted-state engine. Contract
  `1.1` can receive bounded proposals with mandatory source positions, preserve the
  exact proposal envelope as evidence, and place candidates in Review. Selecting a
  provider/model/prompt generation strategy still depends on acquisition evidence.
- Imported material is bounded by the current 40-item acquisition contract, so the
  first normalized view groups the complete session without pagination or search.
- Legacy sessions remain visible through normalized backfill and retain effective
  `unknown` scope/completeness. Optional provider labels do not upgrade that claim.
- The unresolved product proofs are the empirical ChatGPT/Claude acquisition matrix,
  any triggered bounded multi-call phase, and useful cross-host continuation after
  human review. Those proofs—not database status alone—govern any whole-project
  migration claim.
