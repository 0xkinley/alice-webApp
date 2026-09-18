import {
  getProject,
  getProjectLifecycle,
  listIntegrationConnections,
  projectDefaultContextForUser,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import { roleLabel } from "./product-copy.ts";

const PROJECT_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function getProjectShell(database, userId: string, projectId: string) {
  const project = await getProject(database, userId, projectId);
  if (!project) return undefined;
  const [connections, uploadContext, lifecycle] = await Promise.all([
    listIntegrationConnections(database, userId),
    projectDefaultContextForUser(database, { userId, projectId, capability: "read" }),
    project.project_role === "owner"
      ? getProjectLifecycle(database, { userId, projectId })
      : undefined,
  ]);
  return {
    project,
    connectedProviders: new Set(
      connections
        .filter(({ revoked_at: revokedAt }) => !revokedAt)
        .map(({ client_classification: provider }) => provider),
    ),
    archivePreviewVersion: lifecycle?.preview_version,
    uploadEnabled: Boolean(uploadContext),
  };
}

function quickUploadScript({
  directUpload,
  projectId,
}: {
  directUpload: boolean;
  projectId: string;
}): string {
  const configuration = JSON.stringify({ directUpload, projectId }).replaceAll("<", "\\u003c");
  return `<script>
(()=>{const config=${configuration},button=document.getElementById("project-add-files"),input=document.getElementById("project-file-picker"),status=document.getElementById("project-file-status");if(!button||!input||!status)return;const announce=(message,tone="")=>{status.textContent=message;status.className=tone?"project-file-status "+tone:"project-file-status"},fail=message=>{button.disabled=false;input.value="";announce(message||"The file upload did not finish.","danger")},sha256=async file=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))).map(byte=>byte.toString(16).padStart(2,"0")).join(""),putDirect=(file,intent)=>new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open("PUT",intent.upload_url);for(const [name,value] of Object.entries(intent.upload_headers))xhr.setRequestHeader(name,value);xhr.onerror=()=>reject(new Error("The private storage upload failed."));xhr.onload=()=>{if(xhr.status<200||xhr.status>=300)return reject(new Error("The private storage upload failed."));const versionId=xhr.getResponseHeader("x-amz-version-id");if(!versionId)return reject(new Error("Private storage did not expose the immutable object version."));resolve(versionId)};xhr.send(file)}),finalize=async(intentId,versionId)=>{for(;;){const response=await fetch("/projects/"+encodeURIComponent(config.projectId)+"/files/direct/intents/"+encodeURIComponent(intentId)+"/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({storage_version_id:versionId})});if(response.status===202){await new Promise(resolve=>setTimeout(resolve,3000));continue}if(!response.ok)throw new Error(await response.text());return}},uploadDirect=async file=>{const digest=await sha256(file),response=await fetch("/projects/"+encodeURIComponent(config.projectId)+"/files/direct/intents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file_name:file.name,claimed_media_type:file.type||"application/octet-stream",byte_size:file.size,sha256:digest})});if(!response.ok)throw new Error(await response.text());const intent=await response.json(),versionId=await putDirect(file,intent);await finalize(intent.intent_id,versionId)},uploadLegacy=async file=>{const response=await fetch("/projects/"+encodeURIComponent(config.projectId)+"/files",{method:"POST",headers:{"Content-Type":file.type||"application/octet-stream","X-Alice-File-Name":encodeURIComponent(file.name)},body:file});if(!response.ok)throw new Error(await response.text())};button.addEventListener("click",()=>input.click());input.addEventListener("change",async()=>{const files=Array.from(input.files||[]);if(files.length===0)return;button.disabled=true;try{for(let index=0;index<files.length;index+=1){announce("Uploading "+(index+1)+" of "+files.length+"…");if(config.directUpload)await uploadDirect(files[index]);else await uploadLegacy(files[index])}announce("Files received. Opening Files…");location.href="/projects/"+encodeURIComponent(config.projectId)+"/files"}catch(error){fail(error instanceof Error?error.message:String(error))}})})();
</script>`;
}

function projectTabs(
  projectId: string,
  activeTab: "artifacts" | "changes" | "files" | "imported" | undefined,
  filesEnabled: boolean,
  pendingCount: number,
): string {
  const encodedProjectId = encodeURIComponent(projectId);
  const changeCurrent = activeTab === "changes" ? ' aria-current="page"' : "";
  const importedCurrent = activeTab === "imported" ? ' aria-current="page"' : "";
  const artifactsCurrent = activeTab === "artifacts" ? ' aria-current="page"' : "";
  const filesCurrent = activeTab === "files" ? ' aria-current="page"' : "";
  return `<nav class="project-tabs" aria-label="Project content"><a href="/projects/${encodedProjectId}/changes"${changeCurrent}>Change log${pendingCount ? `<span class="count-badge">${pendingCount}</span>` : ""}</a><a href="/projects/${encodedProjectId}/imported"${importedCurrent}>Imported material</a><a href="/projects/${encodedProjectId}/artifacts"${artifactsCurrent}>Artifacts</a>${filesEnabled ? `<a href="/projects/${encodedProjectId}/files"${filesCurrent}>Files</a>` : ""}</nav>`;
}

export function renderProjectShell({
  activeTab,
  fileStore,
  pendingCount = 0,
  shell,
}: {
  activeTab?: "artifacts" | "changes" | "files" | "imported";
  fileStore?: PrivateFileStore | undefined;
  pendingCount?: number;
  shell: Awaited<ReturnType<typeof getProjectShell>>;
}): string {
  if (!shell) return "";
  const { connectedProviders, archivePreviewVersion, project, uploadEnabled } = shell;
  const canWrite = project.project_role === "owner" || project.project_role === "editor";
  const isOwner = project.project_role === "owner";
  const providers = [
    ["chatgpt", "ChatGPT"],
    ["claude", "Claude"],
  ]
    .map(([provider, label]) => {
      const connected = connectedProviders.has(provider);
      return `<span class="project-provider"><span class="provider-light${connected ? " connected" : ""}"><span class="visually-hidden">${connected ? "Connected" : "Not connected"}</span></span>${connected ? "Connected to" : "Not connected to"} ${label}</span>`;
    })
    .join("");
  const encodedProjectId = encodeURIComponent(project.id);
  const menuItems = [
    `<a href="/projects/${encodedProjectId}/access">Your access</a>`,
    isOwner ? `<a href="/projects/${encodedProjectId}/collaborators">Collaborators</a>` : "",
    isOwner && archivePreviewVersion
      ? `<form class="project-menu-action" method="post" action="/projects/${encodedProjectId}/archive" onsubmit="return window.confirm('Are you sure you want to archive this project?')"><input type="hidden" name="expected_preview_version" value="${escapeHtml(archivePreviewVersion)}"><button class="destructive" type="submit">Archive project</button></form>`
      : "",
  ].join("");
  const filesEnabled = Boolean(fileStore && uploadEnabled);
  const addFiles =
    filesEnabled && canWrite
      ? `<div class="project-file-action"><button id="project-add-files" type="button" aria-controls="project-file-picker">Add files</button><input id="project-file-picker" type="file" accept="${PROJECT_FILE_ACCEPT}" multiple hidden tabindex="-1"><span id="project-file-status" class="project-file-status" role="status"></span></div>`
      : "";
  const uploadScript =
    filesEnabled && canWrite
      ? quickUploadScript({
          directUpload: Boolean(fileStore?.createSignedUpload),
          projectId: project.id,
        })
      : "";
  return `<header class="project-header"><div><p class="eyebrow">Project · ${escapeHtml(roleLabel(project.project_role))}</p><h1>${escapeHtml(project.name)}</h1><p>Files and information you choose to save stay together in this project.</p><div class="project-provider-row"><div class="project-providers" aria-label="Project AI status">${providers}</div>${addFiles}</div></div><div class="project-header-controls"><details class="project-menu"><summary aria-label="Project options"><span aria-hidden="true">…</span><span class="visually-hidden">Project options</span></summary><nav aria-label="Project options">${menuItems}</nav></details></div></header>${projectTabs(project.id, activeTab, filesEnabled, pendingCount)}${uploadScript}`;
}
