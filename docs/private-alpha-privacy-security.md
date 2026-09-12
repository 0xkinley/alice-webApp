# Private Alpha Privacy and Security Notice

Status: Published operational disclosure for the invite-only private alpha

Notice version: `2026-09-01.1`

Effective date: 2026-09-01

This notice describes the currently implemented alice. private-alpha system and its verified limits. It is not a general-audience privacy policy, a compliance certification, or a promise about controls that have not passed their live verification. The alpha is operated by the person who sent each tester their private invitation.

The public, unauthenticated product copy is served at `/privacy-security`. This document is the durable source for its claims and the evidence boundaries behind them.

## Prohibited private-alpha data

Do not enter sensitive, regulated, or client-confidential information until the corresponding technical, contractual, and operational controls have been verified. Prohibited examples include:

- health or medical information;
- payment, banking, or other financial information;
- government identifiers;
- passwords, API keys, access tokens, cookies, private keys, or other secrets;
- children's data;
- legally privileged or client-confidential material;
- export-controlled material;
- production customer data; and
- any material the tester is not authorized to disclose to alice., their collaborators, their selected AI provider, or AWS.

This restriction is visible before account creation and in the global product privacy link. The private alpha has no independent certification or audit; password reset, email verification, and edge rate limiting are not yet implemented.

## Data collected and purposes

| Category | Collected data | Purpose |
| --- | --- | --- |
| Account and authentication | Normalized email; salted `scrypt-v1` password digest; invitation, membership, session, and connection records; SHA-256 digests of session, OAuth code, access-token, and refresh-token values | Authenticate the user, create one private workspace, enforce invitation and tenancy boundaries, maintain separately revocable user connections, and investigate bounded security events |
| Projects and contexts | Project/context names and descriptions; exact evidence payloads submitted through MCP; proposed, confirmed, rejected, removed, repaired, and superseded entries; artifact metadata, immutable versions, and append-only active/superseded/archived lifecycle events; short-lived artifact-read receipt hashes and single-use records; source, actor, time, hashes, provenance, idempotency, versions, omissions, and review history | Maintain a versioned, provenance-bearing project record; assemble permission-filtered context; preserve canonical and historical artifact lineages; prevent a host from versioning the wrong or stale artifact; and prove which exact human action did or did not activate an entry |
| Files | Uploaded bytes; safe filename, type, size, content hash, immutable object version, scan state, uploader/source, reference time, permissions, extraction receipt, and lifecycle state | Provide direct private upload, malware gating, exact-version access, bounded extraction, provenance, sharing, removal, and eventual erasure reconciliation |
| Collaboration | Invitation emails; active and ended memberships and roles; ownership changes; context grants and history | Share only explicitly permitted project/context information and explain current access |
| Operations and alpha signals | Health/security logs; bounded identifiers, action names, statuses, counts, and timestamps for connection, retrieval, save offers, decisions, repairs, and removals | Operate and secure the service and measure confirmation burden, observed read outcomes, cross-host reuse, and repeat use without content surveillance |

Alpha-signal queries deliberately do not select complete prompts, model responses, evidence payloads, candidate values, saved values, project/context names, emails, credentials, or restricted-context metadata. alice. cannot observe a host turn that never calls it and does not infer those missing turns as failures.

## Recipients and access boundaries

### Collaborators

Project members see only the projects and contexts allowed by their current project role and explicit context grants. A project Owner does not automatically see or administer a selected-member or personal context. Another collaborator does not inherit a user's AI connection, bearer tokens, or connection status.

### User-selected AI providers

When a user's own authorized ChatGPT or Claude host calls alice., it receives only the permission-filtered and budgeted project context or exact file excerpt required by that call. alice. does not receive the user's ChatGPT or Claude password, host cookies, unrelated host content, or complete conversation history. A bounded opaque conversation reference is retained only when the user explicitly confirms a host-file save offer. Codex is not a participant product in the private alpha.

OpenAI and Anthropic are user-selected recipients through the user's own host account, not alice.-operated model subprocessors. After permitted context crosses that boundary, the provider's product, account type, region, settings, terms, retention, and model-improvement choices apply. alice. cannot promise that a provider does not train on the data or that the provider retains, locates, or deletes it in a particular way. Testers must review the provider's current policies and settings:

