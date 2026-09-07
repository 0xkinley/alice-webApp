import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "alice-workspace", version: "1.0.0" }, {}, { autoResize: true });
let snapshot: any;

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function accessLabel(value: string) {
  return (
    {
      all_members: "All project members",
      selected_members: "Selected project members",
      personal: "Personal draft",
    }[value] || value
  );
}

function resultText(result: any) {
  return (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join(" ");
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(resultText(result) || "The alice. action failed.");
  return result.structuredContent;
}

function announce(message: string, tone = "") {
  const status = document.querySelector<HTMLElement>("#status");
  if (!status) return;
  status.textContent = message;
  status.className = tone ? `notice ${tone}` : "notice";
}

function selectedProject() {
  const id = (document.querySelector<HTMLSelectElement>("#project")?.value || "").trim();
  return snapshot?.projects.find((project: any) => project.id === id);
}

function selectedContext() {
  const project = selectedProject();
  const id = (document.querySelector<HTMLSelectElement>("#context")?.value || "").trim();
  return project?.contexts.find((context: any) => context.id === id);
}

function renderContextDetails() {
  const project = selectedProject();
  const context = selectedContext();
  const details = document.querySelector<HTMLElement>("#context-details");
  if (!project || !context || !details) return;
  const currentFiles = context.current_files.length
    ? context.current_files
        .map(
          (file: any) =>
            `<li><strong>${escapeHtml(file.display_name)}</strong><span>${escapeHtml(file.media_type)} · ${file.byte_size.toLocaleString()} bytes</span></li>`,
        )
        .join("")
    : '<li class="empty">No scan-clean files are active here.</li>';
  const availableFiles = project.file_library
    .map((file: any) => {
      const destination = file.destinations.find((item: any) => item.id === context.id);
      if (!destination) return "";
      return `<li><span><strong>${escapeHtml(file.display_name)}</strong><small>From another permitted context · bytes are not copied</small></span><button type="button" data-attach-file="${escapeHtml(file.id)}" data-preview-version="${escapeHtml(destination.preview_version)}">Add</button></li>`;
    })
    .filter(Boolean)
    .join("");
  details.innerHTML = `
    <div class="review"><p class="eyebrow">Review exact destination</p><h2>${escapeHtml(project.name)} / ${escapeHtml(context.name)}</h2><p>${escapeHtml(context.description)}</p><p><span class="badge">${escapeHtml(accessLabel(context.visibility))}</span></p></div>
    <fieldset><legend>Available to your AI connections</legend><label class="check"><input id="chatgpt" type="checkbox" ${context.provider_availability.chatgpt ? "checked" : ""}> ChatGPT</label><label class="check"><input id="claude" type="checkbox" ${context.provider_availability.claude ? "checked" : ""}> Claude</label><p class="hint">This is separate from human access. Files inherit both boundaries.</p></fieldset>
    <button class="primary" id="apply" type="button">Apply provider choices and destination</button>
    <section><h3>Files already in this context</h3><ul class="files">${currentFiles}</ul><div class="row"><button type="button" id="upload">Upload a supported file ↗</button></div></section>
    <section><h3>Add an existing scan-clean file</h3><ul class="files">${availableFiles || '<li class="empty">No other permitted scan-clean file can be added.</li>'}</ul></section>`;

  document.querySelector("#apply")?.addEventListener("click", applyDestination);
  document.querySelector("#upload")?.addEventListener("click", async () => {
    await app.openLink({ url: context.upload_url });
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-attach-file]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await call("alice_attach_workspace_file", {
          project_id: project.id,
          source_reference_id: button.dataset.attachFile,
          target_context_id: context.id,
          expected_preview_version: button.dataset.previewVersion,
        });
        await refresh(
          "The exact scan-clean file reference was added. Its content remains untrusted.",
        );
      } catch (error) {
        announce(error instanceof Error ? error.message : "The file could not be added.", "danger");
      } finally {
        button.disabled = false;
      }
    });
  }
}

