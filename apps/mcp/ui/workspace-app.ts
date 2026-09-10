import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "alice-workspace", version: "3.1.0" }, {}, { autoResize: true });
let snapshot: any;
let addFilesAfterCreate = false;
let selectedProjectId = "";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resultText(result: any) {
  return (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join(" ");
}

function providerName(provider: unknown) {
  return provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "AI platform";
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
  return snapshot.projects.find((project: any) => project.id === selectedProjectId);
}

function projectOption(project: any) {
  return `<option value="${escapeHtml(project.id)}"${project.id === selectedProjectId ? " selected" : ""}>${escapeHtml(project.name)}</option>`;
}

async function setWorkingProject(project: any) {
  selectedProjectId = project.id;
  render();
  announce(`Now you're working in ${project.name}.`);
  try {
    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: `The user selected the alice. project "${project.name}" for this chat. Scope Alice search and retrieval to this exact project. Continue to require an exact project and authenticated human confirmation for every save or file action.`,
        },
      ],
      structuredContent: {
        contract_version: "alice_workspace_selection_v1",
        selected_project: { id: project.id, name: project.name },
        selection_scope: "current_chat_only",
        persisted_active_target: false,
      },
    });
  } catch {
    // The visible selection still works when a host has not implemented model-context updates.
  }
}

async function clearWorkingProject() {
  selectedProjectId = "";
  render();
  try {
    await app.updateModelContext({
      content: [],
      structuredContent: {
        contract_version: "alice_workspace_selection_v1",
        selected_project: null,
        selection_scope: "current_chat_only",
        persisted_active_target: false,
      },
    });
  } catch {
    // The visible selection still clears when a host has not implemented model-context updates.
  }
}

