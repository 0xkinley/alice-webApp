import {
  beginHostFileSaveTransfer,
  decideHostFileSaveOffer,
  finalizeHostFileSaveTransfer,
  getHostFileSaveOfferPreview,
  HostFileSaveOfferUserError,
  ProjectFileUserError,
} from "@alice/domain";
import type { HostFileSaveDecision, PrivateFileStore } from "@alice/domain";
import express from "express";
import { renderPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { hostLabel, timestampLabel } from "./product-copy.ts";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function optionalFileMetadata(offer) {
  const rows: string[] = [];
  if (offer.file.declared_media_type) {
    rows.push(
      `<dt>Host-reported type</dt><dd>${escapeHtml(offer.file.declared_media_type)} · verified after transfer</dd>`,
    );
  }
  if (offer.file.declared_byte_size !== null) {
    rows.push(
      `<dt>Host-reported size</dt><dd>${Number(offer.file.declared_byte_size).toLocaleString()} bytes · verified after transfer</dd>`,
    );
  }
  return rows.join("");
}

function decisionSummary(status, projectName?: string) {
  if (status === "save_file_only") return `Save to ${projectName || "the project"}`;
  if (status === "save_and_suggest_context") return "Previously authorized file save";
  if (status === "cancelled") return "Cancelled. No file transfer authorized.";
  return "Awaiting your decision";
}

function fallbackUploadScript(offer): string {
  const configuration = JSON.stringify({
    offerId: offer.offer_id,
    exactFileName: offer.file.name,
  }).replaceAll("<", "\\u003c");
  return `<script>
const config=${configuration},form=document.getElementById("file-save-upload"),input=document.getElementById("file-save-file"),progress=document.getElementById("file-save-progress"),status=document.getElementById("file-save-status"),attemptKey="browser-"+crypto.randomUUID();
const announce=(message,tone="")=>{status.textContent=message;status.className=tone?"notice "+tone:"notice"};
const fail=message=>{announce(message||"Upload failed.","danger");progress.hidden=true};
const sha256=async file=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))).map(byte=>byte.toString(16).padStart(2,"0")).join("");
const finalize=async(intentId,versionId)=>{const response=await fetch("/file-save-offers/"+encodeURIComponent(config.offerId)+"/direct/intents/"+encodeURIComponent(intentId)+"/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({storage_version_id:versionId})});if(response.status===202){const pending=await response.json();announce(pending.stage==="final_security_scan"?"Exact bytes received. Final private-file scan in progress…":"Staging security scan in progress…","warning");setTimeout(()=>finalize(intentId,versionId).catch(error=>fail(error.message)),3000);return}if(!response.ok)throw new Error(await response.text());const receipt=await response.json();location.href="/projects/"+encodeURIComponent(receipt.project_id)+"/files/"+encodeURIComponent(receipt.file_reference_id)};
form.addEventListener("submit",async event=>{event.preventDefault();const file=input.files[0];if(!file)return;if(file.name!==config.exactFileName)return fail("Choose the exact confirmed file: "+config.exactFileName);progress.hidden=false;progress.value=0;announce("Verifying the exact file locally…");try{const digest=await sha256(file);const response=await fetch("/file-save-offers/"+encodeURIComponent(config.offerId)+"/direct/intents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file_name:file.name,claimed_media_type:file.type||"application/octet-stream",byte_size:file.size,sha256:digest,idempotency_key:attemptKey})});if(!response.ok)throw new Error(await response.text());const intent=await response.json();if(intent.status==="completed"){location.href="/projects/"+encodeURIComponent(intent.project_id)+"/files/"+encodeURIComponent(intent.file_reference_id);return}const xhr=new XMLHttpRequest();xhr.open("PUT",intent.upload_url);for(const [name,value] of Object.entries(intent.upload_headers))xhr.setRequestHeader(name,value);xhr.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100};xhr.onerror=()=>fail("The private storage upload failed.");xhr.onload=()=>{if(xhr.status<200||xhr.status>=300)return fail("The private storage upload failed.");const versionId=xhr.getResponseHeader("x-amz-version-id");if(!versionId)return fail("Private storage did not expose the immutable object version.");announce("Upload received. Waiting for the security gate…","warning");finalize(intent.intent_id,versionId).catch(error=>fail(error.message))};announce("Uploading directly to alice. private storage…");xhr.send(file)}catch(error){fail(error.message)}});
</script>`;
}

function transferSection(offer, directUploadAvailable: boolean) {
  if (!["save_file_only", "save_and_suggest_context"].includes(offer.status)) return "";
  if (offer.transfer?.status === "completed") {
    return `<section><h2>File saved</h2><p class="notice"><strong>Scan-clean and available.</strong> The exact file is now available in the confirmed project.</p><p><a href="/projects/${encodeURIComponent(offer.transfer.project_id)}/files/${encodeURIComponent(offer.transfer.file_reference_id)}">View the saved file receipt</a></p></section>`;
  }
  if (offer.transfer) {
    return '<section><h2>Transfer processing</h2><p class="notice warning">The exact bytes were received, but the final private-file security scan has not completed. alice. is not claiming the file is available yet.</p></section>';
  }
  if (offer.transfer_authority_expired) {
    return '<section><h2>Upload unavailable</h2><p class="notice warning">This exact transfer authority expired. Ask the host for a new save offer. No bytes were received.</p></section>';
  }
  if (!directUploadAvailable) {
    return '<section><h2>Browser fallback unavailable</h2><p class="notice warning">This deployment cannot create a direct private upload. No bytes were received.</p></section>';
  }
  return `<section class="upload-panel"><p class="eyebrow">Provider transfer fallback</p><h2>Upload the exact file to alice.</h2><p>The destination is locked to <strong>${escapeHtml(offer.destination.project_name)}</strong>. Choose only <strong>${escapeHtml(offer.file.name)}</strong>. The browser hashes it locally, uploads directly to private storage, and waits for both security gates.</p><form id="file-save-upload"><label>Exact confirmed file<input id="file-save-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx" required></label><button type="submit">Upload exact file and scan</button><progress id="file-save-progress" max="100" value="0" hidden></progress><p id="file-save-status" role="status"></p></form></section>${fallbackUploadScript(offer)}`;
}

function offerPage(offer, directUploadAvailable: boolean) {
  const unavailable = offer.expired;
  const pending = offer.status === "pending";
  const notice = !pending
    ? `<p class="notice"><strong>Already decided:</strong> ${escapeHtml(decisionSummary(offer.status, offer.destination.project_name))}. No attachment bytes were received by this confirmation step.</p>`
    : offer.expired
      ? '<p class="notice warning"><strong>This offer expired.</strong> Ask the host for a new exact preview. No attachment bytes were received.</p>'
      : '<p class="notice"><strong>No file has been copied.</strong> Confirming authorizes transfer only for the exact project below. alice. still verifies, scans, stores, and authorizes the bytes before claiming the file is saved.</p>';
  const actions =
    pending && !unavailable
      ? `<form method="post" action="/file-save-offers/${encodeURIComponent(offer.offer_id)}/decision"><input type="hidden" name="preview_version" value="${escapeHtml(offer.decision_version)}"><input type="hidden" name="decision" value="save_file_only"><button type="submit">Save</button></form>`
      : "";
  const conversation = offer.conversation_reference
    ? `<dt>Conversation reference</dt><dd><code>${escapeHtml(offer.conversation_reference)}</code> · opaque identifier only</dd>`
    : "";
  return renderPage(
    "Host file save offer",
    `<nav><a href="/">Private workspace</a><a href="/connections">AI connections</a></nav><header class="hero"><p class="eyebrow">Exact attachment preview</p><h1>Save this file to alice.?</h1><p>The host cannot answer this question for you. Only this authenticated alice. action can authorize attachment transfer.</p></header>${notice}<section><h2>Exact file and project</h2><dl><dt>Filename</dt><dd>${escapeHtml(offer.file.name)}</dd>${optionalFileMetadata(offer)}<dt>Project</dt><dd>${escapeHtml(offer.destination.project_name)}</dd><dt>Source host</dt><dd>${escapeHtml(hostLabel(offer.source_host))}</dd>${conversation}<dt>Offer expires</dt><dd>${escapeHtml(timestampLabel(offer.expires_at))}</dd><dt>Offer receipt</dt><dd><code>${escapeHtml(offer.offer_id)}</code></dd></dl></section>${actions}${transferSection(offer, directUploadAvailable)}<p class="muted">The saved file becomes an untrusted project reference after its security scans pass. It does not enter Needs attention or turn file contents into trusted project information.</p>`,
  );
}

export function createHostFileSaveOffersRouter({
  database,
  fileStore,
  publicUrl,
}: {
  database: unknown;
  fileStore: PrivateFileStore;
  publicUrl: string;
}) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/:offerId", async (request, response) => {
    const offer = await getHostFileSaveOfferPreview(database, {
      userId: request.aliceUser!.id,
      offerId: request.params.offerId,
      publicUrl,
    });
    if (!offer) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "File save offer not found",
            '<h1>File save offer not found</h1><p>It may be unavailable or belong to another alice. account or context. No attachment bytes were received.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    response.type("html").send(offerPage(offer, Boolean(fileStore.createSignedUpload)));
  });

  router.post("/:offerId/decision", async (request, response) => {
    try {
      const result = await decideHostFileSaveOffer(database, {
        userId: request.aliceUser!.id,
        offerId: request.params.offerId,
        previewVersion: String(request.body.preview_version || ""),
        decision: String(request.body.decision || "") as HostFileSaveDecision,
        authority: "web_session",
        publicUrl,
      });
      if (!result) {
        return response
          .status(404)
          .type("html")
          .send(
            renderStatusPage(
              "File save offer not found",
              '<h1>File save offer not found</h1><p>No attachment transfer was authorized.</p><p><a href="/">Return to your private workspace</a></p>',
              "neutral",
            ),
          );
      }
      response
        .type("html")
        .send(
          renderStatusPage(
            "File transfer authorized",
            `<h1>Transfer authorized</h1><p>Return to ${escapeHtml(hostLabel(result.source_host))} if it supports secure attachment transfer. Otherwise, use the alice.-controlled upload below.</p><p><strong>The file is not saved yet.</strong> alice. will claim success only after receiving, verifying, scanning, storing, authorizing, and auditing the bytes.</p><p><a class="button" href="/file-save-offers/${encodeURIComponent(result.offer_id)}">Upload the exact file or view transfer status</a></p>`,
            "warning",
          ),
        );
    } catch (error) {
      if (!(error instanceof HostFileSaveOfferUserError)) throw error;
      response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "File save decision not recorded",
            `<h1>Decision not recorded</h1><p>${escapeHtml(error.message)}</p><p>No attachment transfer was authorized by this request.</p><p><a href="/file-save-offers/${encodeURIComponent(request.params.offerId)}">Return to the exact preview</a></p>`,
            "danger",
          ),
        );
    }
  });

  const exactOrigin = (request, response, next) => {
    if (request.get("origin") !== publicUrl) {
      return response.status(403).send("Upload origin denied.");
    }
    next();
  };

  const transferNotFound = (response) =>
    response
      .status(404)
      .send("The confirmed file transfer is unavailable for this account or destination.");

  router.post(
    "/:offerId/direct/intents",
    exactOrigin,
    express.json({ limit: "8kb" }),
    async (request, response) => {
      try {
        const result = await beginHostFileSaveTransfer(database, fileStore, {
          userId: request.aliceUser!.id,
          offerId: request.params.offerId,
          transferPath: "browser_fallback",
          fileName: String(request.body.file_name || ""),
          claimedMediaType: String(request.body.claimed_media_type || ""),
          byteSize: Number(request.body.byte_size),
          sha256: String(request.body.sha256 || ""),
          idempotencyKey: String(request.body.idempotency_key || ""),
        });
        if (!result) return transferNotFound(response);
        response
          .set("Cache-Control", "no-store")
          .status(result.status === "completed" ? 200 : 201)
          .json(result);
      } catch (error) {
        response
          .status(
            error instanceof HostFileSaveOfferUserError || error instanceof ProjectFileUserError
              ? 400
              : 500,
          )
          .send(
            error instanceof HostFileSaveOfferUserError || error instanceof ProjectFileUserError
              ? error.message
              : "The exact private transfer could not be started.",
          );
      }
    },
  );

  router.post(
    "/:offerId/direct/intents/:intentId/finalize",
    exactOrigin,
    express.json({ limit: "4kb" }),
    async (request, response) => {
      try {
        const result = await finalizeHostFileSaveTransfer(database, fileStore, {
          userId: request.aliceUser!.id,
          offerId: request.params.offerId,
          intentId: request.params.intentId,
          transferPath: "browser_fallback",
          storageVersionId: String(request.body.storage_version_id || ""),
        });
        if (!result) return transferNotFound(response);
        response.set("Cache-Control", "no-store");
        if (result.status === "pending") return response.status(202).json(result);
        return response.status(201).json(result);
      } catch (error) {
        response
          .status(
            error instanceof HostFileSaveOfferUserError || error instanceof ProjectFileUserError
              ? 400
              : 500,
          )
          .send(
            error instanceof HostFileSaveOfferUserError || error instanceof ProjectFileUserError
              ? error.message
              : "The exact private transfer could not be finalized.",
          );
      }
    },
  );

  return router;
}
