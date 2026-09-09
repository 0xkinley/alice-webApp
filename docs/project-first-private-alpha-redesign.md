# Project-First Private-Alpha Redesign

Status: Approved for Milestone 06; implementation in progress

Decision date: 2026-09-09

## Purpose

alice. will present one product model to people using the web application, ChatGPT, or Claude:

> Create a project, add files, connect the AI tools you trust, work on the project, and explicitly approve anything saved back to it.

Work Context remains an internal compatibility mechanism during this milestone. It is not a product concept, destination, permission label, status, error detail, receipt field, or model-visible instruction. This decision supersedes the context-first product presentation in `docs/private-alpha-foundations.md`, `docs/work-contexts.md`, and `docs/planned-host-experience.md`. It does not delete their historical implementation evidence or weaken their authorization and provenance rules.

The visual reference for this redesign is `https://ainotes.framer.website/`. alice. adopts only its restrained dark surfaces, strong type hierarchy, thin structured grid, compact navigation, whitespace, and high-contrast controls. alice. does not copy its code, assets, content, claims, animation, or marketing structure. This decision supersedes Keel as the visual-system reference for the remaining Milestone 06 product work.

## Invariants

- Host-generated does not mean alice.-verified.
- A ChatGPT, Claude, Codex, model, or MCP call cannot directly mutate trusted project state.
- Only an authenticated human `Save` action on an alice.-controlled exact preview can activate conversation-derived project information.
- Closing, dismissing, ignoring, navigating away from, or allowing a preview to expire saves nothing.
- Evidence, accepted versions, provenance, audit history, file versions, and security receipts remain append-preserving until the separately privileged project-erasure workflow is eligible and executed.
- Project, collaborator, provider, file, and legacy-record access remains deny-by-default. A redesign may hide internal structure but may not turn hidden structure into an authorization bypass.
- File availability still requires exact bytes, type/size/hash validation, immutable storage, required security scans, an authorized project reference, and project visibility.
- Provider backup expiry for the 2026-09-09 synthetic erasure remains unverified until the restore window advances past `2026-09-16T10:03:48.640Z`. Neither this redesign nor its copy may claim completed permanent deletion before that evidence is recorded.

## Repository audit

The 2026-09-09 start-of-task audit found a clean working tree on `milestone-06-private-alpha-foundations`, exact `0/0` alignment with `origin/milestone-06-private-alpha-foundations`, and completed Milestone 05 evidence. Milestone 06 was already `In Progress`.

| Area | Current implementation | Required change |
| --- | --- | --- |
| Web shell | One shared server-rendered stylesheet, horizontal per-page navigation, large hero panels | Add an authenticated application shell with a collapsible sidebar, improved wordmark/account controls, compact navigation, responsive behavior, focus visibility, and reduced-motion support |
| Workspace home | Multiple project sections plus two Create project links and an inline name/brief form | Make the initial workspace spacious and project-first, keep one prominent Create project action, and move owned, shared, archived, and AI connection views into the sidebar |
| Project creation | Requires name and brief; the MCP App also asks for human visibility and ChatGPT/Claude checkboxes | Ask only for project name, then optionally add files; create private owner access and the hidden default internally |
| Project page | Renders project-wide and named work-context cards plus context creation | Render one shared project header followed by Change log and Files tabs; keep Add files beside the compact ellipsis menu, with Your access, owner-only Collaborators, and owner-only Archive project inside that menu |
| AI connection management | Mixes guided setup, connection records, read receipts, revocation, and project/context selection | Keep Add to ChatGPT, Add to Claude, and Copy MCP address primary; move receipts, revocation, scopes, timestamps, and diagnostics into an advanced view |
| MCP workspace | Exposes project and work-context selectors, provider checkboxes, context creation, and `<project> / <context>` confirmation | Show a welcome or authoritative active-project state, list only projects, use `Use this project`, and retain the concise connection-wide warning when exact conversation binding is unavailable |
| Save cards | Correctly require one alice. Save action, but show context names, internal state keys, versions, and JSON-formatted values | Preserve the authority transaction while rendering only the project, readable proposed content, sources, dates, and one Save control |
| File surfaces | Preserve strong transfer and scan gates, but render context destinations, hashes, opaque receipts, and internal object identifiers in several views | Keep the state machine and provenance internally; expose only readable file, project, source, date, transfer, scan, and availability states |
| Project-package preview | Renders raw deterministic JSON, internal keys, hashes, versions, and identifiers | Replace it with a shared readable renderer while retaining the exact structured package internally for MCP and deterministic verification |
| OAuth | Uses alice. branding but always asks for credentials at the MCP origin | Route authorization through a short-lived alice. consent transaction that reuses a valid web session and still requires explicit authorization for each new host connection |
| Durable docs | Several documents still describe the superseded two-action Save flow or context-first product | Update each contract as its corresponding implementation phase lands; retain dated historical evidence rather than rewriting it |

