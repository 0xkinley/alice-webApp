import express from "express";
import {
  FILE_UPLOAD_LIMIT_BYTES,
  ProjectFileUserError,
  getProjectFileDownload,
  listProjectFiles,
  refreshProjectFileScan,
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
          `<article><h2>${escapeHtml(file.display_name)}</h2><p>${escapeHtml(file.media_type)} · ${Number(file.byte_size).toLocaleString()} bytes · ${escapeHtml(statusCopy(file.scan_status))}</p><p class="muted">Access follows ${escapeHtml(view.context.context_name)} · source ${escapeHtml(file.source_host)}</p><div class="actions">${file.scan_status === "clean" ? `<a href="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/download">Download</a>` : ""}${file.scan_status === "scanning" ? `<form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/files/${encodeURIComponent(file.id)}/scan"><button type="submit">Check scan status</button></form>` : ""}</div></article>`,
      )
      .join("");
    response.type("html").send(
      renderPage(
        `Files · ${view.context.project_name}`,
        `<nav><a href="/projects/${encodeURIComponent(request.params.projectId)}">Back to project</a></nav><h1>Files in ${escapeHtml(view.context.context_name)}</h1><p>Files remain private and unavailable until scanning reports no threats. File contents do not become saved assertions.</p>${rows || "<p>No files in this context.</p>"}<h2>Upload a file</h2><p>PDF up to 25 MiB; PNG, JPEG, or WebP up to 10 MiB; UTF-8 text or Markdown up to 2 MiB.</p><form id="file-upload"><input id="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md" required><button type="submit">Upload and scan</button><progress id="progress" max="100" value="0" hidden></progress><p id="upload-status" role="status"></p></form><script>
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
        const uploaded = await uploadProjectFile(database, fileStore, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          contextId: String(request.query.context_id || ""),
          fileName,
          claimedMediaType: request.get("content-type") || "",
          bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          sourceHost: "alice_web",
        });
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
