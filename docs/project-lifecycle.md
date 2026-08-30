# Project Archive, Export, and Deletion Requests

Status: Implemented local foundation for Milestone 06; privileged erasure remains unimplemented

Decision date: 2026-08-30

## User-visible distinctions

The lifecycle page deliberately presents four different operations:

- remove from active context excludes one accepted entry or file reference from ordinary context use while preserving its immutable source and history;
- archive makes the whole project unavailable to ordinary project, review, file, context-package, invitation, and AI-connection paths without erasing it;
- export downloads the project data and provenance the exporting Owner is currently permitted to see; and
- a permanent-deletion request records intent after archive and starts a seven-day cancellation period, but performs no erasure.

The UI never describes an archive or request as deletion. A pending request says that PostgreSQL rows, file-object versions, security receipts, and provider backups remain present and that a separately authorized operator workflow is required.

## Archive and restore

Only an active project Owner can open the lifecycle page or submit an archive/restore action. The action is bound to an opaque SHA-256 preview version derived from the project update/archive state and active deletion request. A stale form fails without mutation.

Archive sets the project lifecycle pair, revokes every pending invitation, clears every user's active AI-connection target for the project, and appends a content-free `project_archived` audit event. Ordinary authorization begins from an unarchived project, so archived projects disappear from project/context discovery, review, capture, saved-context, file, invitation, package-read, and selectable-target paths. Only the dedicated Owner lifecycle/export boundary can still resolve them.

Restore clears the lifecycle pair and appends `project_restored`. It is blocked while a deletion request is active. Restore does not reactivate revoked invitations or recreate cleared AI-connection targets.

## Permission-filtered export

The Owner export is JSON with format `alice.project-export`, version `1`, a generation time, an explicit scope statement, project lifecycle state, membership/invitation history, bounded lifecycle actions, and permitted contexts. Each context includes its content-free history, candidate and accepted values, evidence provenance metadata/hash, removal history, and file metadata.

Context authorization is resolved before content queries. Project-wide and all-member contexts are included; restricted selected-member contexts require the exporting Owner's active explicit grant; personal contexts require the Owner to be their creator. Inaccessible contexts are not queried for content and contribute no identifier, name, description, count, freshness, candidate, provenance, file, or conflict metadata.

Raw evidence payload envelopes and caller-chosen idempotency keys are intentionally excluded. One envelope can contain candidates for more than one destination, so returning it from one permitted context could disclose another restricted destination. Per-context candidate values plus evidence identifiers, actor/client/tool provenance, payload hash, and time retain traceability without crossing that boundary.

The export also excludes object storage keys/versions, credentials, bearer/session/invitation tokens, signed URLs, and file bytes. The response is an attachment with `Cache-Control: no-store`.

## Deletion request and cancellation

Only an Owner may request deletion, and only after archive. The form requires both the current lifecycle preview and the exact project name. The request records requester, request time, and a `not_before` time seven days later. It appends `project_deletion_requested`; exact cancellation appends `project_deletion_cancelled`. Request identity and timing are immutable, cancellation is one-way, and rows cannot be deleted through the application role.

The cooling-off interval is a cancellation guard, not an erasure service-level promise. There is currently no operator that consumes the queue and no approved maximum PostgreSQL, object-version, audit/security-record, or backup erasure window.

## Database and operator boundary

Migration `013_project_lifecycle.sql` adds the project archive pair and append-preserving deletion-request queue. The constrained application role may update only project archive fields and deletion-request cancellation fields. It cannot delete projects, requests, evidence, accepted state, file objects, audit events, or security receipts, and it cannot rewrite project identity/content through this lifecycle surface.

Permanent erasure remains a separate Milestone 06 task. It requires an approved retention policy; a credential and executable unavailable to web/MCP runtime roles; an ordered dependency plan; live deletion of PostgreSQL project data and every private object version; defined treatment for security/audit records and legal holds; provider backup-expiry verification; retry/reconciliation receipts; and negative proof that ordinary roles still cannot invoke or emulate it. Until those conditions pass, alice. must not promise that a request has deleted data or name a maximum erasure window.

## Verification

SQLite web/domain coverage compares Editor and outsider lifecycle denial, verifies a stale preview cannot mutate, proves restricted/personal names and content are absent from Owner export without a grant, checks archive removal from ordinary paths, pending-invitation revocation, data preservation, exact deletion confirmation, restore blocking, one-way cancellation history, and project/request no-delete guards.

Real PostgreSQL coverage runs archive, export, request, cancellation, and restore through the constrained application role, verifies ordinary reads fail while archived, verifies data remains, and proves direct project/request rewrite and deletion attempts are denied. Privileged erasure and live provider backup/object deletion are not covered because they do not exist yet.
