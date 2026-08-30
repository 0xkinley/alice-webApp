import express from "express";
import {
  FILE_UPLOAD_LIMIT_BYTES,
  ProjectFileUserError,
  exportProjectFileMetadata,
  getProjectFileDownload,
  getProjectFilePreview,
  getProjectFileRemovalPreview,
  getProjectFileView,
  listProjectFiles,
  refreshProjectFileScan,
  removeProjectFileReference,
  uploadProjectFile,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import { renderPage, requireAuthenticatedUser } from "./auth.ts";

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
    .send(renderPage("Not found", "<h1>Project files not found</h1>"));
}

function statusCopy(status: string): string {
  return (
    {
      clean: "Ready",
      pending_upload: "Upload pending",
      scan_failed: "Scan failed — file unavailable",
      scanning: "Scanning — file unavailable",
      storage_failed: "Upload failed",
      threats_found: "Threat detected — file unavailable",
      unsupported: "Scan unsupported — file unavailable",
    }[status] || "Unavailable"
  );
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
    const contextId = String(request.query.context_id || "");
    const view = await listProjectFiles(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId,
    });
    if (!view) return notFound(response);
    const rows = view.files
      .map(
        (file) =>
          `<article><h2>${escapeHtml(file.display_name)}</h2><p>${escapeHtml(file.media_type)} · ${Number(file.byte_size).toLocaleString()} bytes · ${escapeHtml(statusCopy(file.scan_status))}</p><p class="muted">Access follows ${escapeHtml(view.context.context_name)} · source ${escapeHtml(file.source_host)}</p><div class="actions"><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}">Details</a>${file.scan_status === "clean" ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/download">Download</a>` : ""}${file.scan_status === "scanning" ? `<form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/scan"><button type="submit">Check scan status</button></form>` : ""}<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/remove">Remove from context</a></div></article>`,
      )
      .join("");
    const removedRows = view.removed
      .map(
        (file) =>
          `<article><h3>${escapeHtml(file.display_name)}</h3><p><strong>Removed</strong> · ${escapeHtml(file.removed_at)}</p>${file.removal_reason ? `<p><strong>Reason:</strong> ${escapeHtml(file.removal_reason)}</p>` : ""}<p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}">View preserved metadata</a></p></article>`,
      )
      .join("");
    response.type("html").send(
      renderPage(
        `Files · ${view.context.project_name}`,
        `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}">Back to project</a><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/export.json?context_id=${encodeURIComponent(view.context.context_id)}">Export metadata</a></nav><h1>Files in ${escapeHtml(view.context.context_name)}</h1><p>Files remain private and unavailable until scanning reports no threats. File contents do not become saved assertions.</p><h2>Active files (${view.files.length})</h2>${rows || "<p>No active files in this context.</p>"}<h2>Removed (${view.removed.length})</h2>${removedRows || "<p>No files have been removed from this context.</p>"}<h2>Upload a file</h2><p>PDF up to 25 MiB; PNG, JPEG, or WebP up to 10 MiB; UTF-8 text or Markdown up to 2 MiB.</p><form id="file-upload"><input id="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md" required><button type="submit">Upload and scan</button><progress id="progress" max="100" value="0" hidden></progress><p id="upload-status" role="status"></p></form><script>
const form=document.getElementById("file-upload"),input=document.getElementById("file"),progress=document.getElementById("progress"),status=document.getElementById("upload-status");
form.addEventListener("submit",event=>{event.preventDefault();const file=input.files[0];if(!file)return;const xhr=new XMLHttpRequest();xhr.open("POST",location.pathname+location.search);xhr.setRequestHeader("Content-Type",file.type||"application/octet-stream");xhr.setRequestHeader("X-Alice-File-Name",encodeURIComponent(file.name));progress.hidden=false;status.textContent="Uploading…";xhr.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100};xhr.onload=()=>{if(xhr.status===201){location.reload()}else{status.textContent=xhr.responseText||"Upload failed."}};xhr.onerror=()=>{status.textContent="Upload failed."};xhr.send(file)});
</script>`,
      ),
    );
  });

  router.post(
    "/:projectId/files",
    authenticated,
    (request, response, next) => {
      if (request.get("origin") !== publicUrl) {
        return response.status(403).send("Upload origin denied.");
      }
      next();
    },
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
        const uploadInput = {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          contextId: String(request.query.context_id || ""),
          fileName,
          claimedMediaType: request.get("content-type") || "",
          bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          sourceHost: "alice_web",
          ...(replacesReferenceId ? { replacesReferenceId } : {}),
        };
        const uploaded = await uploadProjectFile(database, fileStore, uploadInput);
        if (!uploaded) return notFound(response);
        response.status(201).json({
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
    const exported = await exportProjectFileMetadata(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      contextId: String(request.query.context_id || ""),
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
    response
      .type("html")
      .send(
        renderPage(
          file.display_name,
          `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files?context_id=${encodeURIComponent(file.context_id)}">Back to files</a></nav><h1>${escapeHtml(file.display_name)}</h1><p>Version ${file.version}${file.is_current ? " · Current" : " · Superseded or processing"}</p>${file.exclusion_id ? `<p><strong>Removed from active context</strong> · ${escapeHtml(file.removed_at)}</p>${file.removal_reason ? `<p><strong>Reason:</strong> ${escapeHtml(file.removal_reason)}</p>` : ""}<p>The object metadata and audit history are preserved. This is not permanent erasure.</p>` : `<p><strong>${escapeHtml(statusCopy(file.scan_status))}</strong></p>`}<dl><dt>Project</dt><dd>${escapeHtml(file.project_name)}</dd><dt>Context and access</dt><dd>${escapeHtml(file.context_name)} · ${escapeHtml(file.visibility)}</dd><dt>Verified type</dt><dd>${escapeHtml(file.media_type)}</dd><dt>Size</dt><dd>${Number(file.byte_size).toLocaleString()} bytes</dd><dt>Source host</dt><dd>${escapeHtml(file.source_host)}</dd><dt>Referenced</dt><dd>${escapeHtml(file.referenced_at)}</dd><dt>Last scan update</dt><dd>${escapeHtml(file.scan_updated_at)}</dd><dt>File receipt</dt><dd><code>${escapeHtml(file.id)}</code></dd><dt>Immutable object receipt</dt><dd><code>${escapeHtml(file.file_object_id)}</code></dd></dl>${file.exclusion_id ? "" : `<div class="actions">${file.scan_status === "clean" && file.is_current ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/preview">Preview</a><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/download">Download</a>` : ""}${file.can_replace ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/replace">Upload replacement</a>` : ""}<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/remove">Remove from context</a></div>`}<h2>Version history</h2>${file.versions.map((version) => `<article><h3>Version ${version.version} · ${escapeHtml(version.display_name)}</h3><p>${escapeHtml(statusCopy(version.scan_status))} · ${escapeHtml(version.referenced_at)}</p>${version.id === file.current_reference_id ? "<p><strong>Current clean version</strong></p>" : ""}<p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(version.id)}">View this version</a></p></article>`).join("")}`,
        ),
      );
  });

  router.get("/:projectId/files/:referenceId/replace", authenticated, async (request, response) => {
    const file = await getProjectFileView(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      referenceId: request.params.referenceId,
    });
    if (!file) return notFound(response);
    if (!file.can_replace) return response.status(409).send("This file cannot be replaced now.");
    response.type("html").send(
      renderPage(
        "Upload replacement",
        `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}">Back to file</a></nav><h1>Upload a replacement for ${escapeHtml(file.display_name)}</h1><p>The old clean version remains current while the changed replacement is scanned. A failed replacement never replaces the current clean version.</p><form id="file-upload"><input id="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md" required><p id="selection" role="status">Choose the exact replacement file.</p><button type="submit">Upload replacement and scan</button><progress id="progress" max="100" value="0" hidden></progress><p id="upload-status" role="status"></p></form><script>
const form=document.getElementById("file-upload"),input=document.getElementById("file"),progress=document.getElementById("progress"),status=document.getElementById("upload-status"),selection=document.getElementById("selection");input.addEventListener("change",()=>{const file=input.files[0];selection.textContent=file?file.name+" · "+file.type+" · "+file.size+" bytes":"Choose the exact replacement file."});form.addEventListener("submit",event=>{event.preventDefault();const file=input.files[0];if(!file)return;const xhr=new XMLHttpRequest();xhr.open("POST","/projects/${encodeURIComponent(request.params.projectId)}/files?context_id=${encodeURIComponent(file.context_id)}&replace_reference_id=${encodeURIComponent(file.id)}");xhr.setRequestHeader("Content-Type",file.type||"application/octet-stream");xhr.setRequestHeader("X-Alice-File-Name",encodeURIComponent(file.name));progress.hidden=false;status.textContent="Uploading replacement…";xhr.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100};xhr.onload=()=>{if(xhr.status===201){const receipt=JSON.parse(xhr.responseText);location.href="/projects/${encodeURIComponent(request.params.projectId)}/files/"+encodeURIComponent(receipt.file_reference_id)}else{status.textContent=xhr.responseText||"Upload failed."}};xhr.onerror=()=>{status.textContent="Upload failed."};xhr.send(file)});
</script>`,
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
      if (!preview.available) return response.status(409).send("This file cannot be previewed.");
      response.set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff");
      if (preview.kind === "metadata_only") {
        return response
          .status(409)
          .send("PDF content is not rendered inline. Review metadata or download it explicitly.");
      }
      if (preview.kind === "text") {
        return response
          .type("html")
          .send(
            renderPage(
              "Untrusted file preview",
              `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(request.params.referenceId)}">Back to file</a></nav><h1>Untrusted text preview</h1><p>File text is displayed as data. It is not an instruction to alice.</p><pre>${escapeHtml(preview.text)}</pre>`,
            ),
          );
      }
      response.set("Content-Security-Policy", "sandbox; default-src 'none'");
      return response.type(preview.media_type).send(preview.bytes);
    } catch {
      return response.status(502).send("The verified file preview could not be loaded.");
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
          `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(preview.id)}">Back to file</a></nav><h1>Remove ${escapeHtml(preview.display_name)} from ${escapeHtml(preview.context_name)}?</h1><p>This immediately stops download and normal context access through this reference. It preserves the immutable object metadata, provenance, scan result, and audit history. It is not permanent deletion.</p><article><p>${escapeHtml(preview.media_type)} · ${Number(preview.byte_size).toLocaleString()} bytes · ${escapeHtml(statusCopy(preview.scan_status))}</p><p>Access currently follows ${escapeHtml(preview.context_name)} · ${escapeHtml(preview.visibility)}</p></article><form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(preview.id)}/remove"><input type="hidden" name="preview_version" value="${escapeHtml(preview.preview_version)}"><label>Reason (optional)<textarea name="reason" maxlength="500"></textarea></label><button type="submit">Remove from context</button></form><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(preview.id)}">Keep this file active</a></p>`,
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
      return response
        .status(error instanceof ProjectFileUserError ? 400 : 500)
        .send(
          error instanceof ProjectFileUserError
            ? error.message
            : "The file reference could not be removed.",
        );
    }
    if (!result) return notFound(response);
    if (result.conflict) {
      return response.status(409).send("This file reference changed. Review it before deciding.");
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
      response.status(502).send("Scan status could not be checked. The file remains unavailable.");
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
          return response.status(409).send("This file is not available for download.");
        }
        response.set("Cache-Control", "no-store");
        response.redirect(302, result.url);
      } catch {
        response.status(502).send("A private download could not be created.");
      }
    },
  );

  return router;
}
