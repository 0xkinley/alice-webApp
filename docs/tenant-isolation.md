# Tenant Isolation Verification

Status: Verified through the Milestone 06 project and context authorization conversion

Verification date: 2026-08-30

## Policy

Project-intelligence paths derive an active project membership from an authenticated alice. identity, then resolve the immutable project workspace and required project/context capability. MCP candidate capture additionally requires an active integration connection whose user, private workspace, and registered client match the verified bearer token. A caller-provided workspace, project role, context role, membership, or grant is never authorization evidence.

Migration `010_project_memberships.sql` supplies the explicit project boundary. Migration `011_context_access.sql` completes the switch of current project, context, selection, capture, review, saved-context, file, and consumption paths from originating-workspace authority to active membership plus context capability. Project-wide and all-member contexts derive access from project role. Selected-member contexts require an explicit bounded grant except for their creator; personal contexts remain creator-only. Owners do not bypass restricted context access. Ownership transfer, non-owner departure, and grant-ending member removal preserve active ownership and context history.

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
| Web | Project/context discovery | Removed members and members without a selected/personal context grant see no context identifier, name, count, freshness, file, conflict, or provenance metadata | None |
| Web | Restricted-context access management | A non-Manager, project Viewer elevation attempt, foreign grant, and guessed context/grant return non-disclosing denial | No grant, role, history, or audit mutation |
| Web | Saved context, review, and files | Context Viewer controls are read-only; members without context access receive the same not-found result as guessed identifiers | No candidate decision, exclusion, upload, scan transition, replacement, or removal |
| Web | Ownership transfer and departure | Non-Owners cannot transfer; an Owner cannot leave directly; personal or unmanaged selected contexts block departure | Transfer preserves an active Owner; departure ends grants and membership atomically |
| MCP | `list_projects` | Other project ID, name, and brief are absent | None |
| MCP | `get_project_context` | Foreign and random project IDs return the same not-found tool error | No accepted value, pending value, candidate, or evidence leaks |
| Web/MCP | Package preview and context-read receipts | Preview requires current project/context access; inaccessible explicit reads retain no foreign destination metadata; historical destination details disappear when context access ends | Preview creates no receipt; successful/failed receipts are append-only and contain no task or package content |
| MCP | `save_project_update` | Foreign and random project IDs return the same not-found tool error | Evidence, candidate, accepted-state, and audit counts do not change |
| MCP | Own accepted context | Other tenant values are absent; own pending value is excluded | None |
| Database | Evidence reference | Foreign workspace/project/connection combination is rejected | No evidence row is inserted |
| Database | Candidate reference | Foreign evidence is rejected by composite key | No candidate row is inserted |
| Database | Accepted-state reference | Foreign candidate/evidence pair is rejected by composite key | No accepted row is inserted |
| Database | Audit reference | Foreign workspace/project pair is rejected by composite key | No audit row is inserted |
| Database | Project membership | Composite project anchor and one-active-user index reject mismatches and duplication; triggers reject deletion, ended-row rewrites, and last-Owner demotion | Membership identity/history remains intact |
| Database | Project invitation | Composite project anchor, unique token digest, and one-pending-email index reject mismatches and duplication; terminal-history triggers reject rewrites/deletion | Exactly one concurrent acceptance creates one active membership |
| Database | Context access grant | Exact active membership/project/context keys, selected-context validation, and Viewer bounding reject mismatches and elevation; triggers reject identity rewrite, ended-row rewrite, and deletion | Concurrent duplicate grants create one active grant; ending preserves history |
| Database | Collaborator connection target/evidence | User-workspace connection keys and separate project-workspace context keys reject mismatched connection or project references | Evidence remains in the project workspace while connection ownership remains personal |

Project update, archive, export, permanent deletion, and file extraction paths remain absent or unfinished and therefore keep the broader milestone authorization task open. Organizations and merged/shared workspaces remain absent. The current collaboration boundary is covered by exact-recipient, non-owner, random-token, guessed-identifier, ended-member, insufficient-context-role, Owner-without-restricted-grant, project-Viewer bounding, cross-workspace collaborator connection, revoked-grant, constrained-role, and concurrent-acceptance/grant tests.

Milestone 04 adds only the authenticated workspace review dashboard and bounded project status/pagination views. Both are covered in both tenant directions; they introduce no caller-supplied workspace scope and no sharing surface.

Milestone 05 enriches the existing MCP `list_projects` and `get_project_context` paths rather than adding a new tenant path. Both-direction negative tests continue to compare foreign and guessed identifiers. In Milestone 06, project counts/freshness are aggregated only across permitted contexts; accepted provenance, question/artifact classification, conflict detection, budgeting, and omissions are computed only after context authorization. Conflict joins repeat workspace/project/context predicates across accepted state, pending candidates, and both evidence rows.

## Trusted-state controls retained

The same matrix confirms that MCP capture remains candidate-only, pending and rejected candidates remain absent from trusted context, and only the authenticated web acceptance path creates versioned accepted state. Authenticated rejection creates no trusted row, and accepted output retains the exact candidate and evidence provenance identifiers.
