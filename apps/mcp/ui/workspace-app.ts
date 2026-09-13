import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "alice-workspace", version: "5.0.0" }, {}, { autoResize: true });
let snapshot: any;
let addFilesAfterCreate = false;
let selectedProjectId = "";
let activeView: "projects" | "files" = "projects";
let launchProjectReference = "";
let uploads: WorkspaceUpload[] = [];
let uploadRunning = false;

type UploadStatus =
  "ready" | "hashing" | "uploading" | "staging_scan" | "final_scan" | "available" | "failed";

type WorkspaceUpload = {
  key: string;
  file: File;
  mediaType: string;
  status: UploadStatus;
  message: string;
  intentId?: string;
  storageVersionId?: string;
  fileReferenceId?: string;
};

const mediaTypesByExtension: Record<string, string> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const acceptedMediaTypes = new Set(Object.values(mediaTypesByExtension));

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

async function callResult(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(resultText(result) || "The alice. action failed.");
  return result as any;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return (await callResult(name, args)).structuredContent;
}

function announce(message: string, tone = "") {
  const status = document.querySelector<HTMLElement>("#status");
  if (!status) return;
  status.textContent = message;
  status.className = tone ? `notice ${tone}` : "notice";
}

function selectedProject() {
  return snapshot?.projects.find((project: any) => project.id === selectedProjectId);
}

function projectOption(project: any) {
  return `<option value="${escapeHtml(project.id)}"${project.id === selectedProjectId ? " selected" : ""}>${escapeHtml(project.name)}</option>`;
}

function applyLaunchContext(value: any) {
  if (!value || typeof value !== "object") return;
  const requestedView = value.initial_view || value.view;
  if (requestedView === "files" || requestedView === "projects") activeView = requestedView;
  const reference = value.selected_project?.name || value.project_id;
  if (typeof reference === "string") launchProjectReference = reference;
  if (snapshot) {
    const project = snapshot.projects.find(
      (candidate: any) =>
        candidate.id === launchProjectReference || candidate.name === launchProjectReference,
    );
    if (project) selectedProjectId = project.id;
    render();
  }
}

async function setWorkingProject(project: any) {
  selectedProjectId = project.id;
  uploads = [];
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
        contract_version: "alice_workspace_selection_v2",
        selected_project: { name: project.name },
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
  uploads = [];
  render();
  try {
    await app.updateModelContext({
      content: [],
      structuredContent: {
        contract_version: "alice_workspace_selection_v2",
        selected_project: null,
        selection_scope: "current_chat_only",
        persisted_active_target: false,
      },
    });
  } catch {
    // The visible selection still clears when a host has not implemented model-context updates.
  }
}