- OpenAI, [Privacy Policy](https://openai.com/policies/privacy-policy/) and [Consumer privacy](https://openai.com/consumer-privacy/)
- Anthropic, [Privacy Policy](https://www.anthropic.com/legal/privacy) and [Privacy Center](https://privacy.anthropic.com/)

Every named provider surface remains unsupported until its own dated compatibility result passes. The server-side hosted OAuth proof does not establish support for an exact provider client.

### AWS and its subprocessors

AWS is the current cloud subprocessor. Core hosted resources run in AWS Europe (Frankfurt), `eu-central-1`:

- Lambda for the web and MCP deployables;
- Aurora PostgreSQL 17.4 for the system of record;
- private S3 for versioned file bytes;
- GuardDuty Malware Protection for S3 for new-object scan results;
- Secrets Manager for server-only database credentials;
- CloudWatch for bounded operational logs; and
- ECR for immutable deployment images.

This region selection is an architecture fact, not a promise that all operational, support, or subprocessor activity remains in Germany or the EU. Applicable AWS subprocessors vary by service and region. AWS's authoritative current list is the [AWS Sub-processors page](https://aws.amazon.com/compliance/sub-processors/). Do not include alpha data in an AWS support request unless it is necessary and explicitly reviewed.

### Required disclosure

The operator may disclose the minimum necessary data when legally required or to investigate and contain a security incident. alice. does not sell private-alpha data or use it for advertising.

## Verified security controls and limitations

The current hosted checkpoint has verified:

- HTTPS transport and `verify-full` TLS to PostgreSQL;
- encrypted, deletion-protected Aurora storage in private subnets;
- private, versioned S3 with SSE-S3 AES-256 encryption and all four public-access blocks;
- exact-origin, PUT-only browser-upload CORS;
- ten-minute signed uploads and 60-second signed authorized downloads, with no permanent public object URLs;
- GuardDuty gating before a staged or final object becomes available, including clean and threat-denial live proofs;
- server-only secrets and no long-lived AWS access keys in the application;
- separate deny-by-default web, MCP, database, migration, backup, and erasure boundaries;
- content-redacted logs and content-free security receipts;
- per-user OAuth grants, PKCE, state validation, token rotation, complete connection revocation, and a live post-revocation HTTP 401 proof; and
- exact project/context authorization with negative non-disclosure tests.

These controls reduce risk; they do not establish independent certification, perfect security, guaranteed residency, or irreversible deletion.

## Retention and temporary credentials

| Data | Current behavior |
| --- | --- |
| Web sessions | Maximum age of seven days; signing out revokes the current server-side session |
| OAuth authorization codes | Five-minute lifetime; only digests are stored |
| OAuth access tokens | One-hour lifetime; only digests are stored |
| OAuth refresh tokens | 30-day lifetime and rotation; only digests are stored |
| Revoked/expired credential records | Digest-only rows may remain as operational history; no plaintext bearer value is retained |
| Direct upload capability | Ten-minute lifetime, bound to the exact object and required checksum/encryption headers |
| Authorized download capability | 60-second lifetime for the exact current permitted object version |
| Staging objects | Current objects expire after two days; noncurrent staging versions expire after one day |
| Web and MCP application logs | Current CloudWatch log groups retain logs for 14 days |
| Active or archived project data | Retained until an authorized project-erasure workflow completes; archive and remove-from-context are not erasure |
| Aurora automated backups | Seven-day retention at the current hosted checkpoint |
| Manual snapshots | Not automatically covered by project erasure; any snapshot containing alpha data must have a recorded owner and deletion date |

## User controls and deletion limits

- **Access and security:** shows the active members, visible context audiences, the signed-in user's connections, and bounded recent security actions that the viewer is permitted to know.
- **Connection revocation:** invalidates the complete alice. connection immediately. It cannot remove copies that an AI provider may already retain under its own terms.
- **Permission-filtered export:** an Owner can download visible project data and provenance as no-store JSON. The export excludes inaccessible context existence, raw multi-destination evidence envelopes, object keys and versions, credentials, tokens, signed URLs, and file bytes.
- **Remove from active context:** stops ordinary use of the entry or file reference while preserving immutable source, provenance, and history.
- **Archive:** removes the project from ordinary web, review, file, context-package, invitation, and AI-connection paths while preserving its data.
- **Project-deletion request:** requires archive first and starts a seven-day cancellation period. The request itself deletes nothing.
- **Privileged erasure:** the working alpha target is operator removal of active PostgreSQL data and exact S3 versions within the seven days after cooling-off. With the current seven-day automated-backup retention, the calculated target is a maximum recovery window of 21 days after request. Hosted erasure and later provider-backup expiry have not passed their live proof, so this timeline is not a permanent-deletion promise.

Account-wide erasure is not implemented. A project request covers only the named project. Shared immutable bytes remain if another authorized project still references them, while all target-project references are removed. A legal obligation or active security incident may require a documented preservation hold and notice to the requester.

## Privacy and incident contact

Contact the alpha operator through the same private channel in which the alice. invitation was delivered. Include the alice. account email, approximate time, and a safe description of the issue. Do not send a password, session cookie, OAuth token, private file, or project content in the incident report.

No public incident-response mailbox has been approved for this alpha, so the notice does not invent one. A future public contact replaces this invitation-channel instruction only after the operator verifies that it is monitored and documents the change.

## Notice changes and verification

The date-qualified notice version makes changes reviewable. Material changes must be committed with the corresponding implementation or evidence and communicated through the private invitation channel before being relied upon for expanded testing.

The source contracts are:

- [`docs/authentication-and-tenancy.md`](authentication-and-tenancy.md)
- [`docs/data-model.md`](data-model.md)
- [`docs/project-access-and-security.md`](project-access-and-security.md)
- [`docs/project-lifecycle.md`](project-lifecycle.md)
- [`docs/private-alpha-aws-deployment-runbook.md`](private-alpha-aws-deployment-runbook.md)
- [`docs/host-surface-compatibility.md`](host-surface-compatibility.md)

Any conflict must be resolved in favor of the implemented, verified behavior and an updated notice—not a broader marketing claim.
