# Tenant Isolation Verification

Status: Verified through the Milestone 06 project-membership foundation

Verification date: 2026-08-30

## Policy

Existing project-intelligence paths derive the private workspace from an authenticated alice. identity. MCP candidate capture additionally requires an active integration connection whose user, workspace, and registered client match the verified bearer token. A caller-provided workspace field is ignored by bounded project input validation and is never authorization evidence.

Migration `010_project_memberships.sql` adds a narrow collaboration boundary without yet changing context/intelligence authorization. Project invitation management requires an active Owner membership. Invitation preview/accept/decline requires both the token digest and the exact authenticated recipient email. An accepted active membership exposes only the project name, brief, and that user's role; it does not expose contexts, counts, files, provenance, connections, or trusted state. The complete switch from originating workspace scope to membership plus context capability remains unfinished, so ownership transfer and Owner departure are unavailable.

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
| Web | Owner collaborator and invitation management | Non-owner, foreign project, membership, and invitation IDs return the same 404 without project, recipient, role, or invitation status | No invitation, role, ended-membership, or audit row changes |
| Web | Project invitation preview/accept/decline | Wrong signed-in email, random token, replaced token, terminal token, and expired token return the same 404 without project or recipient metadata | No invitation outcome or membership is created |
| Web | Accepted membership summary | Non-member, removed member, foreign project, and guessed project return the same 404 | None |
| MCP | `list_projects` | Other project ID, name, and brief are absent | None |
| MCP | `get_project_context` | Foreign and random project IDs return the same not-found tool error | No accepted value, pending value, candidate, or evidence leaks |
| MCP | `save_project_update` | Foreign and random project IDs return the same not-found tool error | Evidence, candidate, accepted-state, and audit counts do not change |
| MCP | Own accepted context | Other tenant values are absent; own pending value is excluded | None |
| Database | Evidence reference | Foreign workspace/project/connection combination is rejected | No evidence row is inserted |
| Database | Candidate reference | Foreign evidence is rejected by composite key | No candidate row is inserted |
| Database | Accepted-state reference | Foreign candidate/evidence pair is rejected by composite key | No accepted row is inserted |
| Database | Audit reference | Foreign workspace/project pair is rejected by composite key | No audit row is inserted |
| Database | Project membership | Composite project anchor and one-active-user index reject mismatches and duplication; triggers reject deletion, ended-row rewrites, and last-Owner demotion | Membership identity/history remains intact |
| Database | Project invitation | Composite project anchor, unique token digest, and one-pending-email index reject mismatches and duplication; terminal-history triggers reject rewrites/deletion | Exactly one concurrent acceptance creates one active membership |

Project update, archive, and deletion paths remain absent. Organizations and merged/shared workspaces remain absent. The Milestone 06 project-membership foundation is covered by its exact-recipient, non-owner, random-token, guessed-identifier, ended-member, constrained-role, and concurrent-acceptance tests. Context grants and collaborator access to project intelligence are not inferred from this foundation.

Milestone 04 adds only the authenticated workspace review dashboard and bounded project status/pagination views. Both are covered in both tenant directions; they introduce no caller-supplied workspace scope and no sharing surface.

Milestone 05 enriches the existing MCP `list_projects` and `get_project_context` paths rather than adding a new tenant path. Both-direction negative tests continue to compare foreign and guessed identifiers. Project counts/freshness, accepted provenance, question/artifact classification, conflict detection, budgeting, and omissions are all computed only after resolving the authenticated private workspace; conflict joins repeat workspace/project predicates across accepted state, pending candidates, and both evidence rows.

## Trusted-state controls retained

The same matrix confirms that MCP capture remains candidate-only, pending and rejected candidates remain absent from trusted context, and only the authenticated web acceptance path creates versioned accepted state. Authenticated rejection creates no trusted row, and accepted output retains the exact candidate and evidence provenance identifiers.