function sharedStyles() {
  return `<style>
    :root{color-scheme:light dark;font:400 15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--canvas:var(--color-background-primary,#070b09);--surface:var(--color-background-secondary,#0d1411);--surface-raised:var(--color-background-tertiary,#121b17);--line:var(--color-border-secondary,#2b3a32);--line-strong:var(--color-border-primary,#496055);--ink:var(--color-text-primary,#f2f7f4);--muted:var(--color-text-secondary,#9ba9a1);--brand:#9cf0bd;--brand-ink:#06140c;--danger:#ffaaa5;--warning:#ffd68a}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}button,input,select{font:inherit}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #86d8ff;outline-offset:3px}main{padding:clamp(16px,4vw,24px)}.workspace{display:grid;gap:18px;max-width:720px;margin:0 auto}.topline{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid var(--line)}.wordmark{font-size:22px;font-weight:850;letter-spacing:-.05em}.provider{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;font-weight:650}.light{width:10px;height:10px;border:1px solid var(--brand);border-radius:50%;background:var(--brand);box-shadow:0 0 0 4px rgba(156,240,189,.12),0 0 18px rgba(156,240,189,.35)}header{display:grid;gap:6px}h1,h2,p{margin:0}h1{font-size:clamp(28px,6vw,42px);font-weight:680;letter-spacing:-.045em;line-height:1.05}h2{font-size:18px}header p,.muted{color:var(--muted)}.eyebrow{color:var(--brand);font-size:11px;font-weight:850;letter-spacing:.15em;text-transform:uppercase}.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line)}.tabs button{border:0;border-bottom:3px solid transparent;border-radius:0;padding:9px 12px}.tabs button[aria-selected="true"]{border-bottom-color:var(--brand);color:var(--brand)}.welcome{display:grid;gap:8px;padding:16px;border:1px solid rgba(156,240,189,.28);border-radius:16px;background:rgba(156,240,189,.06)}.welcome strong{font-size:18px}.welcome p{color:var(--muted)}.panel{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--surface)}.picker{display:grid;gap:12px;padding:16px}.picker label,.field{display:grid;gap:6px;font-weight:720}.picker select,input{width:100%;border:1px solid var(--line-strong);border-radius:10px;padding:11px 12px;background:var(--canvas);color:var(--ink)}.picker-help{color:var(--muted)}.working-project{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:4px}.working-project p{margin-top:2px;color:var(--muted);font-size:13px}.project-actions,.row-actions{display:flex;gap:7px;flex:0 0 auto;flex-wrap:wrap}button,.file-picker{border:1px solid var(--line-strong);border-radius:999px;padding:8px 12px;background:transparent;color:var(--ink);font-weight:720;cursor:pointer;text-align:center}button:hover,.file-picker:hover{border-color:var(--brand);background:rgba(156,240,189,.08)}button.primary{border-color:var(--brand);background:var(--brand);color:var(--brand-ink)}button.primary:hover{filter:brightness(1.06)}button[disabled]{cursor:not-allowed;opacity:.55}button[aria-pressed="true"]{border-color:var(--brand);background:rgba(156,240,189,.1);color:var(--brand)}.create,.upload-panel{display:grid;gap:14px;padding:16px}.create form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.create form label{display:grid;grid-column:1/-1;gap:6px;font-weight:720}.create-actions{display:flex;grid-column:1/-1;justify-content:flex-end;gap:8px;flex-wrap:wrap}.file-picker input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.upload-list{display:grid;gap:10px}.upload-item{display:grid;gap:8px;padding:13px;border:1px solid var(--line);border-radius:12px;background:var(--surface-raised)}.upload-item.failed{border-color:rgba(255,170,165,.65)}.upload-item.available{border-color:rgba(156,240,189,.55)}.file-name{font-weight:780;overflow-wrap:anywhere}.file-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 14px;color:var(--muted);font-size:13px}.file-meta strong{color:var(--ink);font-weight:650}.file-status{color:var(--muted);font-size:13px}.upload-item.failed .file-status{color:var(--danger)}.upload-item.available .file-status{color:var(--brand)}.notice{min-height:46px;margin:0;border:1px solid var(--line);border-radius:12px;padding:11px 13px;background:var(--surface-raised);color:var(--muted)}.notice:empty{display:none}.notice.danger{border-color:var(--danger);color:var(--danger)}.boundary{display:grid;gap:6px;padding:13px;border:1px solid rgba(255,214,138,.35);border-radius:12px;background:rgba(255,214,138,.05)}.boundary strong{color:var(--warning)}@media(max-width:560px){main{padding:14px}.topline,.working-project{align-items:flex-start;flex-direction:column}.project-actions,.row-actions{width:100%}.project-actions button,.row-actions button,.row-actions .file-picker{flex:1}.create-actions{display:grid;grid-template-columns:1fr}.create-actions button{width:100%}.file-meta{grid-template-columns:1fr}}
  </style>`;
}

function shell(content: string) {
  const provider = providerName(snapshot.provider);
  return `${sharedStyles()}<div class="workspace"><div class="topline"><strong class="wordmark">alice.</strong><span class="provider"><span class="light" aria-hidden="true"></span>${escapeHtml(provider)} connected</span></div><nav class="tabs" aria-label="Alice workspace"><button type="button" data-view="projects" aria-selected="${activeView === "projects"}">Projects</button><button type="button" data-view="files" aria-selected="${activeView === "files"}">Files</button></nav>${content}<p id="status" class="notice" role="status" aria-live="polite"></p></div>`;
}

function projectPicker() {
  const projects = snapshot.projects.map(projectOption).join("");
  return `<section class="panel picker" aria-labelledby="project-picker-label"><label id="project-picker-label" for="project-select">Destination project</label><select id="project-select"${snapshot.projects.length === 0 ? " disabled" : ""}><option value="">Choose a project</option>${projects}</select></section>`;
}

