# Exact Save Confirmation

Status: Implemented for the single-user Milestone 06 loop

Decision date: 2026-08-30

The 2026-09-09 project-first amendment retains one authenticated alice. `Save` action but removes visible context names, state keys, versions, hashes, identifiers, and raw JSON from the preview. See [`docs/project-first-private-alpha-redesign.md`](project-first-private-alpha-redesign.md). The older two-action flow below remains historical design evidence; the later single-action implementation in `docs/planned-host-experience.md` is the current authority until the project-first renderer lands.

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

## Planned MCP App replacement

The 2026-09-06 product-owner direction replaces this current Save/Not now interaction on supported ChatGPT and Claude surfaces with an exact alice.-controlled MCP App card containing only `Save`. Closing, ignoring, navigating away, or expiry means no save and must create no durable candidate, Needs attention item, accepted state, or file reference. The authenticated Save click remains the human authority boundary and preserves immutable evidence and provenance atomically with activation. A matching alice.-controlled web card is the fallback when a host cannot render the component.

This replacement is planned, not implemented or deployed. Until it is verified, the authority boundary and current behavior above remain the source of runtime truth. The complete planned host interaction is recorded in `docs/planned-host-experience.md`.
