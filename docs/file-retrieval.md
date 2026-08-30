# Bounded Untrusted File Retrieval and PDF Suggestions

Status: Implemented locally for clean UTF-8 text, Markdown, and PDF embedded text in Milestone 06

Decision date: 2026-08-31

## Reference boundary

Consumption contract `2.2` may advertise current clean file references that the authenticated user can read in project-wide or selected-context scope. It never embeds file bytes. Selection excludes removed references, every superseded logical-file version, non-clean objects, other work contexts, and contexts the user cannot currently access. Returned metadata is bounded to the immutable reference, logical file/version, display name, verified media type, byte size, SHA-256, context scope, source host, and reference time. Storage keys, object version identifiers, credentials, signed URLs, and scanner tags remain server-side.

File references are always labelled `reference_only_untrusted`. Clean `text/plain` and `text/markdown` references advertise `read_project_file_text`; clean PDFs advertise `read_project_file_pdf_text`. Each capability field is nullable and is populated only when the MCP process has the shared private-file adapter configured. Images remain metadata-only through MCP.

## Exact text and Markdown reads

`read_project_file_text` reauthorizes the exact project, context, active membership, and required context-read capability. It re-resolves the current clean logical-file version and append-only removal state. Foreign, guessed, superseded, removed, non-clean, inaccessible, and versionless references return the same unavailable response.

The object store is called with the immutable internal key and exact object version. Before fatal UTF-8 decoding, alice. requires both the downloaded byte size and SHA-256 to match PostgreSQL metadata. The caller supplies a 2,000–32,000 UTF-8 byte budget, defaulting to 8,000, and an optional zero-based Unicode code-point offset. alice. returns the largest exact excerpt whose complete serialized JSON response fits that budget. Concatenating successful continuation pages reconstructs the exact decoded source.

## Deterministic bounded PDF extraction

`read_project_file_pdf_text` applies the same authorization, current-version, clean-scan, exact-object-version, byte-size, SHA-256, complete-response budget, and Unicode continuation rules. It uses the pinned `pdfjs-dist@6.2.108` parser and extraction contract `pdfjs_embedded_text_v1`. Extraction is serial and deterministic: page text items are joined with fixed whitespace normalization, pages are separated by two newlines, and offsets address that canonical Unicode code-point sequence.

The operation accepts at most 200 pages, 50,000 text items per page, 250,000 text items overall, and 2,097,152 canonical Unicode code points. The output reports parser/method, total/text/textless page counts, intersecting page numbers, exact excerpt SHA-256, continuation, complete JSON byte use, and omissions. Encrypted, malformed, over-limit, and unsupported PDFs fail explicitly. PDF links and embedded instructions are not followed, no rendering is exposed through MCP, and no OCR, image understanding, attachment transfer, embeddings, or model orchestration occurs. An image-only PDF therefore produces no inferred text.

These counters limit accepted work but do not provide a separate parser-process memory sandbox. Live private-alpha deployment must retain upload limits, malware scanning, runtime resource limits, dependency updates, and operational monitoring; the local parser checkpoint is not a claim that arbitrary hostile PDFs are risk-free.

## File-to-candidate suggestions

`suggest_project_updates_from_file` is registered only with private-file capability and requires `mcp:write`. Its description limits use to an explicit user request to suggest or save context from a PDF. The host supplies candidate claims plus an extraction receipt containing only the fixed extraction version, start/end Unicode offsets, and excerpt SHA-256. It cannot supply a different source excerpt, file provenance, destination outside the active target, acceptance status, or trusted state.

alice. reauthorizes the current clean PDF with write capability, fetches and integrity-checks the same immutable object version, reruns the deterministic extraction, and requires the receipt hash and range to match. The source range is limited to 12,000 code points. With an active connection target, a selected-context PDF must belong to that exact context; a project-wide PDF may feed the selected target. Without an active target, the source context is the destination. A changed, superseded, removed, guessed, foreign, inaccessible, or cross-context source fails before capture.

The server—not the host—constructs the exact evidence payload. It includes the exact excerpt and bounded provenance: reference/logical-file/version, content SHA-256, display name, source context, parser/extraction version and method, range, excerpt SHA-256, and page count. Migration `014_pdf_evidence_sources.sql` adds a one-to-one immutable relational link from the evidence event to that exact file object/reference and extraction receipt. Composite foreign keys, exact metadata checks, current-version checks, immutable triggers, and constrained-role denial prevent provenance from being detached, rewritten, or deleted.

The existing atomic capture path stores the evidence, relational file source, pending candidates, context targets, and one content-free audit receipt together. Idempotent retries can only return the complete original receipt. The tool never inserts accepted state. The alice.-controlled exact review preview labels the PDF and excerpt untrusted, shows immutable hashes/version/range, and requires the authenticated human check action before every candidate becomes active; the cross action activates nothing.

## Trust and mutation rules

All retrieved or extracted content is `untrusted_artifact` data. Malware-clean, successfully parsed, host-generated, or user-uploaded does not mean alice.-verified. Content cannot become an instruction source, expand access, select another file or context, trigger tools, or activate its own statements. Ordinary file reads create no evidence, candidates, accepted state, file lifecycle changes, or project/audit mutations. A file-suggestion call is a separately authorized explicit capture and creates pending evidence-backed candidates only.

## Verification and deferred work

SQLite integration coverage verifies strict capability-gated tools, exact deterministic extraction, complete-response budgets, no-OCR labelling, malicious instruction retention as data, read-only mutation counts, read-only OAuth denial, active-context isolation, receipt/hash mismatch denial, idempotency, superseded-reference invalidation, pending-only capture, relational provenance, review visibility, and immutable provenance guards. The real PostgreSQL suite verifies migration `014`, exact composite links, constrained-role insert, pending-only semantics, and update/delete denial. Logical backup/restore covers the new table with the rest of the schema.

This checkpoint does not implement or claim live S3/IAM/GuardDuty verification, OCR, image understanding, non-PDF binary extraction, host attachment transfer, automatic candidate generation, automatic activation, a separate PDF parser sandbox, or permanent object-version/backup erasure.