function projectsView() {
  const workingProject = selectedProject();
  const projectActions = workingProject
    ? `<div class="working-project"><div><strong>Now you're working in ${escapeHtml(workingProject.name)}.</strong><p>Alice keeps search and retrieval scoped to this project in this chat.</p></div><div class="project-actions"><button type="button" data-project-url="${escapeHtml(workingProject.project_url)}">Open project <span aria-hidden="true">↗</span></button><button type="button" data-open-files>Add files</button></div></div>`
    : '<p class="picker-help">Choose a project to start working, or create one below.</p>';
  return `<header><p class="eyebrow">Project workspace</p><h1>Continue your work.</h1></header><section class="welcome" aria-labelledby="welcome-title"><strong id="welcome-title">Welcome to alice.</strong><p>Choose a project or create one to get started. Upload a file once and make it available to the AI providers you permit. To save something from this chat, say “Save this to Alice.”</p></section>${projectPicker().replace("</section>", `${projectActions}</section>`)}<section class="panel create" aria-labelledby="create-title"><h2 id="create-title">Create project</h2><form id="create-project"><label>Project name<input name="name" maxlength="120" required autocomplete="off"></label><div class="create-actions"><button id="add-files" type="button" aria-pressed="${addFilesAfterCreate}">Add files</button><button class="primary" type="submit">Create project</button></div></form></section>`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadItem(upload: WorkspaceUpload, project: any) {
  const retry =
    upload.status === "failed"
      ? `<button type="button" data-retry="${escapeHtml(upload.key)}">Retry this file</button>`
      : "";
  return `<article class="upload-item ${escapeHtml(upload.status)}"><p class="file-name">${escapeHtml(upload.file.name)}</p><div class="file-meta"><span>Type <strong>${escapeHtml(upload.mediaType || "Unsupported")}</strong></span><span>Size <strong>${escapeHtml(formatBytes(upload.file.size))}</strong></span><span>Source <strong>Selected in Alice</strong></span><span>Destination <strong>${escapeHtml(project.name)}</strong></span></div><p class="file-status">${escapeHtml(upload.message)}</p>${retry ? `<div class="row-actions">${retry}</div>` : ""}</article>`;
}

function filesView() {
  const project = selectedProject();
  const list = project ? uploads.map((upload) => uploadItem(upload, project)).join("") : "";
  const pendingCount = uploads.filter((upload) => upload.status !== "available").length;
  const actionLabel = project
    ? uploads.length === 1
      ? `Upload ${uploads[0].file.name} to ${project.name}`
      : `Upload ${pendingCount || uploads.length} files to ${project.name}`
    : "Upload files to Alice";
  const uploadControls = !project
    ? '<p class="picker-help">Choose the exact destination project before selecting files.</p>'
    : !project.can_upload
      ? '<p class="notice danger" role="alert">This connection does not have permission to upload to this project.</p>'
      : `<section class="panel upload-panel" aria-labelledby="upload-title"><div><h2 id="upload-title">Select the exact files</h2><p class="muted">Nothing is transferred when you choose files. Review the complete list, then use the named Alice upload action once.</p></div><div class="row-actions"><label class="file-picker">Choose files<input id="file-input" type="file" multiple accept=".csv,.docx,.jpeg,.jpg,.json,.md,.pdf,.png,.pptx,.tsv,.txt,.webp,.xlsx"></label>${uploads.length ? '<button type="button" id="clear-files">Clear selection</button>' : ""}</div>${uploads.length ? `<div class="upload-list">${list}</div><div class="row-actions"><button class="primary" id="upload-files" type="button"${uploadRunning || pendingCount === 0 ? " disabled" : ""}>${escapeHtml(actionLabel)}</button><button type="button" data-files-url="${escapeHtml(project.files_url)}">Open Alice website fallback <span aria-hidden="true">↗</span></button></div>` : `<p class="picker-help">Supported: PDF, PNG, JPEG, WebP, text, Markdown, CSV, TSV, JSON, DOCX, XLSX, and PPTX. Office files remain reference/download-only.</p><div class="row-actions"><button type="button" data-files-url="${escapeHtml(project.files_url)}">Open Alice website fallback <span aria-hidden="true">↗</span></button></div>`}</section>`;
  return `<header><p class="eyebrow">Private file upload</p><h1>Upload to Alice.</h1><p>Select the exact local files here so Alice—not the host AI—receives their bytes.</p></header><section class="boundary"><strong>Why you need to select the file here</strong><p>${escapeHtml(providerName(snapshot.provider))} cannot automatically pass an already-attached file's original bytes to Alice. Select the same file in this Alice-controlled chooser. Alice verifies its exact hash, type, and size, runs security scans, and only then makes it available to other connected AI providers permitted for this project.</p></section>${projectPicker()}${uploadControls}`;
}

function wireCommonActions() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.addEventListener("click", () => {
      activeView = button.dataset.view === "files" ? "files" : "projects";
      render();
    });
  }
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

