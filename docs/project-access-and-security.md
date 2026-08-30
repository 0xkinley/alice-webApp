# Project Access and Security View

Status: Implemented foundation for Milestone 06

Decision date: 2026-08-30

## Purpose

`/projects/:projectId/access` explains the current access boundary without becoming an independent permissions source. Every row is derived from the same active membership, context visibility, grant, and per-user connection records used by authorization.

## Audience rules

- Every active project member can see the current active project-member list.
- Only contexts the signed-in member can currently read are listed. An inaccessible selected-member or personal context contributes no name, identifier, audience, count, or security row.
- Project-wide and all-member contexts list every active member with the context role derived from the project role.
- A selected-member context lists its active creator and active explicit grants. A personal context lists only its creator.
- A project Owner does not gain visibility into a restricted or personal context merely by opening this page.

The page links to existing owner or context-manager controls when the signed-in user already has that management capability. It creates no new grant, role, or bypass.

## Connection privacy

The connection section lists active connection metadata belonging only to the signed-in user: safe client name/classification, last-used time, and a currently authorized target. A collaborator's OAuth connection, target, status, tokens, credentials, and revocation state are never returned. Token protocol tables are not queried.

## Security-history projection

At most 25 recent events are selected from the project's append-only audit history after applying a fixed action allowlist. The returned projection contains only:

- a maintained human-readable action label;
- a context name only when the event's content-free context identifier resolves to a context currently visible to the viewer;
- the actor's email only when that actor is the viewer or a current project member, otherwise a bounded generic label; and
- the event time.

Raw audit metadata, correlation IDs, membership/grant/connection identifiers, invitation tokens, bearer values, submitted evidence, prompts, model output, project values, and context descriptions are not returned or rendered. Another user's active-target changes are omitted because connection targets are private per user.

## Verification

SQLite tests cover current member and per-context audience derivation, Owner non-bypass, personal-context isolation, ended-grant removal, foreign-project denial, current-user-only connection rendering, and omission of deliberately planted token-like and evidence-like audit metadata. The overview query also runs under the constrained PostgreSQL application role and remains read-only.