function updateContexts() {
  const project = selectedProject();
  const contextSelect = document.querySelector<HTMLSelectElement>("#context")!;
  const preferred =
    snapshot.active_target?.project_id === project?.id
      ? snapshot.active_target.context_id
      : project?.contexts[0]?.id;
  contextSelect.innerHTML = (project?.contexts || [])
    .map(
      (context: any) =>
        `<option value="${escapeHtml(context.id)}" ${context.id === preferred ? "selected" : ""}>${escapeHtml(context.name)}</option>`,
    )
    .join("");
  renderContextDetails();
}

async function applyDestination() {
  const project = selectedProject();
  const context = selectedContext();
  if (!project || !context) return;
  const chatgpt = document.querySelector<HTMLInputElement>("#chatgpt")!.checked;
  const claude = document.querySelector<HTMLInputElement>("#claude")!.checked;
  const currentProviderEnabled = snapshot.provider === "chatgpt" ? chatgpt : claude;
  try {
    announce("Applying the reviewed provider choices…");
    await call("alice_update_context_providers", {
      project_id: project.id,
      context_id: context.id,
      chatgpt,
      claude,
      expected_versions: context.provider_availability.versions,
    });
    if (currentProviderEnabled) {
      const expectedVersion = snapshot.active_target?.selection_version || null;
      await call("alice_select_workspace_context", {
        project_id: project.id,
        context_id: context.id,
        expected_selection_version: expectedVersion,
      });
      await refresh(`Destination set to ${project.name} / ${context.name}.`);
    } else {
      await refresh(
        `Provider choices saved. ${snapshot.provider === "chatgpt" ? "ChatGPT" : "Claude"} is not authorized for this context, so it was not selected.`,
      );
    }
  } catch (error) {
    announce(
      error instanceof Error ? error.message : "The destination could not be changed.",
      "danger",
    );
  }
}

