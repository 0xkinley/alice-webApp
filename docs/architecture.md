# alice. Product Architecture

## Product definition

alice. is the independent project intelligence layer for the AI tools users already use.

Core promise:

> One project. Whichever AI you use.

alice. is the product. Its MCP server is one integration component, not the product identity.

## Fundamental loops

### Consumption

```text
Trusted State
     ↓
Context Intelligence
     ↓
Provider Adapter
  ├── Native MCP (preferred)
  └── Explicit context handoff (fallback)
     ↓
Current AI
```

Context intelligence assembles the smallest useful, sourced package for the current task. Accepted state is authoritative. Pending candidates are excluded by default.

### Capture

```text
Current AI
     ↓
Explicit "Save to alice."
     ↓
Provider Adapter
  ├── Native MCP (preferred)
  └── Explicit candidate handoff (fallback)
     ↓
Immutable Evidence
     ↓
Candidate Claims
     ↓
Human Review
     ↓
Trusted State
```

## Trust boundary

ChatGPT, Claude, and future hosts may structure candidate updates, but they are not authorities over project truth.

> Host-generated does not mean alice.-verified.

Every capture stores the submitted evidence and provenance before trusted state can change. Trusted state changes only through an explicit human review action.

## MVP product structure

```text
User
  ↓
Private Workspace
  ↓
Projects
  ├── Project-wide context
  ├── Work contexts
  ├── Evidence
  ├── Candidate Claims
  ├── Trusted State
  ├── Provenance
  └── Audit History
```

The web app is the human control plane for registration, sign-in, private project creation and revisit, review, accepted state, and connection management. The remote MCP server is the authenticated consumption and capture interface used by AI hosts. Project creation never accepts a workspace identifier; the tenant comes from the authenticated web session.

Provider adapters translate host capabilities into the same consumption and capture contracts. They do not own project semantics or alter the trust boundary. Native MCP is preferred because it removes recurring manual transfer while preserving explicit tool use. A bounded, user-controlled copy/paste handoff is the supported fallback. A browser companion is deferred and may be tested only under the constraints in `docs/provider-adapters.md` if native availability or measured friction justifies it.

For the Milestone 01 spike, the minimum control plane is a passphrase-authenticated review page with an explicit accept button per candidate. Acceptance is transactional: it versions accepted state, links the accepted row to its candidate and evidence, marks the candidate accepted, and appends a human-review audit event. The MCP tool list intentionally contains no accept, reject, or trusted-state mutation action.

Milestone 03 replaces the single spike identity with first-party user authentication. Registration atomically creates one private workspace, and both web sessions and MCP OAuth grants resolve the tenant from server-held identity. The original passphrase is no longer runtime configuration. See `docs/authentication-and-tenancy.md`.

Security- and state-relevant operations append audit events in the same transaction as their primary write. The application can insert but database triggers prevent updating or deleting evidence and audit history. Safe audit metadata contains identifiers and counts, never passwords, session tokens, bearer tokens, or submitted evidence content.

Human acceptance is a domain operation imported only by the web review control plane. It adds a new immutable version for a state key and never overwrites the prior accepted row. Candidate/evidence provenance is enforced as an exact composite database reference. The MCP deployable still has no trusted-state tool or acceptance import.

Human rejection is the parallel terminal review operation. It changes a pending candidate to `rejected` and appends an immutable `candidate_rejected` audit event in one transaction, but creates no accepted-state row. Both accept and reject routes require the authenticated first-party web session; missing, foreign, guessed, already-terminal, and racing candidates fail without a review write. The MCP deployable imports neither operation and exposes neither as a tool.

Replacing an existing trusted value is not ordinary acceptance. The review queue shows the current accepted identifier, version, and value, then requires a separate supersession form containing that exact current accepted-state identifier. The transaction verifies that the named row is still the latest version for the same tenant, project, and state key; stale, guessed, foreign, or mismatched targets fail without mutation. Success appends the next immutable accepted row and an `accepted_state_superseded` audit event linking both accepted-state identifiers, versions, candidate, evidence, and human reviewer. No prior row is updated or deleted.

