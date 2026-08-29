# Private Alpha Foundations

Status: Proposed for Milestone 06

Decision date: 2026-08-30

## Purpose

Hands-on testing after Milestone 05 proved the core cross-host consumption loop but exposed too much setup and governance friction for friend testing. The current two-process SQLite topology also cannot safely support an independently deployed hosted alpha, and the one-private-workspace model cannot express the requested project collaboration.

Milestone 06 must make the experience deployable, understandable, and low-friction before recruitment. This document records the product and architectural direction. It does not start Milestone 06 or claim these controls already exist.

## Invariants that do not change

- AI hosts are untrusted structured-input producers.
- An MCP write creates immutable evidence and candidate claims only.
- A model cannot assert that a human clicked, consented, reviewed, or accepted something.
- Only an explicit authenticated human action on the exact proposed content can activate it as project context.
- Accepted context remains versioned and traceable through accepted state, candidate, and evidence provenance.
- Pending, rejected, removed, and inaccessible content is excluded from normal context by default.
- Ordinary application roles cannot update or delete immutable evidence or audit history.
- Secrets and provider configuration remain server-side. Collaborators never share host passwords or plaintext bearer tokens.
- Project and context access remains deny-by-default, including for guessed identifiers and metadata-only paths.

## Product model

### Projects and work contexts

A project is the durable collaboration and ownership boundary. Inside it, users may create work contexts for related streams such as launch planning, competitor research, pricing, or a specific feature.

Each request may use:

1. permitted project-wide active context; and
2. the selected work context's permitted active entries.

Before host work, alice. shows the user's permitted projects and contexts. The user selects an existing context or creates a new one. Active targets are scoped per user and connected host, with a visible option to apply a selection to both of that user's connected hosts. A single invisible global selection is unsafe because concurrent ChatGPT and Claude sessions could write to the wrong destination.

Context similarity begins with deterministic normalized fields and full-text signals. alice. may suggest continuing or grouping similar contexts, but a user confirms the destination or merge. Similarity never silently moves entries, broadens permissions, or makes content active. Embeddings remain out of Milestone 06.

### Consumption

After connection and target selection, supported hosts should retrieve the active project/context without requiring the user to repeat “use alice.” in every prompt. Tool contracts and host instructions may make normal retrieval discoverable, but host capabilities differ. The product must expose a capability matrix and retain an explicit fallback when a host cannot bind a conversation reliably to the active target.

Read/fetch operations remain side-effect free. They cannot alter active selection, freshness, evidence, candidates, accepted state, membership, or permissions.

### Saving with one human confirmation

The desired routine flow is:

1. the AI produces useful work;
2. a save offer names the exact project and context;
3. the user sees the exact proposed entries and source material;
4. the user checks to save or crosses to cancel; and
5. confirmed entries appear under Saved context.

The check must be an alice.-verified authenticated human action. A model-generated `confirmed: true`, a phrase in a prompt, or the host calling an MCP tool is not sufficient. If a host supports a secure interactive component, it may render the alice.-controlled confirmation. Otherwise the host opens the smallest possible alice. confirmation page and returns the user to their work.

The confirmation transaction may create the immutable evidence, candidate, accepted-state version, and audit records together only when the human action is authenticated and bound to the exact preview. If capture occurred first through MCP, confirmation accepts that immutable candidate. In neither path may an ordinary AI tool directly create accepted state.

The product UI uses `Saved context`, `Needs attention`, `Removed`, and `History`. These labels reduce conceptual overhead; they do not remove the internal evidence/candidate/accepted-state boundary.

### Removal, archive, export, and erasure

These are distinct controls:

- **Remove from active context:** append an exclusion or superseding version. Consumption stops returning the item, while provenance and audit history remain.
- **Archive project:** hide and disable ordinary use without erasing its records. It can be restored by an authorized user.
- **Export project:** provide the user's permitted project data, provenance, and history in a documented portable format without disclosing restricted contexts.
- **Permanently delete:** execute a policy-governed privacy erasure workflow, including the published backup-expiry behavior. This is a privileged lifecycle operation, not a normal role rewriting individual evidence or audit rows.

The retention policy must define account deletion, project deletion, collaborator removal, backups, security/audit records, legal holds if applicable, and the maximum erasure window before any friend is invited.

## Collaboration and permissions

### Project membership

Initial project roles are:

- **Owner:** project administration, membership, project-level settings, export, archive, deletion request, and ownership transfer.
- **Editor:** create and edit permitted contexts, propose and confirm saves where permitted, and remove entries from active permitted contexts.
- **Viewer:** read permitted active context and its permitted provenance without mutation.

Invitations are explicit, expiring, single-recipient grants with accept, decline, revoke, and resend lifecycle. The final owner cannot leave or be removed until ownership transfers or the project is safely archived/deleted under policy.

### Context permissions

A context can be visible to:

