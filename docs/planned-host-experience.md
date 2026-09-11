# Planned ChatGPT and Claude Host Experience

Status: Project-first workspace and compact Alice-controlled Save selector implemented in source; import remains unimplemented; the 2026-09-11 selector/receipt amendment is not deployed

Decision date: 2026-09-06

The 2026-09-09 project-first amendment supersedes the visible project-and-context workspace described below. The replacement shows projects only, uses one hidden internal default, removes provider checkboxes and active-target selection, and keeps the single-action Save authority. See [`docs/project-first-private-alpha-redesign.md`](project-first-private-alpha-redesign.md). The context-first sections remain as dated implementation history.

## Current private-alpha host routing

Connecting alice.'s MCP to ChatGPT or Claude makes every project the authenticated alice. user can currently access discoverable on that provider. Both providers receive the same permission-filtered catalog. This availability is not a bulk sync: alice. sends project contents only after one project has been resolved for the request.

If the catalog contains one project, the host may use it automatically. If it contains several, the host uses an unambiguous project name in the conversation or asks the user which project they mean. It then retrieves only that exact project. alice. stores no active project target, and the host workspace has no `Use this project` action or connection-wide selection warning.

Every update Save, host attachment, transfer, and file-backed suggestion names one exact project. The server reauthorizes that project and resolves its internal compatibility destination. The initial tool call may create a short-lived alice. preview or transfer authority, but only the authenticated human's `Save` action can activate project information or authorize transfer. A connected provider, project mention, or read never changes trusted state.

The portable `alice_workspace_app_v3` card now presents this model directly in either connected provider. Its header shows the authoritative provider with a green light, and a single Project dropdown lists the same permission-filtered projects without repeating project cards. Choosing one displays “Now you're working in [project]”, reveals project and Add files actions, and sends a transient current-chat model-context hint; alice. does not persist an active target. Its first view welcomes the user and explains how to choose or create a project, upload files once, and request “Save this to Alice.” The compact creation form contains only Project name, optional Add files, and Create project. The card has no provider choice, internal destination, or routing warning.

Connection authorization returns from the MCP issuer to a short-lived alice. web consent transaction. It reuses a valid alice. session or returns to the same transaction after sign-in, but every new provider connection still requires an explicit human `Authorize` action. The consent view describes project discovery, exact single-project retrieval, preview-only AI writes, the authenticated Save boundary, and persistent access in plain language without rendering protocol scope names or asking for credentials at the MCP origin.

## Scope

This document records three product directions. The first is now implemented in local source; the others remain planned:

1. a conversation-aware alice. project and context workspace inside ChatGPT and Claude, including creation, provider availability, and file selection;
2. a single-action `Save` card with no `Cancel` control; and
3. an explicitly consented way to bring an existing ChatGPT or Claude project into alice.

The private-alpha participant products remain ChatGPT and Claude. Codex remains internal development and testing infrastructure rather than a participant surface.

## Historical conversation-aware project and context selection

The intended experience is:

1. The connected integration is presented as `alice.`.
2. An alice.-controlled MCP App lists only projects and work contexts the authenticated user may access.
3. The user chooses an existing project or creates a project through an explicit authenticated control.
4. The user chooses an existing work context or creates one, including its human access policy.
5. The user explicitly chooses whether the context is available to that user's separately authenticated ChatGPT connection, Claude connection, both, or neither.
6. The user selects existing scan-clean project files to reference from the context or uploads new supported files through the verified alice. file path.
7. One exact review names the project, context, human access, provider availability, and file references before the control-plane changes are applied.
8. The card clearly shows `Working in <project> → <context>` when the current connection is allowed to use that context.
9. The user continues in the normal host composer. The host retrieves that context without requiring a discovery prompt such as “can you see the project?”.

ChatGPT and Claude own their native connector menus and sidebars. alice. cannot turn those host-owned menus into its own nested project browser. The picker must therefore be an MCP App rendered in the conversation or a clearly linked alice.-controlled fallback.