The audit also found that user-facing terminology is not isolated to templates. Work-context names and identifiers flow through project listing, active-target selection, provider authorization, context packages, save previews, attachment offers, file routes, access views, tests, evaluations, and MCP tool descriptions. A copy-only change would be unsafe and incomplete.

## Internal project-default compatibility decision

### Explicit default mapping

A versioned PostgreSQL migration will add an explicit project-to-default-context mapping. The mapping is internal and is never serialized into user-facing or model-visible content.

New projects create exactly one hidden default context and designate it in that mapping. They do not create a visible `General`, `Project-wide`, research, feature, or other named context. The hidden default is used for new files, saved updates, permissions, AI retrieval, capture, review, removal, export, archive, and erasure. Project creation stores an empty internal brief until project description editing is separately admitted; the creation form does not ask for a brief.

Product-owner correction on 2026-09-09 makes the creation contract exact: Project name, optional Add files, and Create project are the only controls. The web and shared ChatGPT/Claude embedded form must not request human/provider options or any brief. A host-created project authorizes the currently authenticated provider internally; the ordinary web path retains the existing deny-by-default provider state. Project lists, detail views, invitations, review summaries, confirmation data, exports, and model-visible packages omit the legacy brief field.

Product-owner correction later that day extends the project-first shell to every ordinary authenticated web destination. Project access and collaborator pages render the same sidebar, project header, provider state, Add files action, ellipsis menu, and Change log / Files tabs as the project landing page. The access view presents only project membership, the signed-in user's AI connections, and security activity; it never renders the legacy project-wide or `General` records, work-context roles, context names, or context access links. File records, replacement, text preview, removal, review queues, exact Save previews, saved-information repair/removal, package preview, usage signals, invitation confirmations, and archived-project management use the authenticated application shell instead of the pre-redesign standalone layout. Old context-addressed Files, Saved information, and context-access GET routes authorize first and then redirect to the corresponding project-level surface without exposing a context identifier in the final URL. Active-project archive compatibility links return to the project because the ellipsis confirmation is the only ordinary archive entry point; already archived projects retain restore, export, and deletion-request management in the new shell.

The hidden default uses project membership as its human-access boundary. A new project has one Owner and no collaborators, so it is private to its creator. Adding a collaborator later is the only ordinary way to broaden human project access. Per-user ChatGPT and Claude authorization remains separate from human membership.

### Legacy projects and records

Migration must not rename, move, rewrite, merge, or delete an existing context, candidate target, accepted entry, file reference, grant, active-target history row, provider-authorization row, evidence event, or audit event. Each existing project receives a new empty hidden default mapping for future writes; legacy rows remain attached to their original internal contexts.

Project-level reads may assemble legacy information only after rechecking the requesting human's current project/context capability and, for MCP, that exact connection owner's current provider authorization for each source context. A hidden project presentation never makes an inaccessible selected-members or personal record discoverable. Counts, freshness, filenames, provenance, and conflict existence from an inaccessible source remain undisclosed.

Legacy current values are resolved without silent merging:

1. A value explicitly saved to the hidden project default through the new exact Save flow is the current project-level value.
2. When no hidden-default value exists and all permitted legacy current values for a state key are byte-equivalent after canonical JSON serialization, alice. may render one value with all internal provenance retained.
3. When permitted legacy current values disagree, alice. does not choose a winner. It renders a readable project-level Needs Attention item without legacy context names and excludes every alternative from the normal trusted-decision section until a human reviews the alternatives and explicitly saves the project-level resolution.
4. Conflicting or inaccessible legacy values are never overwritten as part of compatibility resolution. Export and history retain the original scoped provenance subject to the requesting user's existing authorization.

Current, scan-clean legacy file references may appear in the project file view only when the same per-reference human and provider checks pass. Duplicate immutable objects may be presented once, but every underlying reference and authorization boundary remains intact. No hash lookup or deduplication result is exposed.

### Routing and provider authorization

The visible active selection is a project. Internally, new capture and file operations resolve that project to its hidden default. Existing active targets are migrated to their project's hidden default through a recorded content-free compatibility event; their legacy context rows and history are left unchanged.

`Use this project` is an explicit connection-scoped human action. For the current provider only, it may atomically enable that user's project-default provider authorization and commit the active project target. It never enables the other provider, never changes a collaborator's connection, and never authorizes an inaccessible legacy source. The selected value is shown as active only after the server commits the expected-version-checked change.

When the host does not provide a stable, server-verifiable conversation identity, the UI says that the choice affects every conversation using that connection. alice. does not trust a caller-supplied conversation label or identifier as routing authority.

