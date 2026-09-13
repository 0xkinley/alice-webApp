# Project Access and Security View

Status: Implemented foundation for Milestone 06

Decision date: 2026-08-30

## Purpose

`/projects/:projectId/access` explains the current project access boundary without becoming an independent permissions source. It uses the shared project-first shell and derives every row from the same active membership and per-user connection records used by authorization. Internal context visibility and grants remain enforcement details and are not rendered.

## Audience rules

- Every active project member can see the current active project-member list.
- No internal context, audience, scope, or grant row is listed.
- A project Owner does not gain access to restricted internal records merely by opening this page.

The page links to existing project-level controls when the signed-in user already has that management capability. It creates no new grant, role, or bypass.

## Connection privacy

The connection section lists current ChatGPT and Claude status belonging only to the signed-in user. It exposes no active target or internal provider authorization. A collaborator's OAuth connection, status, tokens, credentials, and revocation state are never returned. Token protocol tables are not queried.

## Security-history projection

At most 25 recent events are selected from the project's append-only audit history after applying a fixed action allowlist. The returned projection contains only:

- a maintained human-readable action label;
- the actor's email only when that actor is the viewer or a current project member, otherwise a bounded generic label; and
- the event time.

Raw audit metadata, correlation IDs, membership/grant/connection identifiers, invitation tokens, bearer values, submitted evidence, prompts, model output, project values, and internal context details are not returned or rendered. Retained active-target events are omitted because they are private compatibility history and no longer route the private-alpha MCP flow.

## Verification

SQLite tests cover current membership, Owner non-bypass, restricted-record isolation, foreign-project denial, current-user-only connection rendering, and omission of deliberately planted token-like and evidence-like audit metadata. The two-direction current-surface matrix also compares the access page and its adjacent project, membership, invitation, review, export, archive, removal, and deletion controls against random guessed identifiers while asserting no protected row or audit-count change. Focused connection, MCP, file, and lifecycle suites complete the non-disclosure boundary. The overview query also runs under the constrained PostgreSQL application role and remains read-only.
