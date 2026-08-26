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
MCP
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
MCP
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

