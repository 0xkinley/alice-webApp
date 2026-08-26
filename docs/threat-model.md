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

### Sensitive overcollection

Alice stores conversation content the user did not intend to save.

Minimum controls:

- no passive history access
- explicit capture only
- bounded payloads
- store only the submitted evidence
- documented retention and deletion behavior before private alpha

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

