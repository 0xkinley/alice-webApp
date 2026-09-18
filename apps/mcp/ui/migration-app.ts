import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { escapeHtml, formatLocalTime, readableLabel } from "@alice/presentation";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App(
  { name: "alice-project-migration", version: "1.0.0" },
  {},
  { autoResize: true },
);
let preview: any;
let visiblePreview: any;
let authority: any;
let status: any;
let existingProjects: any[] = [];

function providerName(provider: unknown) {
  return provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "AI platform";
}

function resultText(result: any) {
  return (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join(" ");
}

const styles = `<style>
:root{color-scheme:light dark;font:400 15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--canvas:var(--color-background-primary,#070b09);--surface:var(--color-background-secondary,#0d1411);--raised:var(--color-background-tertiary,#121b17);--line:var(--color-border-secondary,#2b3a32);--ink:var(--color-text-primary,#f2f7f4);--muted:var(--color-text-secondary,#9ba9a1);--brand:#9cf0bd;--brand-ink:#06140c;--warning:#e0ad58;--danger:#ffaaa5}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}main{padding:clamp(15px,4vw,24px)}button,summary,select{font:inherit}.card{display:grid;gap:14px;max-width:680px;margin:0 auto}.topline,.destination{display:flex;align-items:center;justify-content:space-between;gap:14px}.topline{padding-bottom:13px;border-bottom:1px solid var(--line)}.brand{font-size:21px;font-weight:850;letter-spacing:-.05em}.muted{color:var(--muted)}.eyebrow{margin:0 0 5px;color:var(--brand);font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}h1,h2,h3,p{margin-top:0}h1{margin-bottom:7px;font-size:clamp(26px,6vw,38px);line-height:1.08;letter-spacing:-.04em}h2{font-size:19px}header p{margin-bottom:0;color:var(--muted)}section,.destination,.notice{border:1px solid var(--line);border-radius:15px;padding:15px;background:var(--surface)}.destination .eyebrow{margin:0}.destination strong{font-size:18px}.source{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;margin:0}.source dt{font-weight:750}.source dd{margin:0}fieldset{display:grid;gap:9px;margin:0;padding:0;border:0}legend{margin-bottom:10px;font-size:19px;font-weight:750}.select-row{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;padding:11px;border:1px solid var(--line);border-radius:11px;background:var(--raised)}.select-row input{margin-top:5px}.select-row small{display:block;color:var(--muted)}#existing-project-label{display:grid;gap:5px;font-weight:700}select{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px;background:var(--raised);color:var(--ink)}.material{display:grid;gap:10px;margin:0;padding:0;list-style:none}.material li{padding:12px;border:1px solid var(--line);border-radius:11px;background:var(--raised)}.material p{margin-bottom:6px;white-space:pre-wrap}.material small{color:var(--muted)}.trust{border-left:3px solid var(--warning)}.notice{margin:0;color:var(--muted)}.notice.danger{border-color:var(--danger);color:var(--danger)}.notice.success{border-color:var(--brand);color:var(--brand)}.counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.count{padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--raised)}.count strong,.count span{display:block}.count strong{font-size:20px}.count span{color:var(--muted);font-size:12px}button{width:100%;border:1px solid var(--brand);border-radius:999px;padding:11px 16px;background:var(--brand);color:var(--brand-ink);font-weight:850;cursor:pointer}button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #86d8ff;outline-offset:3px}button:disabled{cursor:default;opacity:.55}@media(max-width:500px){main{padding:14px}.topline,.destination{align-items:flex-start;flex-direction:column}.source{grid-template-columns:1fr;gap:2px}.source dd{margin-bottom:6px}.counts{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>`;

function scopeHeading(scope: unknown) {
  return scope === "conversation"
    ? "Create an Alice project from this chat?"
    : scope === "provider_project"
      ? "Create an Alice copy of this project material?"
      : "Create an Alice project from the supplied material?";
}

function scopeExplanation(scope: unknown) {
  return scope === "conversation"
    ? "Alice can access the supplied conversation, but no surrounding provider project context was established."
    : "The host did not provide evidence strong enough for Alice to claim that this is a complete provider project.";
}

function destinationChoices() {
  const sourceLabel =
    visiblePreview.scope?.source_scope === "conversation"
      ? "Create a project from this chat"
      : "Create a project from supplied material";
  const options = existingProjects
    .map(
      (project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`,
    )
    .join("");
  return `<fieldset><legend>Choose what Alice should create</legend><label class="select-row"><input type="radio" name="destination_action" value="create_project_from_source" checked><span><strong>${sourceLabel}</strong><small>Retain exactly the material shown below as unverified source.</small></span></label><label class="select-row"><input type="radio" name="destination_action" value="add_source_to_existing_project"${options ? "" : " disabled"}><span><strong>Add supplied material to an existing project</strong><small>${options ? "Choose one authorized project." : "No writable Alice project is currently available."}</small></span></label>${options ? `<label id="existing-project-label">Existing project<select id="target-project">${options}</select></label>` : ""}<label class="select-row"><input type="radio" name="destination_action" value="create_empty_project"><span><strong>Create an empty project</strong><small>Do not retain the supplied material.</small></span></label></fieldset>`;
}

function renderPreview() {
  const expired = Date.parse(visiblePreview.expires_at) <= Date.now();
  const material = preview.supplied_material
    .map(
      (item: any) =>
        `<li><p class="eyebrow">${escapeHtml(readableLabel(item.kind))}</p><p>${escapeHtml(item.content)}</p><small>${item.speaker ? `${escapeHtml(item.speaker)} · ` : ""}${escapeHtml(readableLabel(item.capture_state))}</small></li>`,
    )
    .join("");
  root.innerHTML = `${styles}<div class="card"><div class="topline"><strong class="brand">alice.</strong><span class="muted">From ${escapeHtml(providerName(visiblePreview.source_provider))}</span></div><header><p class="eyebrow">Migration preview</p><h1>${escapeHtml(scopeHeading(visiblePreview.scope?.source_scope))}</h1><p>${escapeHtml(scopeExplanation(visiblePreview.scope?.source_scope))}</p></header><div class="destination"><p class="eyebrow">Suggested Alice project name</p><strong>${escapeHtml(visiblePreview.alice_project_name)}</strong></div><section><h2>Source evidence</h2><dl class="source"><dt>Provider</dt><dd>${escapeHtml(providerName(visiblePreview.source_provider))}</dd><dt>Provider label</dt><dd>${escapeHtml(visiblePreview.provider_project_name || "Name not supplied")}</dd><dt>Effective scope</dt><dd>${escapeHtml(readableLabel(visiblePreview.scope?.source_scope || "unknown"))}</dd><dt>Completeness</dt><dd>${escapeHtml(readableLabel(visiblePreview.scope?.scope_completeness || "unknown"))}</dd><dt>Authority</dt><dd>Unverified host-derived data</dd><dt>Review proposals</dt><dd>${Number(visiblePreview.proposed_claim_count || 0).toLocaleString()} pending if retained</dd></dl></section><section>${destinationChoices()}</section><section><h2>Supplied material</h2><p class="muted">${visiblePreview.supplied_item_count} observed ${visiblePreview.supplied_item_count === 1 ? "item" : "items"}. This is not proof that the provider project is complete.</p><ul class="material">${material}</ul></section><section class="trust"><h2>What migration does</h2><p>The selected action is performed only after this authenticated click. Retained material stays immutable and unverified. Any cited proposals remain pending until an authenticated human accepts, edits, or rejects them.</p><p>The original ${escapeHtml(providerName(visiblePreview.source_provider))} source is not renamed, moved, edited, or deleted.</p></section><p id="migration-status" class="notice" role="status" aria-live="polite">${expired ? "This preview expired. Ask for a new migration preview." : `Nothing has been created. Preview expires ${escapeHtml(formatLocalTime(visiblePreview.expires_at))}.`}</p><button id="migrate" type="button" ${expired ? "disabled" : ""}>Continue in Alice</button></div>`;
  document.querySelector("#migrate")?.addEventListener("click", commit);
}

function count(label: string, value: number) {
  return `<div class="count"><strong>${Number(value).toLocaleString()}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderStatus() {
  const fidelity = status.fidelity;
  root.innerHTML = `${styles}<div class="card"><div class="topline"><strong class="brand">alice.</strong><span class="muted">${escapeHtml(status.status)}</span></div><header><p class="eyebrow">Migration status</p><h1>${escapeHtml(status.project.name)}</h1><p>Backend-authoritative status for the material supplied to Alice.</p></header><section><h2>${escapeHtml(readableLabel(status.status))}</h2><div class="counts">${count("Observed", fidelity.observed)}${count("Retained", fidelity.imported)}${count("Exact bytes", fidelity.exact_bytes)}${count("Content only", fidelity.content_only)}${count("References", fidelity.references)}${count("Missing", fidelity.missing)}${count("External", fidelity.external)}${count("Unsupported", fidelity.unsupported)}${count("Alice-confirmed", fidelity.alice_confirmed)}</div></section><section class="trust"><h2>Fidelity boundary</h2><p>These counts describe the supplied scope only. They do not prove complete access to the source project. Host-derived material remains unverified until a separate Alice-native confirmation.</p><p>The original ${escapeHtml(providerName(status.source.provider))} project remains unchanged.</p></section><section><h2>Add material safely</h2><p>Open the project in Alice and use Add files to select exact local files. Provider-export archives and unknown formats are not silently parsed; unrelated account history should be filtered before anything is uploaded.</p></section>${status.error_summary ? `<p class="notice danger" role="alert">${escapeHtml(status.error_summary)}</p>` : `<p class="notice success" role="status">Updated ${escapeHtml(formatLocalTime(status.updated_at))}.</p>`}<button id="open-project" type="button">Open in Alice</button><button id="refresh-status" class="secondary" type="button">Refresh status</button></div>`;
  document.querySelector("#open-project")?.addEventListener("click", async () => {
    await app.openLink({ url: status.project.url });
  });
  document.querySelector("#refresh-status")?.addEventListener("click", refresh);
}

async function commit() {
  const button = document.querySelector<HTMLButtonElement>("#migrate")!;
  const message = document.querySelector<HTMLElement>("#migration-status")!;
  button.disabled = true;
  message.textContent = "Creating the exact Alice project copy…";
  try {
    const destinationAction = (document.querySelector<HTMLInputElement>(
      'input[name="destination_action"]:checked',
    )?.value || "create_project_from_source") as string;
    const targetProject = document.querySelector<HTMLSelectElement>("#target-project")?.value;
    const result = await app.callServerTool({
      name: "alice_commit_project_migration",
      arguments: {
        preview_id: visiblePreview.preview_id,
        preview_version: visiblePreview.preview_version,
        authority_token: authority.token,
        destination_action: destinationAction,
        ...(destinationAction === "add_source_to_existing_project" && targetProject
          ? { target_project: targetProject }
          : {}),
      },
    });
    if (result.isError) throw new Error(resultText(result) || "Migration could not be created.");
    status = result.structuredContent;
    authority = undefined;
    renderStatus();
  } catch (error) {
    message.className = "notice danger";
    message.textContent =
      error instanceof Error ? error.message : "Migration could not be created.";
    button.disabled = false;
  }
}

async function loadExistingProjects() {
  try {
    const result = await app.callServerTool({
      name: "alice_workspace_snapshot",
      arguments: { view: "projects" },
    });
    existingProjects = (result?.structuredContent?.projects || []).filter(
      (project: any) => project.can_upload,
    );
    if (visiblePreview && !status) renderPreview();
  } catch {
    existingProjects = [];
  }
}

async function refresh() {
  const button = document.querySelector<HTMLButtonElement>("#refresh-status")!;
  button.disabled = true;
  try {
    const result = await app.callServerTool({
      name: "get_project_migration_status",
      arguments: {
        project_id: status.project.name,
        migration_session_id: status.migration_session_id,
      },
    });
    if (result.isError) throw new Error(resultText(result) || "Migration status is unavailable.");
    status = result.structuredContent;
    renderStatus();
  } catch (error) {
    const message = document.querySelector<HTMLElement>(".notice")!;
    message.className = "notice danger";
    message.textContent =
      error instanceof Error ? error.message : "Migration status is unavailable.";
    button.disabled = false;
  }
}

app.ontoolresult = (result: any) => {
  const incoming = result?.structuredContent;
  if (incoming?.contract_version !== "1.1") return;
  if (incoming.status === "preview_only") {
    visiblePreview = incoming;
    preview = result?._meta?.["alice/migrationPreview"];
    authority = result?._meta?.["alice/migrationAuthority"];
    status = undefined;
    if (preview && authority?.token) {
      renderPreview();
      void loadExistingProjects();
    }
    return;
  }
  if (incoming.migration_session_id) {
    status = incoming;
    renderStatus();
  }
};
app.onhostcontextchanged = ({ theme }) => applyDocumentTheme(theme);
app.onerror = (error) => {
  root.innerHTML = `${styles}<p class="notice danger" role="alert">${escapeHtml(error.message)}</p>`;
};
await app.connect();
applyDocumentTheme(app.getHostContext()?.theme);