Milestone 04 makes review a workspace dashboard plus tenant-scoped project queues. The default project queue contains pending candidates only; accepted and rejected filters expose terminal history without treating it as current truth. Each candidate shows the proposed value, capture summary, deliberately saved source note/context, evidence hash and identifier, client classification, tool, and capture time. Counts and bounded pagination are computed inside the authenticated workspace scope. No workspace identifier is accepted from the browser.

Tenant authorization is centralized in the domain package. Web project operations require a server-derived user/workspace scope. MCP capture requires an active user/workspace/client connection scope derived from the verified bearer token. Every policy fails closed before project lookup, and workspace-aware database constraints provide defense in depth.

Milestone 05 consumption contract `1.0` makes project discovery and context output strict, authenticated MCP reads. Context assembly selects only the latest accepted version per state key with deterministic structured-key/full-text scoring, returns accepted questions and reference-only artifacts separately, and warns about different pending alternatives without exposing their values. Complete accepted provenance, persisted freshness, content-addressed package versions, exact UTF-8 budgets, and per-section omissions travel with the package. No embeddings, model orchestration, external artifact fetch, or project-state write occurs during assembly.

Milestone 06 introduces durable project-wide and work-context records before changing consumption scope. Every project gets one project-wide context and a `General` work context. The human control plane previews deterministic term-based similarity suggestions before creating another context; suggestions cannot group, select, or broaden access. Context lifecycle events are append-only and content-free.

## Repository and deployable boundaries

The repository uses an npm workspace with two deployables and five shared packages:

```text
apps/
  web/       human review control plane
  mcp/       OAuth and remote MCP transport
packages/
  config/    validated server-only runtime configuration
  schemas/   validated cross-boundary payloads
  domain/    capture and context rules
  database/  persistence access and schema bootstrap
  private-files/ exact-version private object-store adapter
```

The web and MCP processes are server-only applications. The MCP deployable can append immutable evidence and pending candidates through the domain package, but it imports no review route and exposes no trusted-state mutation tool. When private storage is configured, MCP may also perform the exact-version, read-only, untrusted text/Markdown retrieval defined in `docs/file-retrieval.md`. Web and MCP share the `@alice/private-files` S3 adapter so storage behavior cannot drift, while authorization and immutable metadata remain in the domain/database boundary. The web deployable owns authentication, private project management, and the explicit human review route. Both use the Milestone 06 asynchronous PostgreSQL adapter and one shared production database. PostgreSQL-native transactions, locks, constraints, and triggers preserve the same authorization, evidence, candidate, accepted-state, and audit boundaries. The in-memory SQLite adapter remains available only through the explicit testing subpath and cannot be selected by production configuration.

This split changes endpoint topology, not trust behavior. `ALICE_WEB_URL` supplies the review origin returned by MCP capture results, while `ALICE_PUBLIC_URL` remains the OAuth issuer and MCP resource origin.

### Build strategy

The repository targets Node.js 24 and compiles with TypeScript project references. Shared packages emit declarations and JavaScript before the two application projects. Production commands execute only emitted `dist/` JavaScript; source-mode test commands opt into the workspace packages' `development` export condition. Generated output and TypeScript build metadata are ignored rather than committed.

The root package scripts are the canonical developer and CI interface. They deliberately avoid a task runner or deployment orchestrator while the product has only two small server deployables.

GitHub Actions is the repository CI layer. It receives read-only repository permissions, installs with `npm ci` on Node.js 24, and invokes the same root scripts used locally. The workflow receives no application or provider secrets because verification uses in-memory fixtures and loopback integration servers. The evaluation gates cover explicit capture tool selection and both canonical target-host consumption traces without invoking external models.

### Configuration boundary

Both deployables load configuration through the server-only `@alice/config` package. Startup rejects invalid ports, URL credentials or paths, and public HTTP origins. Plain HTTP is accepted only for loopback development. User credentials and bearer tokens are hashed in the database; provider secrets remain server-only. No client bundle or browser-public environment namespace exists in this milestone.

## Round-trip success test

The first spike must prove:

```text
ChatGPT saves A-C
        ↓
alice. review and trusted state
        ↓
Claude retrieves and uses A-C
        ↓
Claude saves D
        ↓
alice. review and trusted state
        ↓
ChatGPT retrieves and uses A-D
```

MCP connectivity alone is insufficient. The recurring workflow must feel easier than manually copying context.