## Human-readable rendering contract

One shared rendering contract maps internal structured values into bounded, escaped user-facing content for the web application and both MCP Apps.

- Human labels replace state keys; raw state keys remain internal.
- Strings render as paragraphs; booleans and numbers as labelled values; arrays as lists; flat records as definition lists or tables; nested records as titled sections.
- Long content may use `View exact content`, but its expanded form remains readable and never becomes a JSON dump.
- Internal IDs, hashes, storage keys/versions, selection versions, preview authorities, correlation values, and raw audit metadata are never displayed.
- Exactness continues to be verified against the underlying immutable payload, not against a lossy display transformation.
- Sources render as title, source link or filename, relevant publication/posting date when supplied, retrieval date, and the claims supported. Unsupported or missing fields are omitted rather than invented.
- Model-visible text uses project names and readable status only. Structured protocol fields may retain bounded identifiers when required for follow-up tool calls, but no internal context name or context concept may appear in model-visible descriptions, text, or user-rendered cards.

The project Change log is the first web adoption of this contract. It aggregates only legacy destinations the current user may access, deduplicates the same underlying proposal, and orders entries by their effective event time. State keys become human labels; strings, values, lists, and records render as semantic prose and fields rather than JSON. HTML elements and Markdown presentation markers supplied inside values are removed before the remaining text is escaped. Each entry identifies its recorded host classification, such as ChatGPT or Claude, while internal receipts, hashes, versions, context names, and identifiers remain hidden. Immutable UTC instants stay authoritative in `datetime`; the browser renders those instants in the current user's locale and time zone.

## Web experience contract

The authenticated shell contains a collapsible sidebar with Your Projects, Shared with You, Archived Projects, and AI Connections. The header contains the formatted `alice.` wordmark, signed-in account, and sign-out control. Desktop and mobile layouts use the same hierarchy.

The empty workspace has one prominent `Create project` action. Project creation asks for a name and offers an optional Add files action. Add files opens the browser's file chooser in place; it does not submit the form, create a project, or navigate to the separate file-management page. Selected filenames return to the creation form, and the exact files are uploaded through the existing private scan-gated path only after Create project creates their destination.

Every ordinary project view reuses one project header. The project name and signed-in user's provider status remain at the top. Add files sits in the provider-status row, below the project description, while one compact ellipsis menu remains at the upper right and contains Your access and, for Owners, Collaborators and Archive project. Add files opens the native chooser on the current page, sends the selected files through the existing private scan-gated upload path, and opens Files only after the bytes have been received; it does not expose or navigate through an internal context destination. Immediately beneath the header, two ordered navigation tabs provide Change log and Files. The selected destination is visibly and accessibly current on its page. The Files tab does not repeat a second upload panel because the shared header action is always available there. The former large destination cards and separate Back to project headers are removed. Archive project submits directly from the ellipsis menu only after a concise browser confirmation asks whether the Owner is sure; confirming archives and returns to Archived Projects, while cancelling changes nothing. The friendly `/archive` route remains for direct archived-project management and the older lifecycle route remains a compatibility alias only.

Within the shared status row, provider states stay grouped on the left and Add files aligns to the far end of the available line.

Project cards and project pages show provider-specific active states derived from the signed-in user's committed connection targets: Active in ChatGPT, Active in Claude, or Active in ChatGPT and Claude. Pending form values are not styled as active.

## ChatGPT and Claude contract

When alice. opens without a selected project, the card says:

> Welcome to alice.<br>
> Create a project or choose where you want to work.

It provides Create project and Choose project actions plus these examples: `Open alice.`, `Create a project.`, `Add this file to my project.`, and `Save this.` The card does not repeat a full welcome after a committed project is available in the current app session.

After selection, it says `Working in: <project name>` and `Active in ChatGPT` or `Active in Claude`. The picker contains no provider checkbox and no context selector. Its commit action is `Use this project`. A connection-wide warning remains visible when exact conversation binding is unavailable.

Natural `save this` requests target the latest relevant conclusion. More specific scopes remain distinct: a request to save one response verbatim and summarize earlier responses cannot be collapsed into one generic summary. Rejected or superseded ideas are excluded. The host response surrounding a preview uses time-neutral copy: `Review the alice. card above. Nothing is stored unless you choose Save.` The card itself becomes the authoritative saved or transfer state after the action.

## File state contract

Attachment awareness, transfer authorization, bytes received, scanning, and project availability are different events. User-facing states are Waiting for transfer, Uploading, Scanning, Available, Transfer unavailable, and Scan failed.

The Save click on an attachment card authorizes a later transfer and does not say `Saved`. `File saved` or `Available` appears only after alice. has received the exact bytes, validated type/size/hash, stored the immutable object, passed every required private-file security gate, created the authorized project reference, and made it visible in the project.