- all project members;
- selected project members; or
- only its creator as a personal draft.

Context capabilities are Viewer, Editor, and Manager, bounded by the user's project role. A context grant cannot elevate a project Viewer into a project Owner or reveal a project they cannot access. The UI must clearly disclose whether project owners can administer restricted contexts; the implementation and participant copy must agree.

Item-level access control is not part of the first collaboration version. If information needs a different audience, it belongs in a separate context. Moving or grouping content across contexts requires authorization for both source and destination and must never broaden access silently.

### Isolation requirements

Authorization derives from the authenticated user, accepted project membership, context grant, action capability, and active per-user integration connection. It never derives from a caller-supplied project, workspace, membership, context, or role identifier alone.

Denied paths disclose no restricted content or metadata, including project/context names, identifiers, membership, counts, freshness, omissions, conflict presence, artifact references, provenance, search hits, similarity suggestions, or active-selection state. Every new path requires both-direction cross-tenant and cross-permission negative tests.

Each collaborator authorizes their own ChatGPT and Claude connections. Tokens, host credentials, connection status, and revocation are per user and are never inherited through project membership.

## PostgreSQL system of record

PostgreSQL becomes the production system of record before hosted testing. The adapter boundary becomes asynchronous, and migrations are versioned, repeatable, and tested against real PostgreSQL rather than a SQLite emulation.

Migration requirements include:

- preserve exact validated evidence serialization and hashes by storing byte-exact payload text; use `jsonb` only where canonical byte identity is not required;
- use UTC `timestamptz` semantics and deterministic serialized outputs;
- replace SQLite `STRICT`, `NOCASE`, trigger, and `BEGIN IMMEDIATE` assumptions explicitly;
- use database constraints, row locks, unique keys, and transaction isolation to preserve capture idempotency and accepted-version allocation under concurrency;
- retain immutable evidence, accepted state, and audit enforcement at the database boundary available to normal application roles;
- add workspace/project/context/membership composite constraints and indexes for every authorized lookup;
- test clean migration, rollback/failure behavior, concurrent identical and conflicting capture, backup, restore, and schema compatibility; and
- document whether SQLite remains a local-only adapter, how its semantics differ, and how existing development data is discarded or migrated.

## Hosting and connection experience

The target experience has stable web and MCP HTTPS origins. Friends do not run terminals, create Cloudflare quick tunnels, paste changing MCP URLs, or configure raw authorization headers.

The alice. web application provides Connect ChatGPT and Connect Claude surfaces with current connection status, supported-account requirements, reconnect, and revoke controls. OAuth remains per user. The deployment shares one managed PostgreSQL database, injects secrets server-side, applies migrations deliberately, redacts evidence and bearer values from logs, and verifies both deployables through stable health and protocol checks.

Vercel may host the deployables only if the built Express applications, MCP request/transport behavior, stable OAuth origins, PostgreSQL connection strategy, migration process, and operational limits pass hosted tests. Platform choice is subordinate to these properties.

## Privacy and friend-testing boundary

Until Milestone 06 is complete, testers must be told that this is a local/private prototype and must not enter sensitive, regulated, or client-confidential information.

Before invitations open, alice. must publish an understandable private-alpha notice describing:

- data collected and why;
- project and context collaborator visibility;
- what selected context is sent to ChatGPT or Claude and that those providers apply their own account terms and settings;
- storage region and subprocessors once selected;
- encryption and operational-access controls once verified;
- retention, backups, archive, removal, export, and permanent deletion behavior;
- connection revocation and security-event visibility;
- incident and privacy contact; and
- prohibited alpha data categories.

Do not promise that providers do not train on submitted context, that data remains in a particular country, that deletion is instantaneous, or that infrastructure staff can never access data unless the selected services, account configurations, contracts, and implemented controls make those statements true.

Privacy-preserving instrumentation records events and bounded identifiers needed to measure setup, selection, retrieval, save offers, confirmation/cancellation, removal, restatement, and repeat use. It must not record passwords, bearer tokens, exact evidence payloads, complete prompts, model responses, or restricted-context metadata.

## Verification boundary

Milestone 06 is not complete on local happy paths alone. Verification must cover:

- a clean PostgreSQL migration and restored backup;
- hosted web and MCP OAuth/read/write/revocation flows from both target hosts;
- project and context selection across multiple projects and concurrent sessions;
- exact-preview save confirmation and cancel behavior;
- removal from active consumption without provenance loss;
- invitations, role changes, context restrictions, ownership edge cases, and per-user connections;
- non-disclosure under cross-tenant, non-member, insufficient-role, guessed-ID, revoked-token, and restricted-context requests;
- deterministic, budgeted, provenance-bearing context after collaboration filtering; and
- agreement between participant-facing privacy statements and actual system behavior.

Private-alpha recruitment begins only after these checks and the full repository verification contract pass.