function render() {
  const projects = snapshot.projects.map(projectOption).join("");
  const workingProject = selectedProject();
  const provider = providerName(snapshot.provider);
  const projectActions = workingProject
    ? `<div class="working-project"><div><strong>Now you're working in ${escapeHtml(workingProject.name)}.</strong><p>Alice will keep search and retrieval scoped to this project in this chat.</p></div><div class="project-actions"><button type="button" data-project-url="${escapeHtml(workingProject.project_url)}">Open project <span aria-hidden="true">↗</span></button><button type="button" data-files-url="${escapeHtml(workingProject.files_url)}">Add files <span aria-hidden="true">↗</span></button></div></div>`
    : '<p class="picker-help">Choose a project to start working, or create one below.</p>';
  root.innerHTML = `<style>
    :root{color-scheme:light dark;font:400 15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--canvas:var(--color-background-primary,#070b09);--surface:var(--color-background-secondary,#0d1411);--surface-raised:var(--color-background-tertiary,#121b17);--line:var(--color-border-secondary,#2b3a32);--line-strong:var(--color-border-primary,#496055);--ink:var(--color-text-primary,#f2f7f4);--muted:var(--color-text-secondary,#9ba9a1);--brand:#9cf0bd;--brand-ink:#06140c;--danger:#ffaaa5}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}button,input,select{font:inherit}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #86d8ff;outline-offset:3px}main{padding:clamp(16px,4vw,24px)}.workspace{display:grid;gap:18px;max-width:720px;margin:0 auto}.topline{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid var(--line)}.wordmark{font-size:22px;font-weight:850;letter-spacing:-.05em}.provider{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;font-weight:650}.light{width:10px;height:10px;border:1px solid var(--brand);border-radius:50%;background:var(--brand);box-shadow:0 0 0 4px rgba(156,240,189,.12),0 0 18px rgba(156,240,189,.35)}header{display:grid;gap:6px}h1,p{margin:0}h1{font-size:clamp(28px,6vw,42px);font-weight:680;letter-spacing:-.045em;line-height:1.05}header p{max-width:60ch;color:var(--muted)}.eyebrow{color:var(--brand);font-size:11px;font-weight:850;letter-spacing:.15em;text-transform:uppercase}.welcome{display:grid;gap:8px;padding:16px;border:1px solid rgba(156,240,189,.28);border-radius:16px;background:rgba(156,240,189,.06)}.welcome strong{font-size:18px}.welcome p{color:var(--muted)}.panel{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--surface)}.picker{display:grid;gap:12px;padding:16px}.picker label{display:grid;gap:6px;font-weight:720}.picker select,input{width:100%;border:1px solid var(--line-strong);border-radius:10px;padding:11px 12px;background:var(--canvas);color:var(--ink)}.picker-help{color:var(--muted)}.working-project{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:4px}.working-project p{margin-top:2px;color:var(--muted);font-size:13px}.project-actions{display:flex;gap:7px;flex:0 0 auto}button{border:1px solid var(--line-strong);border-radius:999px;padding:8px 12px;background:transparent;color:var(--ink);font-weight:720;cursor:pointer}button:hover{border-color:var(--brand);background:rgba(156,240,189,.08)}button.primary{border-color:var(--brand);background:var(--brand);color:var(--brand-ink)}button.primary:hover{filter:brightness(1.06)}button[aria-pressed="true"]{border-color:var(--brand);background:rgba(156,240,189,.1);color:var(--brand)}.create{padding:16px}.create h2{margin:0 0 12px;font-size:18px}form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}form label{display:grid;grid-column:1/-1;gap:6px;font-weight:720}.create-actions{display:flex;grid-column:1/-1;justify-content:flex-end;gap:8px;flex-wrap:wrap}.notice{min-height:46px;margin:0;border:1px solid var(--line);border-radius:12px;padding:11px 13px;background:var(--surface-raised);color:var(--muted)}.notice:empty{display:none}.notice.danger{border-color:var(--danger);color:var(--danger)}@media(max-width:560px){main{padding:14px}.topline,.working-project{align-items:flex-start;flex-direction:column}.project-actions{width:100%}.project-actions button{flex:1}.create-actions{display:grid;grid-template-columns:1fr}.create-actions button{width:100%}}
  </style><div class="workspace"><div class="topline"><strong class="wordmark">alice.</strong><span class="provider"><span class="light" aria-hidden="true"></span>${escapeHtml(provider)} connected</span></div><header><p class="eyebrow">Project workspace</p><h1>Continue your work.</h1></header><section class="welcome" aria-labelledby="welcome-title"><strong id="welcome-title">Welcome to alice.</strong><p>Choose a project or create one to get started. Upload files once and make them available to the AI providers you permit. To save something from this chat, say “Save this to Alice.” To upload a file, select a project and choose Add files.</p></section><section class="panel picker" aria-labelledby="project-picker-label"><label id="project-picker-label" for="project-select">Project</label><select id="project-select"${snapshot.projects.length === 0 ? " disabled" : ""}><option value="">Choose a project</option>${projects}</select>${projectActions}</section><section class="panel create" aria-labelledby="create-title"><h2 id="create-title">Create project</h2><form id="create-project"><label>Project name<input name="name" maxlength="120" required autocomplete="off"></label><div class="create-actions"><button id="add-files" type="button" aria-pressed="${addFilesAfterCreate}">Add files</button><button class="primary" type="submit">Create project</button></div></form></section><p id="status" class="notice" role="status" aria-live="polite"></p></div>`;
  document
    .querySelector<HTMLSelectElement>("#project-select")
    ?.addEventListener("change", async (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      const project = snapshot.projects.find((candidate: any) => candidate.id === select.value);
      if (!project) {
        await clearWorkingProject();
        return;
      }
      await setWorkingProject(project);
    });
  document.querySelector("#add-files")?.addEventListener("click", () => {
    addFilesAfterCreate = !addFilesAfterCreate;
    const button = document.querySelector<HTMLButtonElement>("#add-files");
    button?.setAttribute("aria-pressed", String(addFilesAfterCreate));
    announce(
      addFilesAfterCreate
        ? "After the project is created, Alice will open its secure file chooser."
        : "The project will be created without opening the file chooser.",
    );
  });
  document
    .querySelector<HTMLFormElement>("#create-project")
    ?.addEventListener("submit", createProject);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-project-url]")) {
    button.addEventListener("click", async () => {
      if (button.dataset.projectUrl) await app.openLink({ url: button.dataset.projectUrl });
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-files-url]")) {
    button.addEventListener("click", async () => {
      if (button.dataset.filesUrl) await app.openLink({ url: button.dataset.filesUrl });
    });
  }
}

async function createProject(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const name = new FormData(form).get("name");
  try {
    announce("Creating project…");
    const created: any = await call("alice_create_workspace_project", { name });
    if (addFilesAfterCreate && created.upload_url) await app.openLink({ url: created.upload_url });
    addFilesAfterCreate = false;
    snapshot = await call("alice_workspace_snapshot");
    const project = snapshot.projects.find((candidate: any) => candidate.id === created.id);
    if (project) await setWorkingProject(project);
    else {
      render();
      announce(
        `${created.name} was created and is available in ${providerName(snapshot.provider)}.`,
      );
    }
  } catch (error) {
    announce(
      error instanceof Error ? error.message : "The project could not be created.",
      "danger",
    );
  }
}

async function refresh(message?: string) {
  snapshot = await call("alice_workspace_snapshot");
  if (!selectedProjectId && snapshot.projects.length === 1) {
    await setWorkingProject(snapshot.projects[0]);
    return;
  }
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
