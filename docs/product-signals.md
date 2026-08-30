# Private Alpha Product Signals

Status: Implemented for locally observable workflow signals

Decision date: 2026-08-30

## Purpose and boundary

The authenticated `Alpha signals` view helps evaluate whether alice. reduces continuity and confirmation friction without reading project content. It derives aggregates from existing tenant-bound connection metadata, immutable context-read receipts, candidate statuses, and content-free decision/repair audits. It does not add session replay or analytics-provider transmission.

The aggregation queries do not select prompts, task text, model responses, evidence payloads, candidate values or summaries, accepted values, context names/descriptions, emails, tokens, or credentials. The response contains counts, percentages, durations, booleans, and the documented observability limitation only. Each user sees aggregates for their own integration connections and captures; collaborator content and identities are not returned.

## Defined signals

- **Observed read attempts:** successful plus failed MCP context-package calls actually received by alice.
- **Read success among observed attempts:** successful package receipts divided by all received attempts. This is not called host invocation rate.
- **Cross-host reuse:** a project with successful reads from two different safe client classifications no more than seven days apart. Project identifiers are used only for grouping and are not returned.
- **Repeated weekly use:** successful reads in at least two distinct UTC weeks.
- **Save-offer completion:** exact capture receipts whose candidates are all terminal, divided by received save offers. Confirmed, cancelled, and still-pending offers remain separate.
- **Confirmation burden:** proposed entries per offer and median elapsed seconds from evidence capture to an exact aggregate confirm/cancel audit.
- **Repairs:** append-only removal audits carrying only the bounded `stale`, `contradicted`, or `wrong` classification. The optional human explanation is excluded from audit metadata and aggregation.

## Invocation-rate limitation

alice. cannot observe a conversation turn where an AI host never invokes its MCP tool. Dividing successful reads by ordinary host turns would therefore require a denominator supplied by a verified host surface or an explicit user-started workflow. Until such a privacy-safe denominator is implemented and validated per surface, the product reports received attempts and their outcomes but does not claim a host invocation rate or treat absence of a receipt as a known failure.
