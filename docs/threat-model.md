# alice. Initial Threat Model

This document identifies minimum security properties for the spike and MVP. It is not yet a complete production threat assessment.

## Protected assets

- Project evidence and trusted state
- Candidate claims and review decisions
- User and workspace identity
- MCP access and refresh tokens
- Integration connection metadata
- Artifact references
- Audit history

## Trust boundaries

- ChatGPT, Claude, and other hosts are untrusted structured-input producers.
- Model-generated tool arguments are untrusted until validated.
- A valid user token does not imply access to every project.
- Artifact URLs and submitted source material may contain malicious instructions or content.
- The web review interface is the only MVP authority for trusted-state mutation.

## Primary threats

### Cross-tenant access

An authenticated user guesses another project's identifiers or exploits a missing workspace filter.

Minimum controls:

- deny-by-default row authorization
- workspace-aware foreign keys and constraints where possible
- caller-scoped database access
- explicit negative tests for every data path

### Confused-deputy writes

An AI host or prompt injection invokes a write tool without the user's real intent.

Minimum controls:

- tool description requires an explicit save request
- host confirmation where available
- write creates only evidence and candidates
- human review before trusted-state mutation
- visible provenance and revocation

### Silent canonical overwrite

A candidate, extraction process, or retry changes trusted state automatically.

Minimum controls:

- no MCP trusted-state mutation tool
- separate review action
- append-only evidence
- versioned accepted state
- explicit supersession

### Evidence or audit rewriting

A compromised application path attempts to update or delete the source material or security history after the fact.

Minimum controls:

- database triggers reject every evidence and audit update or delete
- normal domain and HTTP interfaces expose append operations only
- composite tenant foreign keys bind evidence and audit rows to their workspace/project
- state-changing transactions append identifier-only audit metadata without credentials, bearer values, or submitted content
- tests exercise mutation and deletion attempts directly against the application database role

### Retry and replay duplication

Hosts retry tool calls and create duplicate evidence or candidates.

Minimum controls:

- caller-provided idempotency key
- unique idempotency constraint scoped to connection and project
- transactional evidence, candidate, and audit creation

### Token leakage or misuse

OAuth tokens appear in logs, storage, errors, or are accepted for the wrong audience.

Minimum controls:

- OAuth 2.1 authorization code flow with PKCE
- issuer, audience/resource, expiry, client, and capability validation
- redacted logs
- short-lived access tokens and revocable connections
- no bearer tokens in application tables or analytics

Milestone 02 added repository and startup gates around the former spike-passphrase boundary. Milestone 03 supersedes that shared passphrase. Remote web and MCP origins still require HTTPS. The repository secret check rejects tracked `.env` files, high-confidence credential formats, and secret-like names under common browser-public environment prefixes. This scanner is a fast preventive check, not a substitute for provider-side secret scanning or credential rotation.

Milestone 03 removes the shared passphrase. User passwords are salted and scrypt-hashed; web sessions and OAuth bearer tokens are random, opaque, and stored only as SHA-256 digests. OAuth grants carry a server-resolved user and connection identifier. A dynamically registered client has no tenant authority until a user authenticates and grants access.

### Account and session compromise

An attacker guesses credentials, fixes a session, or reuses a stolen browser token.

Minimum controls:

- memory-hard, per-user salted password hashes
- fresh opaque session tokens after registration and login
- `HttpOnly`, `SameSite=Strict`, root-scoped cookies with `Secure` on HTTPS
- server-side logout revocation and bounded session lifetime
- generic invalid-credential responses
- deployment edge rate limiting before public self-service registration

### Sensitive overcollection

Alice stores conversation content the user did not intend to save.

Minimum controls:

- no passive history access
- explicit capture only
- bounded payloads
- store only the submitted evidence
- documented retention and deletion behavior before private alpha

### Adapter overreach

A fallback adapter reads more host data than the user deliberately chose to transfer, relies on host session credentials, or silently inserts or submits content.

Minimum controls:

- prefer official native integrations
- keep explicit handoffs previewable and user-initiated
- never read host cookies, tokens, browsing history, or unrelated tabs
- never use undocumented or reverse-engineered host endpoints
- if a browser companion is later justified, use temporary `activeTab` access and an explicit gesture
- capture only selected text and insert only a user-approved package
- fail closed when the intended host surface cannot be identified

### Context poisoning

Unreviewed or malicious content is presented as project truth.

Minimum controls:

- normal context packages use accepted state only
- provenance accompanies assertions
- candidates are labeled and excluded by default
- conflicts and supersession remain visible

## Spike security gates

- Candidate tool calls cannot directly change trusted state.
- Every trusted decision is traceable to evidence and human approval.
- Cross-workspace access tests fail safely.
- Logs contain neither bearer tokens nor unsaved conversation history.
- Revoked connections cannot continue using alice. tools.