The current implementation stores one active target per user and integration connection. That is independent between ChatGPT and Claude but shared by multiple conversations using the same connection. The planned design binds a selection to the exact conversation when the host supplies safe, stable conversation state. A host-supplied identifier is never accepted as authorization by itself; the authenticated alice. user, connection, project membership, context permission, and current selection version remain authoritative.

If a host does not expose a safe conversation binding, alice. must not pretend that two simultaneous conversations can hold different destinations. The fallback remains one visible connection-wide target, with an explicit warning that changing it affects future alice. calls from other conversations on that connection.

Human access and AI-provider availability are separate authorization dimensions. `Available to ChatGPT`, `Available to Claude`, both, or neither means that alice. may answer authenticated calls from the selected connection class; it does not proactively send or synchronize the context to a provider. The implementation must enforce the choice on discovery, context reads, explicit fallback reads, file-reference disclosure, file reads, captures, and attachment saves. A routing target cannot broaden a provider grant, and denied connections must not learn the context or file names, counts, identifiers, or freshness.

For the private alpha, each selected or newly uploaded file inherits the context's human access and provider availability. Per-file provider overrides are deliberately excluded: a file that needs different provider availability belongs in a different context. One immutable scan-clean object may still be referenced from multiple authorized contexts without duplicating bytes or silently broadening access. Uploading or selecting a file creates only an authorized source reference; its contents remain untrusted and do not become accepted context.

Creating a project or context, setting its access, choosing provider availability, attaching source-file references, and selecting a routing destination are explicit human control-plane actions. They do not accept AI output or change trusted project assertions. Content proposed by a host continues to require the separate exact `Save` authority described below.

The implementation was revalidated on 2026-09-07 against the current official contracts:

- OpenAI, [Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- Anthropic, [MCP Apps design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines)
- Anthropic, [Build cross-platform MCP Apps](https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility)
- MCP, [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)

### Implemented local contract

Migration `020_context_provider_authorizations.sql` stores a separate per-user, per-context, per-provider decision for `chatgpt` and `claude`. Missing rows and disabled rows deny provider access. The constrained application role can change only the enablement flag, decision version, and update time; it cannot rewrite identity or delete history. The migration backfills only contexts each existing active member could already read so the new boundary does not silently expose a restricted context.

MCP server `0.7.0` exposes one `ui://alice/workspace/v1.html` resource with the standard `text/html;profile=mcp-app` media type. `open_alice_workspace` is model-visible and read-only. Refresh, provider changes, project/context creation, destination selection, and exact scan-clean file linking are app-only tools. OpenAI's `openai/outputTemplate` alias is emitted alongside the standard `ui.resourceUri`; the browser app uses the official `@modelcontextprotocol/ext-apps` `1.1.2` bridge and no `window.openai` dependency.

The app-only human management snapshot may show contexts the signed-in human can access so that they can change provider availability. Model-visible discovery, active and explicit context reads, capture, file-reference inclusion, exact text/PDF reads, file-backed proposals, attachment paths, and cross-context file linking all reauthorize the actual ChatGPT or Claude connection against the separate provider record. Unknown MCP client classifications are not participant providers and fail closed.

Neither current standard host contract exposes a stable conversation identifier that alice. can verify server-side. The shipped local interface therefore labels routing `connection` and prominently warns that a destination change affects every conversation using that connection. Caller-supplied conversation text or identifiers are not upgraded into routing authority. A future exact-conversation mode remains capability-gated on a stable authenticated host primitive.

Project and context creation default to neither provider unless the creating surface passes the user's explicit choices. Existing pre-migration readable contexts are backfilled to preserve their already-shipped behavior. Files inherit the provider decision of every context reference: the same immutable object can be linked without copying bytes, while disclosure and reads still require both human and provider authorization for the exact reference context. The upload control opens the existing authenticated, pre-targeted, scan-gated alice. file path; it does not imply that a host exposed attachment bytes.

## Alice-controlled Save selector

When the user explicitly asks to save conversation content, a decision, a handoff, or a host attachment, the host may prepare an exact Alice selector in the same conversation. The selector names:

- the destination project;
- each exact grouped project-information outcome, complete artifact, or filename presented by the host;
- the access inherited from the destination;
- the source host and available provenance; and
- any current saved value that would be superseded.

Project-information selectors may contain up to 20 independently selectable candidate claims. The host should group related conversation turns into a small number of meaningful outcomes rather than make the user review one row per message. The selector starts with the host-presented items selected, allows the user to deselect any item, and has one decision control: `Save selected`. A complete artifact remains one selectable immutable snapshot; it is never split, summarized, or mixed with project-information claims by Alice. The selector has no `Cancel`, cross, `Not now`, or suggestion action. Closing, ignoring, navigating away, submitting no selection, or allowing it to expire saves nothing.

The selector may display the last confirmed save from the same AI connection and project as a checkpoint. That time is not a transcript cursor. Alice cannot verify that the host supplied every message since the checkpoint, because current remote MCP calls do not give Alice an authoritative conversation transcript or a stable server-verifiable message range. The UI must therefore say `host-presented project items`, not `all unsaved chats`. A long conversation is reduced by the host into bounded candidate outcomes, but Alice does not claim that a summary is complete.

Project information, artifacts, and files remain separate contracts. A host chooses which contract to invoke based on the user's request, but that classification is host-generated and not Alice-verified. A single mixed selector spanning all three is deferred until a provider supplies a trustworthy manifest/attachment primitive. This avoids making an apparently complete cross-type inventory from partial model context.

Before the authenticated Save action, the implementation may hold only the minimum short-lived preview state needed to render and validate the exact card. It must not create a durable candidate, Needs attention item, accepted-state version, file reference, or saved-context entry. Expired preview content is removed according to a documented short retention period; content-free security telemetry may be retained only if separately disclosed.

The authenticated `Save selected` click is the human authority boundary. For project information it may atomically persist immutable evidence, provenance, the selected internal candidates, and accepted versions. If the user chooses only part of the host-presented set, unselected claims and shared supporting chat text are excluded from the durable evidence payload. For an artifact, the click commits the one complete immutable snapshot. A model statement, tool call, generated field, or host confirmation cannot substitute for the Alice-controlled click because Alice cannot authenticate the user's natural-language prompt or prove that the host represented it exactly.

If a host cannot render the MCP App safely, the existing authenticated Alice-controlled web preview remains available with its exact `Save` action and no-action behavior. The compact multi-item selector is an embedded-app change only. Model-visible text must identify the exact project, number/type of host-presented items, and fallback URL so a host that ignores `structuredContent` remains usable.

### Implemented local contract

Migration `021_single_action_save_previews.sql` stores only an exact, immutable, 30-minute preview plus a SHA-256 digest of the app authority. The raw authority is returned only in tool-result `_meta` for the MCP App; it is absent from model-visible content and structured content. The initial `save_project_update` / project-information `save_to_alice` call creates no evidence event, candidate claim, Needs attention entry, accepted state, or audit event. A forged token, wrong user, expired preview, changed permission, changed destination, changed replacement value, empty selection, duplicate index, or out-of-range index fails before project state is written. Expired preview content is deleted.

Migration `025_save_confirmation_receipts.sql` adds an immutable, project-scoped receipt only inside the successful commit transaction. It records the selected item summaries, save kind, exact connection and project provenance, and saved time without storing the whole conversation or another artifact body. The app-only status lookup reauthorizes current connection access before returning the receipt; unknown, foreign, guessed, conflicting-connection, or newly inaccessible references return the same content-free `not_saved` result. A successful save deletes its short-lived preview only after the receipt exists. Reopening a saved embedded card therefore restores `Saved to Alice` and its exact destination instead of misreporting an expired preview. Website routes do not consume this receipt.

MCP server `0.8.0` serves `ui://alice/save/v1.html` through the portable MCP Apps bridge. The compact app renders the exact destination, selected summaries, and collapsed exact content/current replacements. Its only decision control is `Save selected`; there is no Cancel, cross, Not now, or suggestion control. The app-only `alice_commit_capture_save` tool consumes the exact unexpired authority and selection and atomically creates immutable evidence, selected internal candidate provenance, accepted state, and the durable receipt. The existing authenticated Alice web preview remains the non-embedded fallback and is intentionally unchanged.

Host attachments retain their separate card and no-action rule. The initial offer stores only short-lived metadata and no audit, bytes, transfer authority, file reference, candidate, Needs attention entry, or accepted state. The app-only Save/Save-all action creates immutable transfer authorization only; it is not a saved-file receipt. Exact-byte transfer and two scan-clean gates must still complete before a file reference exists. Closing, ignoring, or expiry leaves no file reference and expired undecided offers are purged. Historical decided offers and historical candidate reviews remain available for provenance, but they are not the routine project-information/artifact receipt path.

The rendered attachment path never conflates those stages. It moves from Waiting for confirmation to Waiting for transfer, Uploading, Scanning, and Available; expired or unsupported transfers say Transfer unavailable, and a failed gate says Scan failed. The fallback keeps the exact project and filename visible and asks the person to choose the file again only when the provider cannot supply its original bytes.

## Bringing an existing host project into alice.

### Feasibility boundary

This feature is feasible as an explicit import, but it cannot currently be promised as automatic MCP access to every pre-existing host project, conversation, and file.

alice.'s MCP server exposes alice. tools and data to the host. Connecting it does not, by itself, give alice. an API for enumerating the user's ChatGPT or Claude account, historical projects, complete chat history, or all project files. Current MCP App interfaces support UI, tool calls, and user-selected file handling; they are not blanket account-export permissions.

A user-supplied export produced by a provider's own account controls, when available for that account and workspace, is the safest initial ingestion source. The exact contents and restrictions of each provider export must be verified before alice. accepts it. Project files that are absent from an export must be selected and uploaded separately. alice. must not scrape a provider UI, request session cookies, automate an undocumented endpoint, or claim continuous synchronization without a documented provider API and a separate permission grant.

Official references to revalidate during discovery:

- OpenAI, [Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- Anthropic, [Export your Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data)
- Anthropic, [Manage Claude projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)

### Proposed consent flow

1. The user chooses `Import an existing project` in alice.
2. alice. explains that this is a one-time copy, not automatic synchronization, and identifies the provider and destination.
3. The user uploads a provider-generated export and any separately selected project files.
4. alice. validates and scans the archive, then shows an inventory containing only safe metadata: detected projects, conversation titles and dates, filenames, counts, and sizes.
5. The user selects the exact projects, chats, and files to import. `Select all` may be offered, but it cannot be preselected.
6. A final confirmation names the destination alice. project/context, selected counts, access, storage consequences, and deletion controls.
7. alice. imports only the confirmed items and returns an exact receipt. Re-import uses stable hashes and source identifiers where available to detect duplicates rather than silently creating copies.

Consent to one import does not authorize background synchronization, future exports, another provider, another project, or content outside the final inventory. Any future official provider API integration requires separate least-privilege authorization and revocation.

### Trust and provenance

Imported conversations and files are immutable, untrusted source artifacts. Importing them does not convert assistant output into alice.-verified decisions and does not make their contents active context.

Every imported item should preserve available provider, project, conversation, file, timestamp, source-export, and content-hash provenance. alice. may later propose bounded context entries from selected imported material, but those proposals require the same exact human Save authority as new host-generated material.

The importer must reuse the existing private-file defenses where applicable: bounded size and count limits, safe archive paths, supported compression, encryption rejection, file-signature validation, malware scanning, private object storage, permission checks, short-lived access, removal, export, and verified deletion behavior. The alpha's prohibition on sensitive, regulated, or client-confidential test data continues to apply.

## Roadmap placement

- Milestone 06 owns the conversation-aware project/context workspace, including authenticated creation, separate human-access and ChatGPT/Claude-availability choices, inherited context-file selection/upload, conversation-aware routing, and the replacement single-action Save card.
- The exhaustive seven-surface live compatibility matrix is not a Milestone 06 completion gate.
- Milestone 07 validates only the exact ChatGPT or Claude surfaces used by participants and keeps untested capabilities unadvertised.
- Milestone 07 may test demand and export feasibility for existing-project import with synthetic or non-sensitive user-supplied data.
- Full existing-project import remains unscheduled until export contents, parsing limits, granular consent, provenance, deduplication, collaboration boundaries, and deletion behavior are verified.
