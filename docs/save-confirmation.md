# Exact Save Confirmation

Status: Implemented for the single-user Milestone 06 loop

Decision date: 2026-08-30

## Authority boundary

`save_project_update` remains a candidate-only MCP operation. It stores immutable evidence and pending candidate claims, returns a receipt, and cannot accept, supersede, reject, or otherwise activate project context. Its review URL now names the immutable evidence identifier and opens the smallest alice.-controlled confirmation page for that exact capture.

`suggest_project_updates_from_file` uses the same candidate-only authority. Its evidence additionally carries server-generated exact PDF reference/version/content hash, extraction contract/range, excerpt hash, and source text, backed by an immutable relational source row. The preview labels that PDF evidence untrusted and exposes the provenance before the proposed entries. Successful extraction or capture does not check the confirmation box and cannot activate a statement.

Only an authenticated alice. web session can decide the preview. The page names the destination project, work context, access mode, source host, capture time, exact proposed state keys/values/summaries, deliberately included source material, and any current saved version that will be replaced. Host text, tool arguments, and model-generated confirmation fields cannot invoke either decision operation.

## One-decision transaction

One `✓ Save these entries` action accepts every still-pending candidate from the evidence event in one database transaction. State-key advisory locks are acquired in stable order; accepted versions, immutable context mappings, candidate transitions, per-entry human-review audits, and one capture-confirmation audit either all commit or all roll back. Replacement is allowed only when the exact preview showed the current context-specific version; earlier versions and provenance remain immutable history.

One `× Not now` action marks every still-pending candidate in that exact capture rejected in one transaction. It creates no accepted state and performs no activation. The cancellation and per-candidate rejection audits share one correlation identifier.

## Exactness, races, and fallback

The form carries an opaque SHA-256 preview version over the immutable evidence hash, destination, every candidate's exact content/status, and current accepted versions. Missing, changed, previously decided, stale, or concurrently submitted previews fail closed. PostgreSQL candidate row locks ensure that two simultaneous confirmations produce one complete winner and one conflict rather than a partial or duplicate activation.

The authenticated Needs attention queue links every candidate back to its exact capture preview, so the flow does not depend on a host rendering a native interactive component. Foreign and guessed evidence identifiers return the same not-found response, reveal no project/context/candidate metadata, and cannot confirm or cancel anything.
