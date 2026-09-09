# Authentication and Tenancy

Status: Accepted through Milestone 06 PostgreSQL foundation

Decision date: 2026-08-27; updated 2026-08-30

## Identity decision

Milestone 03 uses first-party email and password authentication so the private-workspace boundary can be verified without coupling alice. to a deployment-specific identity provider. Email addresses are normalized to lowercase and are unique case-insensitively. Passwords are bounded to 12–1024 characters and stored only as salted `scrypt-v1` digests; plaintext passwords are neither persisted nor logged.

Milestone 06 closes public registration. Account creation requires a live, single-use alpha invitation bound to the normalized recipient email. Only the random invitation token's SHA-256 digest is persisted. Invitation acceptance is locked and committed in the same transaction as the user, private workspace, and registration audit row, so preview, cancellation, mismatched email, expiry, revocation, or concurrent reuse cannot partially provision an account.

This is an application identity boundary, not host authentication. alice. never receives or stores ChatGPT or Claude passwords. A later external identity provider can replace the credential verifier while preserving the internal user identifier and tenant model.

## Session decision

Successful registration or login issues a random 256-bit opaque web-session token. Only its SHA-256 digest is stored. The browser cookie is `HttpOnly`, `SameSite=Strict`, scoped to the application root, expires after seven days, and gains `Secure` on HTTPS origins. Logout deletes the server-side session and expires the cookie.

The current server-rendered application has no browser JavaScript and no browser-public configuration namespace. Same-site form posts and strict cookies are the current CSRF boundary. Password reset, email verification, and edge rate limiting are required before a public self-service launch but are not part of the private Milestone 03 foundation.

## Private-workspace invariant

Registration creates the user and exactly one private workspace in one immediate database transaction. `workspaces.user_id` is unique, so normal application code and the database both prevent a second workspace for the same MVP user. A failed user or workspace insert rolls back both records.

Every authenticated request resolves the user and private workspace from the server-side session or OAuth subject. Caller-supplied workspace identifiers are never authorization evidence. Migration `010_project_memberships.sql` adds explicit project memberships without merging private workspaces: each project remains anchored to one workspace, and each collaborator remains a separate alice. user with separate sessions and AI connections.

Project creation accepts only a bounded project name. It never requests or requires a brief. The legacy non-null database column is retained for backwards compatibility, receives an empty string for every new project, and is excluded from application, MCP, summary, confirmation, and export contracts. The server generates the project identifier and resolves the destination workspace from the authenticated user. Subsequent project reads and writes resolve the project workspace only after proving an active project membership with the required capability. The workspace remains a stable data anchor, not evidence that its user can bypass membership or context permissions. A foreign, removed, or guessed project identifier returns the same not-found response as an unknown identifier. Project names are unique only within a workspace; separate users may use the same name.

Every project insert automatically creates its originating Owner membership. Owners may issue an expiring Editor or Viewer invitation to one normalized email. Only a SHA-256 token digest is stored, and only the signed-in exact recipient can see the project preview and accept or decline. A signed-out invitation request does not copy the token into a login redirect; the user signs in and reopens the original link. Revocation and replacement invalidate old links. An accepted collaborator can discover the project and only the contexts permitted by the context policy.

Non-owner role changes and removals require a current Owner membership and preserve the ended row plus safe audit history. Ownership transfer first promotes the selected active member to Owner and only then demotes the actor to Editor in the same transaction. A non-owner may leave, and an Owner must transfer ownership first. Departure atomically ends active context grants and membership; it is blocked while the member owns an active personal context or would leave a selected-members context without another explicit Manager. The database denies membership deletion, terminal invitation rewrites, ended-membership rewrites, incompatible membership downgrades, and demotion of the last active Owner.

Migration `011_context_access.sql` defines the active collaboration boundary. Project-wide and `all_members` contexts derive Viewer, Editor, or Manager behavior from the project role. `selected_members` contexts require an explicit Viewer, Editor, or Manager grant, except that the active creator is an implicit Manager. `personal` contexts are visible only to their active creator. A project Owner does not automatically see or administer a restricted or personal context. Project Viewers can receive only context Viewer access and cannot mutate project state. Context grant identity and ended history are immutable, deletion is denied, and all grant changes append safe context and audit history.

## Deny-by-default authorization policy

All project domain operations begin with a server-authenticated internal user identifier, then require an active project membership and the action's project capability. Context operations additionally require a permitted context and the action's context capability. A missing, unknown, malformed, removed, or insufficient principal resolves to no scope. Reads then return no row (or an empty collection), and writes return no result without changing the database.

MCP writes require the stronger connection scope: the connection must be active and its user, workspace, and registered client must all match the verified bearer-token subject. A valid user identifier paired with another user's, another client's, or a revoked connection is denied before project lookup or transaction start.

The web review queue, project detail and list, work-context discovery and creation, active target, saved-context lifecycle, file metadata and bytes, candidate capture, context assembly, and human acceptance, rejection, supersession, and removal all use these shared policies. Database composite foreign keys are the second layer. A collaborator's integration connection remains anchored to that user's private workspace while its active target and evidence identify the separate project workspace explicitly, so cross-workspace collaboration never weakens connection ownership or project data integrity.

The review dashboard derives its project list from active Owner or Editor memberships. Each queue filters candidates through the target context's write capability before computing counts or pagination; status filters never replace authorization. A foreign, restricted, or random well-formed identifier produces the same non-disclosing response, and project discovery computes accepted counts and freshness only from contexts visible to that user.

`docs/tenant-isolation.md` is the durable path inventory and negative-test matrix. Any future project endpoint or domain operation must be added to that matrix before its milestone can be complete.

## MCP identity binding

The OAuth authorization screen authenticates an existing alice. user and binds the authorization code, integration connection, access token, and refresh token to that internal user. Access and refresh bearer values remain one-time response secrets; only SHA-256 token digests are stored. An authenticated MCP request derives its user and connection from the verified token row, not from tool arguments.

OAuth dynamic client registration is not tenant membership. A registered host client gains access to no project until an alice. user authenticates and grants scopes through the authorization flow.

Every grant creates a separate integration connection. Revoking either bearer token revokes the complete connection and all of its access and refresh tokens, and appends a safe audit event. Connection metadata records client classification and scopes but never host passwords, host session cookies, conversation history, plaintext OAuth credentials, or bearer values.

The authenticated connection center lists and revokes only connections owned by the current internal user and workspace. Project collaboration never transfers these grants. Reconnection creates a new OAuth connection owned by the same user; guessed and foreign connection identifiers return no metadata and perform no mutation.

## Database lifecycle

The complete tenant model is migration `001_initial.sql` in PostgreSQL. Only the separately invoked migration command may create schema or apply a version. Both deployables connect with a constrained application login, verify the exact migration ledger at startup, and fail closed rather than altering schema.

Milestone 01–05 `.data/*.sqlite` files were local development fixtures, not alpha records. Milestone 06 intentionally does not import them. The testing-only SQLite adapter starts empty and remains unavailable to production configuration.
