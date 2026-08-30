# Authentication and Tenancy

Status: Accepted through Milestone 06 PostgreSQL foundation

Decision date: 2026-08-27; updated 2026-08-29

## Identity decision

Milestone 03 uses first-party email and password authentication so the private-workspace boundary can be verified without coupling alice. to a deployment-specific identity provider. Email addresses are normalized to lowercase and are unique case-insensitively. Passwords are bounded to 12–1024 characters and stored only as salted `scrypt-v1` digests; plaintext passwords are neither persisted nor logged.

Milestone 06 closes public registration. Account creation requires a live, single-use alpha invitation bound to the normalized recipient email. Only the random invitation token's SHA-256 digest is persisted. Invitation acceptance is locked and committed in the same transaction as the user, private workspace, and registration audit row, so preview, cancellation, mismatched email, expiry, revocation, or concurrent reuse cannot partially provision an account.

This is an application identity boundary, not host authentication. alice. never receives or stores ChatGPT or Claude passwords. A later external identity provider can replace the credential verifier while preserving the internal user identifier and tenant model.

## Session decision

Successful registration or login issues a random 256-bit opaque web-session token. Only its SHA-256 digest is stored. The browser cookie is `HttpOnly`, `SameSite=Strict`, scoped to the application root, expires after seven days, and gains `Secure` on HTTPS origins. Logout deletes the server-side session and expires the cookie.

The current server-rendered application has no browser JavaScript and no browser-public configuration namespace. Same-site form posts and strict cookies are the current CSRF boundary. Password reset, email verification, and edge rate limiting are required before a public self-service launch but are not part of the private Milestone 03 foundation.

## Private-workspace invariant

Registration creates the user and exactly one private workspace in one immediate database transaction. `workspaces.user_id` is unique, so normal application code and the database both prevent a second workspace for the same MVP user. A failed user or workspace insert rolls back both records.

Every authenticated request resolves the workspace from the server-side user/session or OAuth subject. Caller-supplied workspace identifiers are never authorization evidence. Teams, organizations, membership tables, invitations, roles, and sharing remain deliberately absent.

Project creation accepts only a bounded name and brief. The server generates the project identifier and resolves the destination workspace from the authenticated user. Project listing and detail reads include the resolved workspace in the query, so a valid but foreign or guessed project identifier returns the same not-found response as an unknown identifier. Project names are unique only within a workspace; separate users may use the same name.

## Deny-by-default authorization policy

All project domain operations begin by resolving an immutable tenant scope from a server-authenticated internal user identifier. A missing, unknown, or malformed identity resolves to no scope. Reads then return no row (or an empty collection), and writes return no result without changing the database.

MCP writes require the stronger connection scope: the connection must be active and its user, workspace, and registered client must all match the verified bearer-token subject. A valid user identifier paired with another user's, another client's, or a revoked connection is denied before project lookup or transaction start.

The web review queue, project detail, project list, project creation, accepted-context read, candidate capture, and human acceptance, rejection, and supersession all use these shared policies. Database composite foreign keys are the second layer: tenant-owned evidence, candidates, accepted state, audit rows, and connections cannot reference an object in another workspace even if application code is faulty.

The Milestone 04 review dashboard derives its complete project list from the authenticated human's private workspace. Project queues repeat the workspace predicate across candidates, evidence, and accepted-state joins; status filters and pagination never replace tenant authorization. A foreign project identifier and a random well-formed identifier still produce the same non-disclosing response, while the workspace dashboard omits the other tenant's project and candidate counts entirely.

`docs/tenant-isolation.md` is the durable path inventory and negative-test matrix. Any future project endpoint or domain operation must be added to that matrix before its milestone can be complete.

## MCP identity binding

The OAuth authorization screen authenticates an existing alice. user and binds the authorization code, integration connection, access token, and refresh token to that internal user. Access and refresh bearer values remain one-time response secrets; only SHA-256 token digests are stored. An authenticated MCP request derives its user and connection from the verified token row, not from tool arguments.

OAuth dynamic client registration is not tenant membership. A registered host client gains access to no project until an alice. user authenticates and grants scopes through the authorization flow.

Every grant creates a separate integration connection. Revoking either bearer token revokes the complete connection and all of its access and refresh tokens, and appends a safe audit event. Connection metadata records client classification and scopes but never host passwords, host session cookies, conversation history, plaintext OAuth credentials, or bearer values.

The authenticated connection center lists and revokes only connections owned by the current internal user and workspace. Project collaboration never transfers these grants. Reconnection creates a new OAuth connection owned by the same user; guessed and foreign connection identifiers return no metadata and perform no mutation.

## Database lifecycle

The complete tenant model is migration `001_initial.sql` in PostgreSQL. Only the separately invoked migration command may create schema or apply a version. Both deployables connect with a constrained application login, verify the exact migration ledger at startup, and fail closed rather than altering schema.

Milestone 01–05 `.data/*.sqlite` files were local development fixtures, not alpha records. Milestone 06 intentionally does not import them. The testing-only SQLite adapter starts empty and remains unavailable to production configuration.
