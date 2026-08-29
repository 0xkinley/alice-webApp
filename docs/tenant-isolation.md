# Tenant Isolation Verification

Status: Verified through Milestone 05

Verification date: 2026-08-30

## Policy

Every project data path derives the private workspace from an authenticated alice. identity. MCP candidate capture additionally requires an active integration connection whose user, workspace, and registered client match the verified bearer token. A caller-provided workspace field is ignored by bounded project input validation and is never authorization evidence.

Foreign identifiers and random well-formed identifiers intentionally produce the same non-disclosing outcome. This prevents callers from using response differences to enumerate another user's projects or project intelligence.

## Negative-test matrix

The integration fixture creates two authenticated users, separate private workspaces, projects, web sessions, OAuth connections, immutable evidence, one accepted claim, and one pending claim per tenant. Every API case runs in both tenant directions.

| Surface | Project data path | Foreign/guessed assertion | Mutation assertion |
| --- | --- | --- | --- |
| Web | Workspace project list | Other project ID, name, and brief are absent | None |
| Web | Project detail | Foreign and random project IDs return identical 404 pages | None |
| Web | Project creation | Submitted foreign `workspace_id` is ignored | New project belongs to the authenticated workspace |
| Web | Workspace review dashboard | Other project names, candidate counts, values, and evidence identifiers are absent | None |
| Web | Project review queue and status filters | Foreign and random project IDs return identical 404 pages with no candidate, evidence, value, accepted-state, or provenance disclosure | None |
| Web | Candidate acceptance, rejection, and supersession | Foreign and random candidate/accepted-state IDs return identical 409 pages for each decision | Candidate stays pending; current accepted state, version history, and audit counts do not change |
| MCP | `list_projects` | Other project ID, name, and brief are absent | None |
| MCP | `get_project_context` | Foreign and random project IDs return the same not-found tool error | No accepted value, pending value, candidate, or evidence leaks |
| MCP | `save_project_update` | Foreign and random project IDs return the same not-found tool error | Evidence, candidate, accepted-state, and audit counts do not change |
| MCP | Own accepted context | Other tenant values are absent; own pending value is excluded | None |
| Database | Evidence reference | Foreign workspace/project/connection combination is rejected | No evidence row is inserted |
| Database | Candidate reference | Foreign evidence is rejected by composite key | No candidate row is inserted |
| Database | Accepted-state reference | Foreign candidate/evidence pair is rejected by composite key | No accepted row is inserted |
| Database | Audit reference | Foreign workspace/project pair is rejected by composite key | No audit row is inserted |

Project update and deletion paths do not exist through Milestone 04. Teams, memberships, invitations, organizations, sharing, and team UI also remain absent, so they introduce no additional tenant path in this milestone.

Milestone 04 adds only the authenticated workspace review dashboard and bounded project status/pagination views. Both are covered in both tenant directions; they introduce no caller-supplied workspace scope and no sharing surface.

Milestone 05 enriches the existing MCP `list_projects` and `get_project_context` paths rather than adding a new tenant path. Both-direction negative tests continue to compare foreign and guessed identifiers. Project counts/freshness, accepted provenance, question/artifact classification, conflict detection, budgeting, and omissions are all computed only after resolving the authenticated private workspace; conflict joins repeat workspace/project predicates across accepted state, pending candidates, and both evidence rows.

## Trusted-state controls retained

The same matrix confirms that MCP capture remains candidate-only, pending and rejected candidates remain absent from trusted context, and only the authenticated web acceptance path creates versioned accepted state. Authenticated rejection creates no trusted row, and accepted output retains the exact candidate and evidence provenance identifiers.