function render() {
  root.innerHTML = shell(activeView === "files" ? filesView() : projectsView());
  wireCommonActions();
  if (activeView === "projects") wireProjectActions();
  else wireFileActions();
}

function wireProjectActions() {
  document.querySelector("[data-open-files]")?.addEventListener("click", () => {
    activeView = "files";
    render();
  });
  document.querySelector("#add-files")?.addEventListener("click", () => {
    addFilesAfterCreate = !addFilesAfterCreate;
    const button = document.querySelector<HTMLButtonElement>("#add-files");
    button?.setAttribute("aria-pressed", String(addFilesAfterCreate));
    announce(
      addFilesAfterCreate
        ? "After the project is created, Alice will open its file chooser."
        : "The project will be created without opening the file chooser.",
    );
  });
  document
    .querySelector<HTMLFormElement>("#create-project")
    ?.addEventListener("submit", createProject);
}

function mediaTypeFor(file: File) {
  if (acceptedMediaTypes.has(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return mediaTypesByExtension[extension] || "";
}

function selectFiles(files: File[]) {
  uploads = files.map((file, index) => {
    const mediaType = mediaTypeFor(file);
    return {
      key: `${file.name}:${file.size}:${file.lastModified}:${index}`,
      file,
      mediaType,
      status: mediaType ? "ready" : "failed",
      message: mediaType
        ? "Ready for your Alice upload action. No bytes have moved."
        : "This file type is not supported by Alice.",
    };
  });
  render();
}

function wireFileActions() {
  document.querySelector<HTMLInputElement>("#file-input")?.addEventListener("change", (event) => {
    selectFiles([...((event.currentTarget as HTMLInputElement).files || [])]);
  });
  document.querySelector("#clear-files")?.addEventListener("click", () => {
    uploads = [];
    render();
  });
  document.querySelector("#upload-files")?.addEventListener("click", uploadSelectedFiles);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-retry]")) {
    button.addEventListener("click", async () => {
      const upload = uploads.find((candidate) => candidate.key === button.dataset.retry);
      const project = selectedProject();
      if (!upload || !project || uploadRunning) return;
      uploadRunning = true;
      try {
        await processUpload(upload, project);
      } finally {
        uploadRunning = false;
        render();
      }
    });
  }
}

function updateUpload(upload: WorkspaceUpload, status: UploadStatus, message: string) {
  upload.status = status;
  upload.message = message;
  render();
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollFinalScan(upload: WorkspaceUpload, project: any) {
  if (!upload.fileReferenceId) throw new Error("Alice did not return the file reference.");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await call("alice_workspace_file_status", {
      project_id: project.id,
      file_reference_id: upload.fileReferenceId,
    });
    if (status.status === "available") {
      updateUpload(
        upload,
        "available",
        "Available in Alice. Exact bytes passed both security scans and can now be read by permitted AI connections.",
      );
      return;
    }
    if (status.scan_status !== "scanning") {
      throw new Error("Alice could not accept this file after its final security scan.");
    }
    await wait(2_000);
  }
  throw new Error("The final Alice scan is still running. Retry this file to check again.");
}

async function finalizeStagedUpload(upload: WorkspaceUpload, project: any) {
  if (!upload.intentId || !upload.storageVersionId) {
    throw new Error("The exact staged upload receipt is missing.");
  }
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const finalized = await call("alice_finalize_workspace_file_upload", {
      project_id: project.id,
      intent_id: upload.intentId,
      storage_version_id: upload.storageVersionId,
    });
    if (finalized.status === "completed") {
      upload.fileReferenceId = finalized.file_reference_id;
      if (finalized.scan_status === "clean") {
        updateUpload(
          upload,
          "available",
          "Available in Alice. Exact bytes passed both security scans and can now be read by permitted AI connections.",
        );
        return;
      }
      updateUpload(
        upload,
        "final_scan",
        "Transferred and exact-byte verified. Alice is running the final security scan; the file is not available yet.",
      );
      await pollFinalScan(upload, project);
      return;
    }
    updateUpload(
      upload,
      "staging_scan",
      "Bytes reached Alice staging storage. Alice is verifying the exact file and running its first security scan.",
    );
    await wait(2_000);
  }
  throw new Error("The Alice staging scan is still running. Retry this file to continue safely.");
}

