# Authentication and Tenancy

Status: Accepted for Milestone 03

Decision date: 2026-08-27

## Identity decision

Milestone 03 uses first-party email and password authentication so the private-workspace boundary can be verified without coupling alice. to a deployment-specific identity provider. Email addresses are normalized to lowercase and are unique case-insensitively. Passwords are bounded to 12–1024 characters and stored only as salted `scrypt-v1` digests; plaintext passwords are neither persisted nor logged.

This is an application identity boundary, not host authentication. alice. never receives or stores ChatGPT or Claude passwords. A later external identity provider can replace the credential verifier while preserving the internal user identifier and tenant model.

## Session decision

Successful registration or login issues a random 256-bit opaque web-session token. Only its SHA-256 digest is stored. The browser cookie is `HttpOnly`, `SameSite=Strict`, scoped to the application root, expires after seven days, and gains `Secure` on HTTPS origins. Logout deletes the server-side session and expires the cookie.

The current server-rendered application has no browser JavaScript and no browser-public configuration namespace. Same-site form posts and strict cookies are the current CSRF boundary. Password reset, email verification, and edge rate limiting are required before a public self-service launch but are not part of the private Milestone 03 foundation.

## Private-workspace invariant

Registration creates the user and exactly one private workspace in one immediate database transaction. `workspaces.user_id` is unique, so normal application code and the database both prevent a second workspace for the same MVP user. A failed user or workspace insert rolls back both records.

Every authenticated request resolves the workspace from the server-side user/session or OAuth subject. Caller-supplied workspace identifiers are never authorization evidence. Teams, organizations, membership tables, invitations, roles, and sharing remain deliberately absent.

## MCP identity binding

The OAuth authorization screen authenticates an existing alice. user and binds the authorization code, integration connection, access token, and refresh token to that internal user. Access and refresh bearer values remain one-time response secrets; only SHA-256 token digests are stored. An authenticated MCP request derives its user and connection from the verified token row, not from tool arguments.

OAuth dynamic client registration is not tenant membership. A registered host client gains access to no project until an alice. user authenticates and grants scopes through the authorization flow.

## Database lifecycle

The Milestone 03 tenant schema is version 3 and is created only for an empty database. A Milestone 01/02 scratch database is preserved as historical spike evidence and fails closed with an explicit instruction to use a new `ALICE_DATABASE_PATH`; it is not silently rewritten or mixed with production-shaped tenant records.
