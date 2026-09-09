import express from "express";
import {
  FILE_UPLOAD_LIMIT_BYTES,
  ProjectFileUserError,
  createProjectFileUploadIntent,
  exportProjectFileMetadata,
  finalizeProjectFileUpload,
  getProjectFileDownload,
  getProjectFilePreview,
  getProjectFileReferencePreview,
  getProjectFileRemovalPreview,
  getProjectFileView,
  listProjectFiles,
  listWorkContexts,
  refreshProjectFileScan,
  referenceProjectFileInContext,
  removeProjectFileReference,
  uploadProjectFile,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import { renderAppPage, renderPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { accessLabel, hostLabel, timestampLabel } from "./product-copy.ts";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function notFound(response) {
  return response
    .status(404)
    .type("html")
    .send(
      renderStatusPage(
        "Not found",
        '<h1>Project files not found</h1><p>The file or context may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
        "neutral",
      ),
    );
}

function statusCopy(status: string): string {
  return (
    {
      clean: "Ready",
      pending_upload: "Upload pending",
      scan_failed: "Scan failed: file unavailable",
      scanning: "Scanning: file unavailable",
      storage_failed: "Upload failed",
      threats_found: "Threat detected: file unavailable",
      unsupported: "Scan unsupported: file unavailable",
    }[status] || "Unavailable"
  );
}

async function fileContextId(database, userId: string, projectId: string, requested: unknown) {
  if (typeof requested === "string" && requested) return requested;
  const contexts = (await listWorkContexts(database, userId, projectId)) || [];
  return contexts.find(({ context_kind: kind }) => kind === "work")?.id || "";
}

function directUploadScript({
  projectId,
  contextId,
  replacesReferenceId,
  successLocation,
}: {
  projectId: string;
  contextId: string;
  replacesReferenceId?: string;
  successLocation: "reload" | "receipt";
}): string {
  const configuration = JSON.stringify({
    projectId,
    contextId,
    replacesReferenceId: replacesReferenceId || null,
    successLocation,
  }).replaceAll("<", "\\u003c");
  return `<script>
const config=${configuration},form=document.getElementById("file-upload"),input=document.getElementById("file"),progress=document.getElementById("progress"),status=document.getElementById("upload-status");
const announce=(message,tone="")=>{status.textContent=message;status.className=tone?"notice "+tone:"notice"};
const fail=message=>{announce(message||"Upload failed.","danger");progress.hidden=true};
const sha256=async file=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))).map(byte=>byte.toString(16).padStart(2,"0")).join("");
const finalize=async(intentId,versionId)=>{const response=await fetch("/projects/"+encodeURIComponent(config.projectId)+"/files/direct/intents/"+encodeURIComponent(intentId)+"/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({storage_version_id:versionId})});if(response.status===202){announce("Security scan in progress…","warning");setTimeout(()=>finalize(intentId,versionId).catch(error=>fail(error.message)),3000);return}if(!response.ok)throw new Error(await response.text());const receipt=await response.json();if(config.successLocation==="receipt")location.href="/projects/"+encodeURIComponent(config.projectId)+"/files/"+encodeURIComponent(receipt.file_reference_id);else location.reload()};
form.addEventListener("submit",async event=>{event.preventDefault();const file=input.files[0];if(!file)return;progress.hidden=false;progress.value=0;announce("Preparing private upload…");try{const digest=await sha256(file);const response=await fetch("/projects/"+encodeURIComponent(config.projectId)+"/files/direct/intents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({context_id:config.contextId,file_name:file.name,claimed_media_type:file.type||"application/octet-stream",byte_size:file.size,sha256:digest,replace_reference_id:config.replacesReferenceId})});if(!response.ok)throw new Error(await response.text());const intent=await response.json();const xhr=new XMLHttpRequest();xhr.open("PUT",intent.upload_url);for(const [name,value] of Object.entries(intent.upload_headers))xhr.setRequestHeader(name,value);xhr.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100};xhr.onerror=()=>fail("The private storage upload failed.");xhr.onload=()=>{if(xhr.status<200||xhr.status>=300)return fail("The private storage upload failed.");const versionId=xhr.getResponseHeader("x-amz-version-id");if(!versionId)return fail("Private storage did not expose the immutable object version.");announce("Upload received. Waiting for security scan…","warning");finalize(intent.intent_id,versionId).catch(error=>fail(error.message))};announce("Uploading directly to private storage…");xhr.send(file)}catch(error){fail(error.message)}});
</script>`;
}

function legacyUploadScript(action: string, successLocation: "reload" | "receipt"): string {
  return `<script>
const form=document.getElementById("file-upload"),input=document.getElementById("file"),progress=document.getElementById("progress"),status=document.getElementById("upload-status"),announce=(message,tone="")=>{status.textContent=message;status.className=tone?"notice "+tone:"notice"};form.addEventListener("submit",event=>{event.preventDefault();const file=input.files[0];if(!file)return;const xhr=new XMLHttpRequest();xhr.open("POST",${JSON.stringify(action)});xhr.setRequestHeader("Content-Type",file.type||"application/octet-stream");xhr.setRequestHeader("X-Alice-File-Name",encodeURIComponent(file.name));progress.hidden=false;announce("Uploading…");xhr.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100};xhr.onload=()=>{if(xhr.status===201){${successLocation === "receipt" ? 'const receipt=JSON.parse(xhr.responseText);location.href="/projects/"+encodeURIComponent(receipt.project_id||"")+"/files/"+encodeURIComponent(receipt.file_reference_id)' : "location.reload()"}}else{announce(xhr.responseText||"Upload failed.","danger")}};xhr.onerror=()=>{announce("Upload failed.","danger")};xhr.send(file)});
</script>`;
}

export function createFilesRouter({
  database,
  fileStore,
  publicUrl,
}: {
  database: unknown;
  fileStore: PrivateFileStore;
  publicUrl: string;
}) {
  const router = express.Router();
  const authenticated = requireAuthenticatedUser(database);

  router.get("/:projectId/files", authenticated, async (request, response) => {
    const projectOnly = !request.query.context_id;
    const contextId = await fileContextId(
      database,
      request.aliceUser!.id,
      request.params.projectId,
      request.query.context_id,
    );
    const view = await listProjectFiles(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId,
    });
    if (!view) return notFound(response);
    const rows = view.files
      .map(
        (file) =>
          `<article class="file-card${file.scan_status === "clean" ? "" : " unavailable"}"><h2>${escapeHtml(file.display_name)}</h2><p class="file-meta"><span>${escapeHtml(file.media_type)}</span><span>${Number(file.byte_size).toLocaleString()} bytes</span><span class="badge">${escapeHtml(statusCopy(file.scan_status))}</span></p><p class="muted">Source · ${escapeHtml(hostLabel(file.source_host))}</p><div class="actions"><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}">Details</a>${file.scan_status === "clean" ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/download">Download</a>` : ""}${view.access.can_write && file.scan_status === "scanning" ? `<form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/scan"><button type="submit">Check scan status</button></form>` : ""}${view.access.can_write ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/remove">Remove from project</a>` : ""}</div></article>`,
      )
      .join("");
    const removedRows = view.removed
      .map(
        (file) =>
          `<article class="file-card removed-file"><h3>${escapeHtml(file.display_name)}</h3><p><span class="badge">Removed</span> · ${escapeHtml(timestampLabel(file.removed_at))}</p>${file.removal_reason ? `<p><strong>Reason:</strong> ${escapeHtml(file.removal_reason)}</p>` : ""}<p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}">View preserved metadata</a></p></article>`,
      )
      .join("");
    const uploadSection = view.access.can_write
      ? `<section class="upload-panel"><h2>Add a file</h2><p>PDF, DOCX, XLSX, or PPTX up to 25 MiB; PNG, JPEG, or WebP up to 10 MiB; UTF-8 text, Markdown, CSV, TSV, or JSON up to 2 MiB.</p><p class="notice">The file remains unavailable until scanning reports no threats. Its contents do not become saved project information automatically. Modern Office files are reference and download only in this alpha.</p><form id="file-upload"><label>Choose a file<input id="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx" required></label><button type="submit">Upload and scan</button><progress id="progress" max="100" value="0" hidden></progress><p id="upload-status" role="status"></p></form></section>${fileStore.createSignedUpload ? directUploadScript({ projectId: request.params.projectId, contextId: view.context.context_id, successLocation: "reload" }) : legacyUploadScript(projectOnly ? request.path : `${request.path}?${new URLSearchParams({ context_id: view.context.context_id })}`, "reload")}`
      : "";
    if (projectOnly) {
      return response
        .type("html")
        .send(
          renderAppPage(
            `Files · ${view.context.project_name}`,
            `<div class="project-home"><header class="project-header"><div><p class="eyebrow">Project files</p><h1>${escapeHtml(view.context.project_name)}</h1><p>Files stay private and unavailable until scanning reports no threats.</p></div><a href="/projects/${encodeURIComponent(request.params.projectId)}">Back to project</a></header><section><div class="section-heading"><h2>Files (${view.files.length})</h2><p class="muted">Available only when scan-clean</p></div>${rows || '<div class="empty-state"><h2>No files yet</h2><p>Add a supported file when you want it attached to this project.</p></div>'}</section><section><div class="section-heading"><h2>Removed (${view.removed.length})</h2><p class="muted">Preserved history, no active access</p></div>${removedRows || '<div class="empty-state"><h2>No files have been removed</h2><p>Removed file records remain visible here with their preserved history.</p></div>'}</section>${uploadSection}<p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/export.json">Export file metadata</a></p></div>`,
            { email: request.aliceUser!.email, activeSection: "projects" },
          ),
        );
    }
    response
      .type("html")
      .send(
        renderPage(
          `Files · ${view.context.project_name}`,
          `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}">Back to project</a><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/export.json?context_id=${encodeURIComponent(view.context.context_id)}">Export metadata</a></nav><header class="hero"><p class="eyebrow">Private project files</p><h1>Files in ${escapeHtml(view.context.context_name)}</h1><p>Files remain private and unavailable until scanning reports no threats. File contents do not become saved assertions.</p></header><section><div class="section-heading"><h2>Active files (${view.files.length})</h2><p class="muted">Available only when scan-clean</p></div>${rows || '<div class="empty-state"><h2>No active files in this context</h2><p>Upload a supported file when you want a private, scan-gated reference.</p></div>'}</section><section><div class="section-heading"><h2>Removed (${view.removed.length})</h2><p class="muted">Preserved provenance, no active access</p></div>${removedRows || '<div class="empty-state"><h2>No files have been removed</h2><p>Removed file references remain visible here with their preserved metadata.</p></div>'}</section>${uploadSection}`,
        ),
      );
  });

  const exactOrigin = (request, response, next) => {
    if (request.get("origin") !== publicUrl) {
      return response.status(403).send("Upload origin denied.");
    }
    next();
  };

  router.post(
    "/:projectId/files/direct/intents",
    authenticated,
    exactOrigin,
    express.json({ limit: "8kb" }),
    async (request, response) => {
      try {
        const intent = await createProjectFileUploadIntent(database, fileStore, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          contextId: String(request.body.context_id || ""),
          fileName: String(request.body.file_name || ""),
          claimedMediaType: String(request.body.claimed_media_type || ""),
          byteSize: Number(request.body.byte_size),
          sha256: String(request.body.sha256 || ""),
          ...(request.body.replace_reference_id
            ? { replacesReferenceId: String(request.body.replace_reference_id) }
            : {}),
        });
        if (!intent) return notFound(response);
        response.set("Cache-Control", "no-store").status(201).json(intent);
      } catch (error) {
        response
          .status(error instanceof ProjectFileUserError ? 400 : 500)
          .send(
            error instanceof ProjectFileUserError
              ? error.message
              : "The private upload could not be started.",
          );
      }
    },
  );

  router.post(
    "/:projectId/files/direct/intents/:intentId/finalize",
    authenticated,
    exactOrigin,
    express.json({ limit: "4kb" }),
    async (request, response) => {
      try {
        const result = await finalizeProjectFileUpload(database, fileStore, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          intentId: request.params.intentId,
          storageVersionId: String(request.body.storage_version_id || ""),
        });
        if (!result) return notFound(response);
        response.set("Cache-Control", "no-store");
        if (result.status === "pending") return response.status(202).json(result);
        return response.status(201).json(result);
      } catch (error) {
        response
          .status(error instanceof ProjectFileUserError ? 400 : 500)
          .send(
            error instanceof ProjectFileUserError
              ? error.message
              : "The private upload could not be finalized.",
          );
      }
    },
  );

  router.post(
    "/:projectId/files",
    authenticated,
    exactOrigin,
    express.raw({ limit: FILE_UPLOAD_LIMIT_BYTES, type: () => true }),
    async (request, response) => {
      try {
        const encodedName = request.get("x-alice-file-name") || "";
        let fileName;
        try {
          fileName = decodeURIComponent(encodedName);
        } catch {
          return response.status(400).send("The file name is invalid.");
        }
        const replacesReferenceId = request.query.replace_reference_id
          ? String(request.query.replace_reference_id)
          : undefined;
        const contextId = await fileContextId(
          database,
          request.aliceUser!.id,
          request.params.projectId,
          request.query.context_id,
        );
        const uploadInput = {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          contextId,
          fileName,
          claimedMediaType: request.get("content-type") || "",
          bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          sourceHost: "alice_web",
          ...(replacesReferenceId ? { replacesReferenceId } : {}),
        };
        const uploaded = await uploadProjectFile(database, fileStore, uploadInput);
        if (!uploaded) return notFound(response);
        response.status(201).json({
          project_id: request.params.projectId,
          file_reference_id: uploaded.id,
          scan_status: uploaded.scan_status,
        });
      } catch (error) {
        response
          .status(error instanceof ProjectFileUserError ? 400 : 500)
          .send(
            error instanceof ProjectFileUserError
              ? error.message
              : "The private file upload could not be completed.",
          );
      }
    },
  );

  router.get("/:projectId/files/export.json", authenticated, async (request, response) => {
    const contextId = await fileContextId(
      database,
      request.aliceUser!.id,
      request.params.projectId,
      request.query.context_id,
    );
    const exported = await exportProjectFileMetadata(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId,
    });
    if (!exported) return notFound(response);
    response
      .set("Cache-Control", "no-store")
      .set("Content-Disposition", 'attachment; filename="alice-file-metadata.json"')
      .json(exported);
  });

  router.get("/:projectId/files/:referenceId", authenticated, async (request, response) => {
    const file = await getProjectFileView(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      referenceId: request.params.referenceId,
    });
    if (!file) return notFound(response);
    const permanentDeletionControl =
      file.access.project_role === "owner"
        ? `<section><h2>Permanent deletion</h2><p>Removing this file from a context preserves its immutable object and history. Permanent deletion is governed at the project level so shared immutable objects are not silently removed from another authorized project.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/lifecycle">Open project lifecycle</a></p></section>`
        : "<section><h2>Permanent deletion</h2><p>Removing this file from a context preserves its immutable object and history. A project Owner controls archive, export, and any project-level permanent-deletion request.</p></section>";
    response
      .type("html")
      .send(
        renderPage(
          file.display_name,
          `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files?context_id=${encodeURIComponent(file.context_id)}">Back to files</a></nav><header class="hero"><p class="eyebrow">File record</p><h1>${escapeHtml(file.display_name)}</h1><p><span class="badge">Version ${file.version}${file.is_current ? " · Current" : " · Superseded or processing"}</span></p></header>${file.exclusion_id ? `<p class="notice danger"><strong>Removed from active context</strong> · ${escapeHtml(timestampLabel(file.removed_at))}</p>${file.removal_reason ? `<p><strong>Reason:</strong> ${escapeHtml(file.removal_reason)}</p>` : ""}<p class="notice">The object metadata and audit history are preserved. This is not permanent erasure.</p>` : `<p class="notice${file.scan_status === "clean" ? "" : " warning"}"><strong>${escapeHtml(statusCopy(file.scan_status))}</strong></p>`}<section><h2>Verified record</h2><dl><dt>Project</dt><dd>${escapeHtml(file.project_name)}</dd><dt>Context and access</dt><dd>${escapeHtml(file.context_name)} · ${escapeHtml(accessLabel(file.visibility))}</dd><dt>Verified type</dt><dd>${escapeHtml(file.media_type)}</dd><dt>Size</dt><dd>${Number(file.byte_size).toLocaleString()} bytes</dd><dt>Source host</dt><dd>${escapeHtml(hostLabel(file.source_host))}</dd><dt>Referenced</dt><dd>${escapeHtml(timestampLabel(file.referenced_at))}</dd><dt>Last scan update</dt><dd>${escapeHtml(timestampLabel(file.scan_updated_at))}</dd><dt>File receipt</dt><dd><code>${escapeHtml(file.id)}</code></dd><dt>Immutable object receipt</dt><dd><code>${escapeHtml(file.file_object_id)}</code></dd></dl></section>${file.exclusion_id ? "" : `<div class="actions">${file.scan_status === "clean" && file.is_current ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/preview">Preview</a><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/download">Download</a><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/add-reference">Add to another context</a>` : ""}${file.access.can_write && file.can_replace ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/replace">Upload replacement</a>` : ""}${file.access.can_write ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/remove">Remove from context</a>` : ""}</div>`}<section><div class="section-heading"><h2>Version history</h2><p class="muted">Earlier versions retain provenance</p></div>${file.versions.map((version) => `<article class="file-card${version.id === file.current_reference_id ? "" : " unavailable"}"><h3>Version ${version.version} · ${escapeHtml(version.display_name)}</h3><p>${escapeHtml(statusCopy(version.scan_status))} · ${escapeHtml(timestampLabel(version.referenced_at))}</p>${version.id === file.current_reference_id ? "<p><strong>Current clean version</strong></p>" : ""}<p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(version.id)}">View this version</a></p></article>`).join("")}</section>${permanentDeletionControl}`,
        ),
      );
  });

  router.get(
    "/:projectId/files/:referenceId/add-reference",
    authenticated,
    async (request, response) => {
      const preview = await getProjectFileReferencePreview(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        referenceId: request.params.referenceId,
      });
      if (!preview) return notFound(response);
      const destinations = preview.destinations
        .map(
          (context) =>
            `<article class="file-card"><h2>${escapeHtml(context.name)}</h2><p>Access will follow ${escapeHtml(accessLabel(context.visibility))}.</p><form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}/add-reference"><input type="hidden" name="target_context_id" value="${escapeHtml(context.id)}"><input type="hidden" name="preview_version" value="${escapeHtml(context.preview_version)}"><button type="submit">Add reference to this context</button></form></article>`,
        )
        .join("");
      response
        .type("html")
        .send(
          renderPage(
            "Add file to another context",
            `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Back to file</a></nav><header class="hero"><p class="eyebrow">Explicit context access</p><h1>Add ${escapeHtml(preview.reference.display_name)} to another context</h1><p>This creates a separate access-controlled reference to the same scan-clean immutable object. No file bytes are copied, and access is granted only through the context you choose.</p></header>${destinations || '<div class="empty-state"><h2>No eligible contexts</h2><p>You need write access to another context that does not already reference this exact object.</p></div>'}`,
          ),
        );
    },
  );

  router.post(
    "/:projectId/files/:referenceId/add-reference",
    authenticated,
    async (request, response) => {
      let result;
      try {
        result = await referenceProjectFileInContext(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          referenceId: request.params.referenceId,
          targetContextId: String(request.body.target_context_id || ""),
          expectedPreviewVersion: String(request.body.preview_version || ""),
        });
      } catch {
        return response
          .status(500)
          .type("html")
          .send(
            renderStatusPage(
              "File not added",
              `<h1>The file reference could not be added.</h1><p>No file bytes or context access changed.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
              "danger",
            ),
          );
      }
      if (!result) return notFound(response);
      if (result.conflict) {
        return response
          .status(409)
          .type("html")
          .send(
            renderStatusPage(
              "File or context changed",
              `<h1>The file or destination context changed.</h1><p>No reference was created. Review the current choices before deciding.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}/add-reference">Review eligible contexts</a></p>`,
            ),
          );
      }
      response.redirect(
        303,
        `/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(result.referenceId)}`,
      );
    },
  );

  router.get("/:projectId/files/:referenceId/replace", authenticated, async (request, response) => {
    const file = await getProjectFileView(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      referenceId: request.params.referenceId,
    });
    if (!file) return notFound(response);
    if (!file.access.can_write) return notFound(response);
    if (!file.can_replace) {
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Replacement unavailable",
            `<h1>This file cannot be replaced now.</h1><p>The current file and version history were not changed.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}">Return to the file</a></p>`,
          ),
        );
    }
    response
      .type("html")
      .send(
        renderPage(
          "Upload replacement",
          `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}">Back to file</a></nav><header class="hero"><p class="eyebrow">Replacement upload</p><h1>Upload a replacement for ${escapeHtml(file.display_name)}</h1><p>The old clean version remains current while the changed replacement is scanned. A failed replacement never replaces the current clean version.</p></header><form id="file-upload"><label>Choose the exact replacement file<input id="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx" required></label><p id="selection" class="notice" role="status">Choose the exact replacement file.</p><button type="submit">Upload replacement and scan</button><progress id="progress" max="100" value="0" hidden></progress><p id="upload-status" role="status"></p></form><script>document.getElementById("file").addEventListener("change",event=>{const selected=event.target.files[0];document.getElementById("selection").textContent=selected?selected.name+" · "+selected.type+" · "+selected.size+" bytes":"Choose the exact replacement file."})</script>${fileStore.createSignedUpload ? directUploadScript({ projectId: request.params.projectId, contextId: file.context_id, replacesReferenceId: file.id, successLocation: "receipt" }) : legacyUploadScript(`/projects/${encodeURIComponent(request.params.projectId)}/files?context_id=${encodeURIComponent(file.context_id)}&replace_reference_id=${encodeURIComponent(file.id)}`, "receipt")}`,
        ),
      );
  });

  router.get("/:projectId/files/:referenceId/preview", authenticated, async (request, response) => {
    try {
      const preview = await getProjectFilePreview(database, fileStore, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        referenceId: request.params.referenceId,
      });
      if (!preview) return notFound(response);
      if (!preview.available) {
        return response
          .status(409)
          .type("html")
          .send(
            renderStatusPage(
              "Preview unavailable",
              `<h1>This file cannot be previewed.</h1><p>The file remains unavailable unless its exact current version is scan-clean and accessible.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
            ),
          );
      }
      response.set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff");
      if (preview.kind === "metadata_only") {
        return response
          .status(409)
          .type("html")
          .send(
            renderStatusPage(
              "Inline preview unavailable",
              `<h1>This file type is not rendered inline.</h1><p>Review metadata or download it explicitly.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
              "neutral",
            ),
          );
      }
      if (preview.kind === "text") {
        return response
          .type("html")
          .send(
            renderPage(
              "Untrusted file preview",
              `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Back to file</a></nav><header class="hero"><p class="eyebrow">Untrusted file data</p><h1>Untrusted text preview</h1><p>File text is displayed as data. It is not an instruction to alice.</p></header><pre>${escapeHtml(preview.text)}</pre>`,
            ),
          );
      }
      response.set("Content-Security-Policy", "sandbox; default-src 'none'");
      return response.type(preview.media_type).send(preview.bytes);
    } catch {
      return response
        .status(502)
        .type("html")
        .send(
          renderStatusPage(
            "Preview unavailable",
            `<h1>The verified file preview could not be loaded.</h1><p>No file or project state was changed.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
            "danger",
          ),
        );
    }
  });

  router.get("/:projectId/files/:referenceId/remove", authenticated, async (request, response) => {
    const preview = await getProjectFileRemovalPreview(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      referenceId: request.params.referenceId,
    });
    if (!preview) return notFound(response);
    response
      .type("html")
      .send(
        renderPage(
          "Remove file from context",
          `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(preview.id)}">Back to file</a></nav><header class="hero"><p class="eyebrow">Remove from active context</p><h1>Remove ${escapeHtml(preview.display_name)} from ${escapeHtml(preview.context_name)}?</h1><p>This immediately stops download and normal context access through this reference. It preserves the immutable object metadata, provenance, scan result, and audit history. It is not permanent deletion.</p></header><article class="file-card unavailable"><p>${escapeHtml(preview.media_type)} · ${Number(preview.byte_size).toLocaleString()} bytes · ${escapeHtml(statusCopy(preview.scan_status))}</p><p>Access currently follows ${escapeHtml(preview.context_name)} · ${escapeHtml(accessLabel(preview.visibility))}</p></article><form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(preview.id)}/remove"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><label>Reason (optional)<textarea name="reason" maxlength="500"></textarea></label><button class="destructive" type="submit">Remove from context</button></form><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(preview.id)}">Keep this file active</a></p>`,
        ),
      );
  });

  router.post("/:projectId/files/:referenceId/remove", authenticated, async (request, response) => {
    let result;
    try {
      result = await removeProjectFileReference(database, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        referenceId: request.params.referenceId,
        expectedPreviewVersion: String(request.body.preview_version || ""),
        reason: request.body.reason,
      });
    } catch (error) {
      const message =
        error instanceof ProjectFileUserError
          ? error.message
          : "The file reference could not be removed.";
      return response
        .status(error instanceof ProjectFileUserError ? 400 : 500)
        .type("html")
        .send(
          renderStatusPage(
            "File not removed",
            `<h1>File not removed</h1><p>${escapeHtml(message)}</p><p>The active reference and preserved metadata were not changed.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
            "danger",
          ),
        );
    }
    if (!result) return notFound(response);
    if (result.conflict) {
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "File reference changed",
            `<h1>This file reference changed.</h1><p>Nothing was removed or overwritten.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Review it before deciding</a></p>`,
          ),
        );
    }
    response.redirect(
      303,
      `/projects/${encodeURIComponent(request.params.projectId)}/files?context_id=${encodeURIComponent(result.contextId)}`,
    );
  });

  router.post("/:projectId/files/:referenceId/scan", authenticated, async (request, response) => {
    try {
      const result = await refreshProjectFileScan(database, fileStore, {
        userId: request.aliceUser!.id,
        projectId: request.params.projectId,
        referenceId: request.params.referenceId,
      });
      if (!result) return notFound(response);
      response.redirect(
        303,
        `/projects/${encodeURIComponent(request.params.projectId)}/files?context_id=${encodeURIComponent(result.context_id)}`,
      );
    } catch {
      response
        .status(502)
        .type("html")
        .send(
          renderStatusPage(
            "Scan check unavailable",
            `<h1>Scan status could not be checked.</h1><p>The file remains unavailable.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
            "danger",
          ),
        );
    }
  });

  router.get(
    "/:projectId/files/:referenceId/download",
    authenticated,
    async (request, response) => {
      try {
        const result = await getProjectFileDownload(database, fileStore, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          referenceId: request.params.referenceId,
        });
        if (!result) return notFound(response);
        if (!result.available) {
          return response
            .status(409)
            .type("html")
            .send(
              renderStatusPage(
                "Download unavailable",
                `<h1>This file is not available for download.</h1><p>Only an accessible, current, scan-clean version can be downloaded.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
              ),
            );
        }
        response.set("Cache-Control", "no-store");
        response.redirect(302, result.url);
      } catch {
        response
          .status(502)
          .type("html")
          .send(
            renderStatusPage(
              "Download unavailable",
              `<h1>A private download could not be created.</h1><p>No file or project state was changed.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Return to the file</a></p>`,
              "danger",
            ),
          );
      }
    },
  );

  return router;
}
