import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "alice-workspace", version: "2.0.0" }, {}, { autoResize: true });
let snapshot: any;
let addFilesAfterCreate = false;

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

function render() {
  const projects = snapshot.projects
    .map(
      (project: any) =>
        `<li><div><strong>${escapeHtml(project.name)}</strong><small>${project.accepted_state_count} saved ${project.accepted_state_count === 1 ? "item" : "items"}</small></div><button type="button" data-files-url="${escapeHtml(project.files_url)}">Add files ↗</button></li>`,
    )
    .join("");
  const guidance =
    snapshot.projects.length === 0
      ? "Create your first project below."
      : snapshot.projects.length === 1
        ? "This project is available automatically when you work with alice."
        : "Name a project in your conversation. If the project is unclear, your AI should ask which one you mean.";
  root.innerHTML = `<style>
    :root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--color-background-primary,#08110e);color:var(--color-text-primary,#f2f7f4)}main{padding:20px}.shell{display:grid;gap:18px}.brand{display:flex;align-items:center;justify-content:space-between}.brand strong{font-size:21px}.provider{display:flex;align-items:center;gap:7px;color:var(--color-text-secondary,#a8b5ae)}.light{width:9px;height:9px;border-radius:50%;background:#65e3a0;box-shadow:0 0 0 3px rgba(101,227,160,.14)}.eyebrow{margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#8de5b2}h1,p{margin-top:0}h1{font-size:26px;line-height:1.12}.intro,.create,.notice{border:1px solid var(--color-border-secondary,#30433a);border-radius:15px;padding:15px;background:var(--color-background-secondary,#0d1713)}.projects{list-style:none;padding:0;margin:0}.projects li{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid var(--color-border-secondary,#30433a)}.projects li:last-child{border-bottom:0}.projects small{display:block;color:var(--color-text-secondary,#a8b5ae)}form{display:grid;gap:11px}label{display:grid;gap:6px;font-weight:700}input,button{font:inherit}input{width:100%;padding:10px 12px;border:1px solid var(--color-border-primary,#486054);border-radius:9px;background:var(--color-background-primary,#08110e);color:inherit}.actions{display:flex;justify-content:flex-end;gap:9px;flex-wrap:wrap}button{border:1px solid var(--color-border-primary,#486054);border-radius:999px;padding:9px 14px;background:transparent;color:inherit;cursor:pointer}button.primary{background:#9cf0bd;border-color:#9cf0bd;color:#07100d;font-weight:800}button.selected{border-color:#9cf0bd;color:#9cf0bd}.notice{min-height:24px}.notice.danger{border-color:#bd574b}@media(max-width:520px){.projects li{align-items:flex-start;flex-direction:column}.actions{justify-content:stretch}.actions button{flex:1}}
  </style><div class="shell"><div class="brand"><strong>alice.</strong><span class="provider"><span class="light" aria-hidden="true"></span>${escapeHtml(snapshot.provider === "chatgpt" ? "ChatGPT" : "Claude")} connected</span></div><header><p class="eyebrow">Projects</p><h1>Welcome to alice.</h1><p>Create a project or choose one by name in your conversation.</p></header><section class="intro"><p>${escapeHtml(guidance)}</p><ul class="projects">${projects || "<li>No projects yet.</li>"}</ul></section><section class="create"><form id="create-project"><label>Project name<input name="name" maxlength="120" required autocomplete="off"></label><div class="actions"><button id="add-files" type="button">Add files</button><button class="primary" type="submit">Create project</button></div></form></section><p id="status" class="notice" role="status" aria-live="polite"></p></div>`;
  document.querySelector("#add-files")?.addEventListener("click", () => {
    addFilesAfterCreate = !addFilesAfterCreate;
    document.querySelector("#add-files")?.classList.toggle("selected", addFilesAfterCreate);
    announce(
      addFilesAfterCreate
        ? "Files can be added after the project is created."
        : "No files selected.",
    );
  });
  document
    .querySelector<HTMLFormElement>("#create-project")
    ?.addEventListener("submit", createProject);
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
    await refresh(
      `Project ${created.name} was created and is now available to this AI connection.`,
    );
  } catch (error) {
    announce(
      error instanceof Error ? error.message : "The project could not be created.",
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
