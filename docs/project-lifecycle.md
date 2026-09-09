# Project Archive, Export, and Deletion Requests

Status: Hosted active-data erasure verified for Milestone 06; provider-backup expiry remains unverified

Decision dates: 2026-08-30, 2026-09-01, and 2026-09-09

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

Only an Owner may request deletion, and only after archive. The form requires both the current lifecycle preview and the exact project name. The request records requester, request time, and a `not_before` time seven days later. It appends `project_deletion_requested`; exact cancellation appends `project_deletion_cancelled`. Request identity and timing are immutable, cancellation is one-way, and rows cannot be deleted through the application role. Once the privileged operator commits a prepared receipt, cancellation is rejected because exact object-version deletion may already have started; a prepared run must be reconciled to completion.

The cooling-off interval is a cancellation guard. The working private-alpha policy schedules a manually approved operator run no later than seven days after `not_before`, so active PostgreSQL and S3 data should be removed no later than 14 days after the request. This maximum must not be promised to testers until the hosted operator and provider-backup behavior pass their live proof.

## Private-alpha retention policy

- An active deletion request remains cancellable for seven days. Cancellation before `not_before` prevents erasure.
- During the invite-only alpha, an operator reviews eligible requests and should remove active PostgreSQL rows and exact private S3 object versions within seven additional days. PostgreSQL deletion and S3 reconciliation are one operator workflow, not separate user-visible states.
- Aurora automated backups are retained for seven days. Active-data erasure records the calculated backup-expiry time; therefore request data may remain recoverable in provider backups for at most 21 days after the request if the operator meets the active-data window. Provider expiry still requires live verification.
- Do not create a manual database snapshot containing alpha data unless its owner and deletion date are recorded. A retained or replacement snapshot is not automatically erased by the project operator and blocks a complete deletion promise until separately removed or expired.
- Project-scoped audit events, read/security receipts, invitations, memberships, evidence, accepted state, candidates, contexts, host-file save offers/decisions/transfer receipts, upload intents, and file references are active project data and are deleted with the project. The operator retains only a content-free, pseudonymous erasure receipt: fingerprints, safe counts, timestamps, manifest hash, and calculated provider-backup expiry. It contains no project identifier after completion and is append-preserving for operational accountability.
- An immutable file object's bytes are deleted only when the target project is its last project reference. If another authorized project still references the same bytes, the object remains; all target-project references and provenance associations are removed.
- Collaborator removal revokes that collaborator's access immediately but does not erase the shared project. Account-wide erasure is a separate, currently unimplemented workflow; a project request covers only the named project.
- The friend alpha has no ordinary legal-hold feature. If a legal obligation or active security incident requires preservation, alice. must suspend the affected erasure, document the authority and scope outside ordinary runtime roles, and notify the requester before relying on any deletion timeline.

## Database and operator boundary

Migration `013_project_lifecycle.sql` adds the project archive pair and append-preserving deletion-request queue. Migration `016_project_erasure_jobs.sql` adds the privileged operator's prepared/completed reconciliation receipt. Migration `017_host_file_save_offers.sql` adds immutable project-scoped host-file offers and decisions to the erasure dependency set. The constrained application role may update only project archive fields and deletion-request cancellation fields. It has no access to erasure receipts and cannot delete projects, requests, evidence, accepted state, file objects, host-file receipts, audit events, or security receipts, or rewrite project identity/content through this lifecycle surface.

The local operator is a two-phase `preview`/`execute` command unavailable to web and MCP roles. It validates exact opaque project/request identifiers, archive state, the active request, and cooling-off completion; inventories bounded exact S3 versions and delete markers; and returns only safe counts plus an opaque preview token. Execute requires that exact token, locks the project and deletion-request rows in the same order as lifecycle cancellation, takes per-object advisory locks, rechecks the plan, deletes and reconciles eligible S3 versions, deletes the explicitly ordered PostgreSQL dependency set, and commits a terminal pseudonymous receipt. A cancellation that commits first makes execution ineligible; after preparation, a database trigger rejects late cancellation. Shared objects remain when another project references them. A prepared receipt survives a partial S3 failure so an exact retry can reconcile without restoring already-erased bytes; a completed receipt makes replay read-only.

The AWS template keeps this executable in a separate immutable image and a temporary private Fargate task. It receives the database owner secret, bounded version-list/delete permission on the one private bucket, and no public route. Exact project/request identifiers and the preview token are supplied only as one-task environment overrides, never persisted in CloudFormation. The temporary role, task definition, cluster, endpoints, security group, and log group must be removed immediately after the bounded run. The 2026-09-09 hosted proof verified one exact preview and execution, PostgreSQL and S3 active-data reconciliation, ordinary-path non-disclosure, unrelated-data retention, and complete temporary-resource cleanup. Observed Aurora backup expiry remains open; until it passes, alice. must not claim that the hosted request has completed permanent deletion.

## Verification

SQLite web/domain coverage compares Editor and outsider lifecycle denial, verifies a stale preview cannot mutate, proves restricted/personal names and content are absent from Owner export without a grant, checks archive removal from ordinary paths, pending-invitation revocation, data preservation, exact deletion confirmation, restore blocking, one-way cancellation history, and project/request no-delete guards.

Real PostgreSQL 17 coverage runs archive, export, request, cancellation, and restore through the constrained application role, verifies ordinary reads fail while archived, verifies data remains, and proves direct project/request rewrite, host-file receipt rewrite/deletion, erasure-receipt access, and deletion attempts are denied. The privileged test erases every version of one unshared object, retains a shared object and unrelated project, removes project-scoped rows including host-file receipts, simulates interruption after object deletion, completes from the prepared receipt, and proves terminal replay is safe. Focused S3 tests verify exact-key prefix filtering, version/delete-marker deletion, and zero-version reconciliation. All 19 PostgreSQL tests pass locally. The 2026-09-09 hosted proof removed one exact immutable object version plus 21 dependency rows, reconciled zero residuals across 28 project-scoped tables, retained unrelated object versions, and returned the stack to its 32-resource baseline. Aurora automated-backup expiry remains unverified until its restore window advances past the active-data deletion time after `2026-09-16T10:03:48.640Z`.
