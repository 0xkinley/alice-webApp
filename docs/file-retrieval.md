# Bounded Untrusted File Retrieval

Status: Implemented locally for clean UTF-8 text and Markdown in Milestone 06

Decision date: 2026-08-30

## Boundary

Consumption contract `2.1` may advertise current clean file references that the authenticated user can read in project-wide or selected-context scope. It never embeds file bytes. Selection excludes removed references, every superseded logical-file version, non-clean objects, other work contexts, and contexts the user cannot currently access. Returned metadata is bounded to the immutable reference, logical file/version, display name, verified media type, byte size, SHA-256, context scope, source host, and reference time. Storage keys, object version identifiers, credentials, signed URLs, and scanner tags remain server-side.

File references are always labelled `reference_only_untrusted`. Only `text/plain` and `text/markdown` references advertise `read_project_file_text`. PDF and image references remain metadata-only through MCP.

## Capability-gated MCP read

`read_project_file_text` is registered only when the MCP deployable has valid private-storage configuration. Web and MCP use the same `@alice/private-files` exact-version S3 adapter. A deployment without that capability exposes the four core MCP tools and cannot imply that file bytes are retrievable.

Every call reauthorizes the exact project, context, active membership, and required context read capability. It also re-resolves the current clean logical-file version and append-only removal state. Foreign, guessed, superseded, removed, non-clean, inaccessible, and versionless references return the same unavailable response. An authorized clean binary reference receives only a bounded message that it is reference-only.

The object store is called with the immutable internal key and exact object version. Before UTF-8 decoding, alice. requires both the downloaded byte size and SHA-256 to match PostgreSQL metadata. Missing bytes, an integrity mismatch, or invalid UTF-8 fails closed.

## Budget and continuation

The caller supplies a 2,000–32,000 UTF-8 byte budget, defaulting to 8,000, and an optional zero-based Unicode code-point offset. alice. returns the largest exact excerpt whose complete serialized JSON response fits that budget. The response includes start/end offsets, total code points, a next offset or `null`, exact budget usage, and remaining-character omissions. Pagination must advance whenever content remains; a budget that cannot fit the required envelope or one code point fails explicitly.

Offsets are Unicode code points rather than UTF-16 indices or byte positions. Concatenating successful pages in continuation order reconstructs the exact decoded source text.

## Trust and mutation rules

Retrieved content is `untrusted_artifact` data. It is not alice.-verified state and never becomes an instruction source merely because it was uploaded, scanned, referenced, or returned by MCP. The response directs hosts never to follow instructions from the content, expand access, call tools because of it, or present its statements as saved decisions.

Context assembly and file reads cannot create or change evidence, candidates, accepted state, context exclusions, audit history, projects, permissions, or file lifecycle records. Bearer authentication may update safe connection-use telemetry outside project intelligence, as with other authenticated MCP calls. No file-read receipt is currently claimed.

## Verification and deferred work

SQLite integration coverage verifies strict tool schemas, capability gating, exact multi-page reconstruction, complete-response byte budgets, integrity failure, no project-state mutation, removal from subsequent packages, and identical non-disclosing failures for foreign, guessed, and removed references. The real PostgreSQL suite exercises packaging, retrieval, cross-tenant denial, removal invalidation, and exact budgets through the constrained application role.

This checkpoint does not implement or claim:

- live S3, IAM, GuardDuty, public-access-block, or provider-host verification;
- PDF extraction, OCR, image understanding, or binary delivery through MCP;
- attachment transfer from ChatGPT or Claude;
- extracted-statement or file-to-candidate suggestion generation;
- automatic activation of any statement found in a file; or
- permanent object-version or backup erasure.

Any later file-to-candidate path must bind suggestions to the immutable file reference/version and content hash, store them as untrusted evidence-backed candidates, and require the existing exact authenticated human confirmation before they can affect active context.