function render() {
  const projectOptions = snapshot.projects
    .map(
      (project: any) =>
        `<option value="${escapeHtml(project.id)}" ${project.id === snapshot.active_target?.project_id ? "selected" : ""}>${escapeHtml(project.name)}</option>`,
    )
    .join("");
  root.innerHTML = `<style>
    :root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--color-background-primary,#f5f4ef);color:var(--color-text-primary,#17201d)}main{padding:18px}.shell{display:grid;gap:16px}.brand{display:flex;align-items:center;justify-content:space-between}.brand strong{font-size:20px}.eyebrow{font-size:11px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;color:var(--color-text-secondary,#65706b)}h1,h2,h3,p{margin-top:0}h1{font-size:24px;line-height:1.12}.warning,.notice,.review,fieldset,section,.create{border:1px solid var(--color-border-secondary,#cbcfc9);border-radius:14px;padding:14px;background:var(--color-background-secondary,#fff)}.warning{border-color:#b17a20;background:#fff6df}.notice{min-height:24px}.notice.danger{border-color:#b84638}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:grid;gap:5px;font-weight:650}select,input,textarea,button{font:inherit}select,input,textarea{width:100%;padding:9px;border:1px solid var(--color-border-primary,#9ca49f);border-radius:9px;background:var(--color-background-primary,#fff);color:inherit}textarea{min-height:70px;resize:vertical}button{border:1px solid var(--color-border-primary,#8c9690);border-radius:999px;padding:8px 13px;background:transparent;color:inherit;cursor:pointer}button.primary{background:#17201d;color:#fff;border-color:#17201d;font-weight:700}.check{display:inline-flex;grid-auto-flow:column;align-items:center;margin-right:15px}.check input{width:auto}.hint,small,.files span{display:block;color:var(--color-text-secondary,#65706b)}.files{list-style:none;padding:0;margin:0}.files li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--color-border-secondary,#ddd)}.files .empty{justify-content:flex-start}.row{display:flex;gap:8px;margin-top:12px}.create summary{cursor:pointer;font-weight:750}.create form{display:grid;gap:10px;margin-top:12px}.badge{display:inline-block;border:1px solid #9ca49f;border-radius:999px;padding:3px 8px}@media(max-width:560px){.grid{grid-template-columns:1fr}}
  </style><div class="shell"><div class="brand"><strong>alice.</strong><span class="badge">${escapeHtml(snapshot.provider)}</span></div><header><p class="eyebrow">Conversation workspace</p><h1>Choose where this AI works.</h1></header><div class="warning" role="note"><strong>Connection-wide setting</strong><p>${escapeHtml(snapshot.routing.warning)}</p></div><div class="grid"><label>Project<select id="project">${projectOptions}</select></label><label>Work context<select id="context"></select></label></div><div id="context-details"></div><details class="create"><summary>Create a project</summary><form id="create-project"><label>Name<input name="name" maxlength="120" required></label><label>Brief<textarea name="brief" maxlength="4000" required></textarea></label><label>Human access<select name="visibility"><option value="all_members">All project members</option><option value="selected_members">Selected project members</option><option value="personal">Personal draft</option></select></label><label class="check"><input name="chatgpt" type="checkbox"> ChatGPT</label><label class="check"><input name="claude" type="checkbox"> Claude</label><button type="submit">Create project</button></form></details><details class="create"><summary>Create a work context</summary><form id="create-context"><label>Name<input name="name" maxlength="120" required></label><label>Description<textarea name="description" maxlength="2000" required></textarea></label><label>Human access<select name="visibility"><option value="all_members">All project members</option><option value="selected_members">Selected project members</option><option value="personal">Personal draft</option></select></label><label class="check"><input name="chatgpt" type="checkbox"> ChatGPT</label><label class="check"><input name="claude" type="checkbox"> Claude</label><button type="submit">Create work context</button></form></details><p id="status" class="notice" role="status" aria-live="polite"></p></div>`;
  document.querySelector("#project")?.addEventListener("change", updateContexts);
  document.querySelector("#context")?.addEventListener("change", renderContextDetails);
  document
    .querySelector<HTMLFormElement>("#create-project")
    ?.addEventListener("submit", createProject);
  document
    .querySelector<HTMLFormElement>("#create-context")
    ?.addEventListener("submit", createContext);
  updateContexts();
}

async function createProject(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  try {
    const created: any = await call("alice_create_workspace_project", {
      name: data.get("name"),
      brief: data.get("brief"),
      context_visibility: data.get("visibility"),
      chatgpt: data.has("chatgpt"),
      claude: data.has("claude"),
    });
    await refresh(`Project ${created.name} was created with the reviewed access choices.`);
  } catch (error) {
    announce(
      error instanceof Error ? error.message : "The project could not be created.",
      "danger",
    );
  }
}

async function createContext(event: SubmitEvent) {
  event.preventDefault();
  const project = selectedProject();
  if (!project) return;
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  try {
    const created: any = await call("alice_create_workspace_context", {
      project_id: project.id,
      name: data.get("name"),
      description: data.get("description"),
      visibility: data.get("visibility"),
      chatgpt: data.has("chatgpt"),
      claude: data.has("claude"),
    });
    await refresh(`Work context ${created.name} was created with the reviewed access choices.`);
  } catch (error) {
    announce(
      error instanceof Error ? error.message : "The context could not be created.",
      "danger",
    );
  }
}

async function refresh(message?: string) {
  snapshot = await call("alice_workspace_snapshot");
  render();
  if (message) announce(message);
}

app.onhostcontextchanged = ({ theme }) => applyDocumentTheme(theme);
app.onerror = (error) => announce(error.message, "danger");
await app.connect();
applyDocumentTheme(app.getHostContext()?.theme);
try {
  await refresh();
} catch (error) {
  root.innerHTML = `<p class="notice danger" role="alert">${escapeHtml(error instanceof Error ? error.message : "The alice. workspace could not be loaded.")}</p>`;
}
