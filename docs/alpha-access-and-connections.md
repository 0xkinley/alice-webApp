# Alpha Access and AI Connections

Status: Project-first private-alpha connection flow implemented locally for Milestone 06

Decision date: 2026-08-30

## Invite-only registration

Self-service registration is closed. An operator creates a single-email, seven-day invitation with:

```bash
ALICE_DATABASE_URL=postgresql://alice_app:replace-me@127.0.0.1:5432/alice \
ALICE_WEB_URL=http://127.0.0.1:8788 \
npm run alpha:invite -- person@example.com
```

Only a SHA-256 digest of the random invitation token is stored. The token is bound to the normalized recipient email, expires, can be accepted once, and is locked during registration so concurrent attempts cannot create multiple accounts. A missing, expired, used, revoked, or email-mismatched invitation fails closed. Opening the registration preview does not consume it; only the successful atomic user/workspace/audit transaction does.

The one-time URL is a credential. Operators send it only to the intended recipient and must not place it in Git, support tickets, analytics, or application logs. Edge and hosting logs must redact the `invite` query value before invitations are issued externally.

## Per-user connection center

`/connections` is authenticated and contains exactly one ChatGPT row and one Claude row. A current non-revoked connection produces an accessible green light and no duplicate row; a disconnected provider shows one provider-specific Connect action. The primary page contains no active-target choice, OAuth record, receipt, or token detail.

`/connections/advanced` lists only the current user's OAuth connection records. It shows the stable MCP address, human-readable permissions, client name/classification, connected/last-used times, active or revoked state, exact revocation controls, and content-free project-read receipts. It never exposes access tokens, refresh tokens, authorization codes, client secrets, host passwords, host cookies, request authorities, or another user's connection status.

Every current ChatGPT or Claude connection receives the same permission-filtered project catalog for its alice. user. Project names are discoverable; project contents are not bulk-synchronized. A task retrieves only one exact project named or selected in the conversation, and every proposed write or attachment action names and reauthorizes that project.

## Same-session OAuth consent

The MCP authorization endpoint validates the registered redirect URI, exact resource, response type, and S256 PKCE challenge, then stores a ten-minute consent transaction under a random SHA-256 token digest. The browser returns to the alice. web origin. A valid web session supplies the account; otherwise sign-in returns to the same transaction. The web session cookie uses `SameSite=Lax` so a top-level provider authorization navigation can reuse it while cross-site POST requests still do not carry it.

The alice. consent page shows the signed-in account, provider, and readable abilities: find and read the exact project named for a task, prepare changes for human review, and stay connected until revocation. It states that project discovery is not bulk content transfer and that only the authenticated Save action may activate project information or authorize attachment transfer. No password field, OAuth state, client identifier, scope enum, PKCE value, token, or raw transaction authority is rendered as product information.

Each new connection still requires an explicit `Authorize` action. Approval binds the short-lived transaction to that web-session user. The MCP completion endpoint consumes it exactly once, atomically creates the connection and authorization code, records a content-free audit event, and redirects to the already-validated provider callback. Expiry, replay, a foreign account, or changed registered redirect fails closed and creates no connection.

Revocation is an exact authenticated POST scoped by both user and workspace. It atomically revokes the connection and all associated access and refresh tokens and appends a content-free audit event. A guessed or foreign connection identifier returns the same not-found response and performs no mutation. Reconnection is a new OAuth grant made by that same user; collaboration never transfers a connection.