async function processUpload(upload: WorkspaceUpload, project: any) {
  try {
    if (upload.fileReferenceId) {
      updateUpload(upload, "final_scan", "Checking the final Alice security scan again…");
      await pollFinalScan(upload, project);
      return;
    }
    if (upload.intentId && upload.storageVersionId) {
      updateUpload(upload, "staging_scan", "Checking the Alice staging scan again…");
      await finalizeStagedUpload(upload, project);
      return;
    }
    if (!upload.mediaType) throw new Error("This file type is not supported by Alice.");
    updateUpload(upload, "hashing", "Verifying the exact file in your browser…");
    const digest = await sha256(upload.file);
    const prepared = await callResult("alice_begin_workspace_file_upload", {
      project_id: project.id,
      file_name: upload.file.name,
      claimed_media_type: upload.mediaType,
      byte_size: upload.file.size,
      sha256: digest,
    });
    const transfer = prepared._meta?.["alice/privateUpload"];
    if (!transfer?.intent_id || !transfer?.upload_url || !transfer?.upload_headers) {
      throw new Error("Alice did not return a private upload path.");
    }
    const uploadUrl = new URL(transfer.upload_url);
    if (uploadUrl.protocol !== "https:") throw new Error("Alice returned an invalid upload path.");
    upload.intentId = transfer.intent_id;
    updateUpload(upload, "uploading", "Uploading exact bytes directly to Alice private staging…");
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: transfer.upload_headers,
      body: upload.file,
      credentials: "omit",
    });
    if (!response.ok) throw new Error("The exact-byte transfer to Alice staging failed.");
    const storageVersionId = response.headers.get("x-amz-version-id");
    if (!storageVersionId) throw new Error("Alice storage did not return an immutable version.");
    upload.storageVersionId = storageVersionId;
    updateUpload(
      upload,
      "staging_scan",
      "Bytes reached Alice staging storage. Alice is verifying the exact file and running its first security scan.",
    );
    await finalizeStagedUpload(upload, project);
  } catch (error) {
    updateUpload(
      upload,
      "failed",
      error instanceof Error ? error.message : "This file could not be uploaded to Alice.",
    );
  }
}

async function uploadSelectedFiles() {
  const project = selectedProject();
  if (!project || uploadRunning) return;
  uploadRunning = true;
  render();
  for (const upload of uploads) {
    if (upload.status === "available" || !upload.mediaType) continue;
    await processUpload(upload, project);
  }
  uploadRunning = false;
  render();
  const succeeded = uploads.filter((upload) => upload.status === "available").length;
  const failed = uploads.filter((upload) => upload.status === "failed").length;
  announce(
    `${succeeded} file${succeeded === 1 ? "" : "s"} available in ${project.name}.${failed ? ` ${failed} file${failed === 1 ? "" : "s"} still need attention.` : ""}`,
    failed ? "danger" : "",
  );
}

async function createProject(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const name = new FormData(form).get("name");
  try {
    announce("Creating project…");
    const created: any = await call("alice_create_workspace_project", { name });
    const openFiles = addFilesAfterCreate;
    addFilesAfterCreate = false;
    snapshot = await call("alice_workspace_snapshot");
    const project = snapshot.projects.find((candidate: any) => candidate.id === created.id);
    if (project) {
      await setWorkingProject(project);
      if (openFiles) {
        activeView = "files";
        render();
      }
    } else {
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
  const launched = snapshot.projects.find(
    (project: any) =>
      project.id === launchProjectReference || project.name === launchProjectReference,
  );
  if (launched) selectedProjectId = launched.id;
  else if (!selectedProjectId && snapshot.projects.length === 1)
    selectedProjectId = snapshot.projects[0].id;
  render();
  if (message) announce(message);
}

app.ontoolinput = (params: any) => applyLaunchContext(params.arguments);
app.ontoolresult = (params: any) => applyLaunchContext(params.structuredContent);
app.onhostcontextchanged = ({ theme }) => applyDocumentTheme(theme);
app.onerror = (error) => announce(error.message, "danger");
await app.connect();
applyDocumentTheme(app.getHostContext()?.theme);
try {
  await refresh();
} catch (error) {
  root.innerHTML = `<p class="notice danger" role="alert">${escapeHtml(error instanceof Error ? error.message : "The alice. workspace could not be loaded.")}</p>`;
}