If an exact host surface cannot transfer original bytes, the same card opens an alice.-controlled browser fallback with the project locked, the expected filename visible, no internal context UI, and an explanation that the file must be selected again. Claude's observed offer-only behavior is a real failing native-transfer case until retested. ChatGPT must receive the same dated synthetic test before a native-transfer claim.

## OAuth and connection contract

alice.-controlled screens use the product name `alice.`. Provider-controlled connector names or dialogs are documented as external limitations when they cannot be changed.

The primary AI Connections view contains exactly one ChatGPT row and one Claude row. A provider with no current non-revoked connection shows `Connect ChatGPT` or `Connect Claude`. A provider with at least one current non-revoked connection shows only its provider name and a green connected light; duplicate connection records do not create duplicate provider rows. Technical connection records, MCP address details, active-target controls, content-free read receipts, and revocation stay in the separate advanced view.

The OAuth authorization endpoint will create a bounded, short-lived transaction and continue at the alice. web origin. A valid alice. web session supplies the account identity; otherwise the user signs in and returns to the same transaction. The consent view still requires an explicit Authorize action for every new ChatGPT or Claude connection and shows the account plus readable `Read projects` and `Propose updates` permissions. Authorization code, PKCE challenge, host state, tokens, and transaction authority remain server-side or hash-only as appropriate. The callback must render or redirect to one unambiguous completed state.

## Sequenced implementation plan

Every completed phase receives focused tests, a `MILESTONES.md` update, and its own commit. No AWS or provider-account mutation occurs before all three local visual checkpoints and the full local verification gate pass.

1. Record this approved product decision, repository audit, compatibility approach, and milestone checklist.
2. Build the shared visual tokens and authenticated collapsible application shell. Redesign the workspace home and stop for visual checkpoint 1.
3. Redesign project creation and the project page, including the project menu, badges, project-level file/saved-information entry points, and provider-specific active indicators. Stop for visual checkpoint 2.
4. Remove Work Context terminology and internal destinations from every remaining web route, copy module, error, status, receipt, access view, and disclosure without changing authorization.
5. Add the versioned hidden project-default migration and domain routing layer. Preserve legacy source scope, conflict behavior, provenance, provider authorization, erasure dependencies, and negative tests.
6. Redesign the portable MCP workspace for the welcome, project-only picker, `Use this project`, authoritative active state, and connection-wide fallback warning.
7. Implement and adopt the shared human-readable renderer for project-package previews, Save previews, file previews, review/history surfaces, and both MCP Apps.
8. Update conversation Save scope/provenance handling and post-Save status while preserving the exact authenticated authority transaction. Redesign the MCP Save card and stop for visual checkpoint 3.
9. Repair provider-neutral attachment state presentation and the exact preselected browser fallback. Add synthetic ChatGPT and Claude transfer-path tests without using personal files.
10. Simplify the primary AI Connections view, move technical records/receipts/revocation into an advanced view, and implement same-session OAuth consent reuse.
11. Update schemas, deterministic evaluations, product/architecture/MCP/permission/file/save/host/deployment documents, and all regression coverage.
12. Run formatting, linting, typechecking, web and MCP builds, secret scanning, deterministic evaluations, fast tests, real PostgreSQL and migration tests, responsive rendering, keyboard/focus/reduced-motion checks, and authorization/non-disclosure suites.
13. Present the complete local result for approval. Only after approval may a separately reviewed deployment and fresh synthetic ChatGPT/Claude runs occur.
14. Record dated hosted and provider evidence without secrets or personal file contents. Keep Milestone 06 open until provider-backup expiry and every remaining success criterion are verified.

## Required local acceptance evidence

- No user-facing or model-visible `Work Context`, `General`, research-context, `project/context`, or `<project> / <context>` wording remains.
- No user-facing preview or status view renders raw JSON, internal state keys, opaque identifiers, hashes, storage identifiers, or internal context names.
- New projects create one hidden default mapping and all new project activity resolves through it.
- Legacy entries and files remain retrievable only within their prior human and provider authorization boundaries; divergent legacy values cannot be silently selected or merged.
- ChatGPT and Claude project selections are independent, expected-version checked, and reflected only after commit.
- One alice. Save action remains the only authority that activates conversation-derived project information.
- Ignored/closed/expired previews produce no evidence, candidate, accepted state, file reference, or misleading durable analytics event.
- File availability is impossible before exact-byte validation, immutable storage, clean security gates, authorization, and reference creation.
- Cross-user, cross-project, non-member, insufficient-role, restricted-legacy, revoked-connection, and provider-disabled requests disclose no protected content or metadata and make no mutation.
- The web and MCP interfaces pass desktop/mobile rendering, keyboard navigation, focus visibility, contrast, and reduced-motion checks.
