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
  ├── Evidence
  ├── Candidate Claims
  ├── Trusted State
  ├── Provenance
  └── Audit History
```

The web app is the human control plane for project creation, review, accepted state, and connection management. The remote MCP server is the authenticated consumption and capture interface used by AI hosts.

Provider adapters translate host capabilities into the same consumption and capture contracts. They do not own project semantics or alter the trust boundary. Native MCP is preferred because it removes recurring manual transfer while preserving explicit tool use. A bounded, user-controlled copy/paste handoff is the supported fallback. A browser companion is deferred and may be tested only under the constraints in `docs/provider-adapters.md` if native availability or measured friction justifies it.

For the Milestone 01 spike, the minimum control plane is a passphrase-authenticated review page with an explicit accept button per candidate. Acceptance is transactional: it versions accepted state, links the accepted row to its candidate and evidence, marks the candidate accepted, and appends a human-review audit event. The MCP tool list intentionally contains no accept, reject, or trusted-state mutation action.

## Repository and deployable boundaries

Milestone 02 establishes an npm workspace with two deployables and three shared packages:

```text
apps/
  web/       human review control plane
  mcp/       OAuth and remote MCP transport
packages/
  schemas/   validated cross-boundary payloads
  domain/    capture and context rules
  database/  persistence access and schema bootstrap
```

The web and MCP processes are server-only applications. The MCP deployable can append immutable evidence and pending candidates through the domain package, but it imports no review route and exposes no trusted-state mutation tool. The web deployable owns the explicit human review route. Both currently use the Milestone 01 SQLite persistence adapter; a shared production database and tenant-shaped authentication remain Milestone 03 work.

This split changes endpoint topology, not trust behavior. `ALICE_WEB_URL` supplies the review origin returned by MCP capture results, while `ALICE_PUBLIC_URL` remains the OAuth issuer and MCP resource origin.

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
