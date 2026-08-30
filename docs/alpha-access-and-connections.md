# Alpha Access and AI Connections

Status: Implemented foundation for Milestone 06

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

`/connections` is authenticated and lists only the current user's OAuth connection rows. It shows the stable MCP address, client name/classification, granted scopes, connected/last-used times, and active or revoked state. It never exposes access tokens, refresh tokens, authorization codes, client secrets, host passwords, host cookies, or another user's connection status.

Revocation is an exact authenticated POST scoped by both user and workspace. It atomically revokes the connection and all associated access and refresh tokens and appends a content-free audit event. A guessed or foreign connection identifier returns the same not-found response and performs no mutation. Reconnection is a new OAuth grant made by that same user; collaboration never transfers a connection.
