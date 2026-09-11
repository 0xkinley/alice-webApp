import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";
import {
  escapeHtml,
  formatLocalTime,
  readableLabel,
  readableText,
  renderReadableValue,
} from "@alice/presentation";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "alice-save", version: "1.0.0" }, {}, { autoResize: true });
let card: any;
let authority: any;
let receipt: any;
let restoringReceipt = false;

function resultText(result: any) {
  return (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join(" ");
}

function providerName(provider: unknown) {
  return provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "AI platform";
}

function capturePayload() {
  const claims = card.payload.candidate_claims
    .map(
      (claim: any, index: number) =>
        `<li><label class="select-row"><input type="checkbox" data-claim-index="${index}" checked><span><strong>${escapeHtml(readableText(claim.summary) || "Project update")}</strong><small>${escapeHtml(readableLabel(claim.state_key))}</small></span></label><details><summary>Review exact content${claim.current_saved ? " and replacement" : ""}</summary><div class="readable-value">${renderReadableValue(claim.value)}</div>${
          claim.current_saved
            ? `<aside class="replace"><strong>Replaces current saved information</strong><div class="readable-value">${renderReadableValue(claim.current_saved.value)}</div></aside>`
            : '<p class="muted">Creates new project information.</p>'
        }</details></li>`,
    )
    .join("");
  const source = card.payload.source_context || card.payload.source_note;
  return `<section><p class="eyebrow">Host-presented project items</p><h2>${escapeHtml(readableText(card.payload.summary) || "Project update")}</h2><p class="muted">Choose the exact grouped outcomes you want Alice to save. This list contains only what ${escapeHtml(providerName(card.source_host))} presented to Alice; the last-save time is a checkpoint, not proof that every intervening chat message is included.</p><ul class="claims">${claims}</ul>${source ? `<details><summary>Supporting information (saved only when every item is selected)</summary><p>${escapeHtml(readableText(source))}</p></details>` : ""}</section>`;
}

function attachmentPayload() {
  const files = card.card_type === "host_attachments" ? card.files : [card.file];
  const completedCount = files.filter((file: any) => file.transfer?.status === "completed").length;
  const rendered = files
    .map(
      (file: any, index: number) =>
        `<article${files.length > 1 ? ' class="file-preview"' : ""}><p class="eyebrow">${files.length > 1 ? `File ${index + 1} of ${files.length}` : "File"}</p><h2>${escapeHtml(file.name)}</h2><dl><dt>Type</dt><dd>${escapeHtml(file.declared_media_type || "Verified after transfer")}</dd><dt>Size</dt><dd>${file.declared_byte_size === null ? "Verified after transfer" : `${Number(file.declared_byte_size).toLocaleString()} bytes`}</dd><dt>Source</dt><dd>${escapeHtml(providerName(file.source_host || card.source_host))}</dd></dl></article>`,
    )
    .join("");
  const stateCopy =
    completedCount === files.length
      ? `${files.length === 1 ? "This file is" : "All files are"} available after exact-byte verification and both security scans.`
      : completedCount > 0
        ? `${completedCount} of ${files.length} files are available. Remaining files are reported independently only after exact-byte verification and both security scans.`
        : `No file has been copied. ${files.length > 1 ? "Save all atomically authorizes every exact transfer in this list" : "Save authorizes transfer"}; Alice verifies each exact file and completes both security scans before reporting that file available.`;
  return `<section>${rendered}<p class="muted">${stateCopy}</p></section>`;
}

function attachmentTransferActions() {
  const files = card.card_type === "host_attachments" ? card.files : [card.file];
  const actions = files
    .filter((file: any) => file.confirmation_url)
    .map((file: any) => {
      const completed = file.transfer?.status === "completed";
      return `<button class="file-action" type="button" data-file-url="${escapeHtml(file.confirmation_url)}">${completed ? "View" : "Upload"} ${escapeHtml(file.name)} in Alice</button>`;
    })
    .join("");
  if (!actions) {
    return '<section class="transfer-actions"><p class="eyebrow">Next step</p><h2>Transfer unavailable</h2><p>Ask the AI platform to return the exact Alice upload pages for this confirmed file list. No file is available until Alice receives and scans its bytes.</p></section>';
  }
  return `<section class="transfer-actions"><p class="eyebrow">Next step</p><h2>Continue the exact file transfer</h2><p>Open each locked Alice page and choose the matching file. Alice reports each file independently and only after both security scans pass.</p><div class="file-actions">${actions}</div></section>`;
}

function artifactPayload() {
  const artifact = card.artifact;
  const handoff = artifact.handoff;
  const list = (label: string, items: unknown[]) =>
    Array.isArray(items) && items.length
      ? `<section><p class="eyebrow">${escapeHtml(label)}</p><ul>${items.map((item) => `<li>${escapeHtml(readableText(item))}</li>`).join("")}</ul></section>`
      : "";
  const rejected =
    Array.isArray(handoff.rejected_directions) && handoff.rejected_directions.length
      ? `<section><p class="eyebrow">Rejected directions</p><ul>${handoff.rejected_directions
          .map(
            (item: any) =>
              `<li><strong>${escapeHtml(readableText(item.direction))}</strong><br><span class="muted">${escapeHtml(readableText(item.reason))}</span></li>`,
          )
          .join("")}</ul></section>`
      : "";
  return `<section><p class="eyebrow">Complete artifact · v${Number(artifact.version)}</p><label class="select-row"><input type="checkbox" data-artifact-selection checked><span><strong>${escapeHtml(artifact.title)}</strong><small>${escapeHtml(readableLabel(artifact.artifact_type))} · ${escapeHtml(readableLabel(artifact.category))}</small></span></label><p>${artifact.tags.map((tag: string) => `<span class="tag">${escapeHtml(readableLabel(tag))}</span>`).join(" ")}</p><details><summary>Review exact artifact and handoff</summary><div class="artifact-content">${escapeHtml(artifact.content)}</div><section><p class="eyebrow">Goal</p><p>${escapeHtml(readableText(handoff.goal))}</p>${handoff.summary ? `<p class="muted">${escapeHtml(readableText(handoff.summary))}</p>` : ""}</section>${list("Decisions", handoff.decisions)}${list("Constraints", handoff.constraints)}${rejected}${list("Open questions", handoff.open_questions)}${list("Next steps", handoff.next_steps)}${list("Relevant context", handoff.relevant_context)}</details></section>`;
}

function checkpoint() {
  if (!card.last_saved)
    return '<p class="checkpoint">No earlier confirmed save from this AI connection.</p>';
  return `<p class="checkpoint"><strong>Last confirmed save</strong><br>${escapeHtml(formatLocalTime(card.last_saved.saved_at))}${card.last_saved.label ? ` · ${escapeHtml(readableText(card.last_saved.label))}` : ""}</p>`;
}

function savedReceipt() {
  const count = Number(receipt.selected_count || receipt.accepted?.length || 1);
  const savedLabel =
    receipt.save_kind === "artifact"
      ? `${receipt.version === 1 ? "Artifact" : "Artifact version"} saved as v${Number(receipt.version)}.`
      : `${count} project ${count === 1 ? "item" : "items"} saved.`;
  const items = Array.isArray(receipt.selected_items)
    ? `<ul class="receipt-items">${receipt.selected_items.map((item: any) => `<li>${escapeHtml(readableText(item.summary) || readableLabel(item.state_key))}</li>`).join("")}</ul>`
    : receipt.title
      ? `<p><strong>${escapeHtml(receipt.title)}</strong></p>`
      : "";
  return `<style>:root{color-scheme:light dark;font:400 15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--canvas:var(--color-background-primary,#070b09);--surface:var(--color-background-secondary,#0d1411);--line:var(--color-border-secondary,#2b3a32);--ink:var(--color-text-primary,#f2f7f4);--muted:var(--color-text-secondary,#9ba9a1);--brand:#9cf0bd;--brand-ink:#06140c}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}main{padding:clamp(16px,4vw,24px)}.card{display:grid;gap:14px;max-width:680px;margin:0 auto}.topline,.destination{display:flex;align-items:center;justify-content:space-between;gap:16px}.topline{padding-bottom:13px;border-bottom:1px solid var(--line)}.brand{font-size:21px;font-weight:850}.source-meta,.muted{color:var(--muted)}.eyebrow{margin:0 0 5px;color:var(--brand);font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}h1,h2,p{margin-top:0}h1{margin-bottom:7px;font-size:clamp(26px,6vw,38px);line-height:1.08}header p{margin-bottom:0;color:var(--muted)}section,.destination{border:1px solid var(--line);border-radius:15px;padding:15px;background:var(--surface)}.destination .eyebrow{margin:0}.receipt-items{margin-bottom:12px}button{width:100%;border:1px solid var(--brand);border-radius:999px;padding:11px 16px;background:var(--brand);color:var(--brand-ink);font:inherit;font-weight:850;cursor:pointer}@media(max-width:500px){.topline,.destination{align-items:flex-start;flex-direction:column}}</style><div class="card"><div class="topline"><strong class="brand">alice.</strong><div class="source-meta"><span>Saved ${escapeHtml(formatLocalTime(receipt.saved_at))}</span></div></div><header><p class="eyebrow">Confirmed receipt</p><h1>Saved to Alice</h1><p>This durable receipt confirms what your Alice-controlled action saved.</p></header><div class="destination"><p class="eyebrow">Project</p><strong>${escapeHtml(receipt.destination.project_name)}</strong></div><section><h2>${savedLabel}</h2>${items}<p class="muted">AI-generated material is not Alice-verified.</p></section>${receipt.view_url ? '<button id="view-saved" type="button">View in Alice</button>' : ""}</div>`;
}

function render() {
  if (receipt?.status === "saved") {
    root.innerHTML = savedReceipt();
    document.querySelector("#view-saved")?.addEventListener("click", async () => {
      if (receipt.view_url) await app.openLink({ url: receipt.view_url });
    });
    return;
  }
  if (!card || (card.status === "awaiting_save" && !authority)) return;
  const expired = Date.parse(card.expires_at) <= Date.now();
  const alreadyAuthorized =
    ["host_attachment", "host_attachments"].includes(card.card_type) &&
    card.status === "save_file_only";
  const partiallyAuthorized =
    card.card_type === "host_attachments" && card.status === "partially_authorized";
  const attachmentFiles =
    card.card_type === "host_attachments"
      ? card.files
      : card.card_type === "host_attachment"
        ? [card.file]
        : [];
  const completedAttachmentCount = attachmentFiles.filter(
    (file: any) => file.transfer?.status === "completed",
  ).length;
  const allAttachmentsCompleted =
    attachmentFiles.length > 0 && completedAttachmentCount === attachmentFiles.length;
  const statusText = allAttachmentsCompleted
    ? `${attachmentFiles.length === 1 ? "File" : "Files"} available after exact-byte verification and both security scans.`
    : alreadyAuthorized && completedAttachmentCount > 0
      ? `${completedAttachmentCount} of ${attachmentFiles.length} files available. Continue each remaining exact transfer.`
      : alreadyAuthorized
        ? `Transfer${card.card_type === "host_attachments" ? "s" : ""} authorized. Each file becomes available only after Alice receives its exact bytes and both security scans pass.`
        : partiallyAuthorized
          ? "Some files were already authorized separately. Continue through each exact browser fallback; this mixed preview cannot perform Save all."
          : expired
            ? "This card expired. Ask the host for a new exact preview."
            : `${card.card_type === "artifact" ? "1 item selected" : `${card.payload?.candidate_claims?.length || 0} items selected`}. Nothing is saved yet. Expires ${escapeHtml(formatLocalTime(card.expires_at))}.`;
  const action =
    alreadyAuthorized || partiallyAuthorized
      ? attachmentTransferActions()
      : `<button id="save" type="button" ${expired ? "disabled" : ""}>${card.card_type === "host_attachments" ? "Save all" : ["artifact", "context_capture"].includes(card.card_type) ? "Save selected" : "Save"}</button>`;
  const source = card.source_host
    ? `<span>From ${escapeHtml(providerName(card.source_host))}</span>`
    : "";
  const created = card.created_at
    ? `<span>${escapeHtml(formatLocalTime(card.created_at))}</span>`
    : "";
  const isArtifact = card.card_type === "artifact";
  const heading =
    alreadyAuthorized || partiallyAuthorized
      ? allAttachmentsCompleted
        ? attachmentFiles.length === 1
          ? "File available"
          : "Files available"
        : "Complete the file transfer"
      : card.card_type === "host_attachments"
        ? "Save these files?"
        : card.card_type === "host_attachment"
          ? "Save this file?"
          : ["artifact", "context_capture"].includes(card.card_type)
            ? "Choose what to save"
            : "Save this update?";
  const authorityCopy =
    alreadyAuthorized || partiallyAuthorized
      ? "Authorization alone does not copy a file. Complete each transfer below; Alice reports availability only after both security scans pass."
      : `Review the exact host-presented items below. One Alice-controlled ${card.card_type === "host_attachments" ? "Save all" : ["artifact", "context_capture"].includes(card.card_type) ? "Save selected" : "Save"} click commits only your selection. Closing or ignoring this card saves nothing.`;
  root.innerHTML = `<style>
    :root{color-scheme:light dark;font:400 15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--canvas:var(--color-background-primary,#070b09);--surface:var(--color-background-secondary,#0d1411);--surface-raised:var(--color-background-tertiary,#121b17);--line:var(--color-border-secondary,#2b3a32);--line-strong:var(--color-border-primary,#496055);--ink:var(--color-text-primary,#f2f7f4);--muted:var(--color-text-secondary,#9ba9a1);--brand:#9cf0bd;--brand-ink:#06140c;--danger:#ffaaa5}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}main{padding:clamp(16px,4vw,24px)}button,summary{font:inherit}.card{display:grid;gap:14px;max-width:680px;margin:0 auto}.topline{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:13px;border-bottom:1px solid var(--line)}.brand{font-size:21px;font-weight:850;letter-spacing:-.05em}.source-meta{display:flex;justify-content:flex-end;gap:6px 12px;flex-wrap:wrap;color:var(--muted);font-size:13px}.eyebrow{margin:0 0 5px;color:var(--brand);font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}h1,h2,h3,p{margin-top:0}h1{margin-bottom:7px;font-size:clamp(26px,6vw,38px);font-weight:680;letter-spacing:-.04em;line-height:1.08}h2{margin-bottom:10px;font-size:19px}h3{margin-bottom:6px;font-size:16px}header p{margin-bottom:0;color:var(--muted)}section,.destination,.notice{border:1px solid var(--line);border-radius:15px;padding:15px;background:var(--surface)}.checkpoint{margin:0;padding:10px 12px;border-left:3px solid var(--brand);border-radius:0 9px 9px 0;background:rgba(156,240,189,.07);color:var(--muted)}.file-preview{padding:12px 0;border-bottom:1px solid var(--line)}.file-preview:first-child{padding-top:0}.file-preview:last-of-type{border-bottom:0}.destination{display:flex;align-items:center;justify-content:space-between;gap:14px}.destination .eyebrow{margin:0}.destination strong{font-size:18px}.claims{list-style:none;margin:0;padding:0}.claims li{padding:13px 0;border-bottom:1px solid var(--line)}.claims li:last-child{padding-bottom:0;border-bottom:0}.select-row{display:grid;grid-template-columns:auto 1fr;align-items:flex-start;gap:12px;cursor:pointer}.select-row input{width:20px;height:20px;margin:2px 0;accent-color:var(--brand)}.select-row span{display:grid;gap:2px}.select-row small{color:var(--muted)}.artifact-content{max-height:320px;overflow:auto;white-space:pre-wrap;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-raised)}.tag{display:inline-block;margin:2px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:12px}.readable-value>p{margin:4px 0;color:var(--ink)}.readable-list{display:grid;gap:5px;margin:6px 0;padding-left:20px}.readable-list p{margin:0}.readable-fields{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:6px 12px;margin:8px 0}.readable-fields dt{color:var(--muted);font-weight:720}.readable-fields dd{margin:0}.replace{display:block;margin-top:9px;padding:10px 12px;border-left:3px solid #e0ad58;border-radius:0 9px 9px 0;background:rgba(224,173,88,.08);color:var(--muted)}details{margin-top:12px}summary{cursor:pointer;font-weight:720}.muted{color:var(--muted)}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}dt{font-weight:720}.notice{margin:0;color:var(--muted)}.notice.danger{border-color:var(--danger);color:var(--danger)}.notice.success{border-color:var(--brand);color:var(--brand)}.file-actions{display:grid;gap:9px}.transfer-actions p{color:var(--muted)}button{width:100%;border:1px solid var(--brand);border-radius:999px;padding:11px 16px;background:var(--brand);color:var(--brand-ink);font:inherit;font-weight:850;cursor:pointer}button:hover{filter:brightness(1.06)}button:focus-visible,summary:focus-visible,input:focus-visible{outline:3px solid #86d8ff;outline-offset:3px}button:disabled{cursor:default;opacity:.55}@media(max-width:500px){main{padding:14px}.topline,.destination{align-items:flex-start;flex-direction:column}.source-meta{justify-content:flex-start}.readable-fields,dl{grid-template-columns:1fr;gap:2px}.readable-fields dd,dd{margin:0 0 7px}}
  </style><div class="card"><div class="topline"><strong class="brand">alice.</strong><div class="source-meta">${source}${created}</div></div><header><p class="eyebrow">Alice save</p><h1>${heading}</h1><p>${authorityCopy}</p></header>${["artifact", "context_capture"].includes(card.card_type) ? checkpoint() : ""}<div class="destination"><p class="eyebrow">Project</p><strong>${escapeHtml(card.destination.project_name)}</strong></div>${["host_attachment", "host_attachments"].includes(card.card_type) ? attachmentPayload() : isArtifact ? artifactPayload() : capturePayload()}<p id="status" class="notice${alreadyAuthorized ? " success" : ""}" role="status" aria-live="polite">${statusText}</p>${action}</div>`;
  document.querySelector("#save")?.addEventListener("click", save);
  document
    .querySelectorAll<HTMLInputElement>("[data-claim-index], [data-artifact-selection]")
    .forEach((input) => input.addEventListener("change", updateSelection));
  updateSelection();
  document.querySelectorAll<HTMLButtonElement>("[data-file-url]").forEach((button) => {
    button.addEventListener("click", async () => {
      const url = button.dataset.fileUrl;
      if (!url) return;
      try {
        await app.openLink({ url });
      } catch {
        const status = document.querySelector<HTMLElement>("#status");
        if (status) {
          status.className = "notice danger";
          status.textContent =
            "Alice could not open this file page. Ask the AI platform to return the exact Alice file page shown for this transfer.";
        }
      }
    });
  });
}

function selectedClaimIndices() {
  return [...document.querySelectorAll<HTMLInputElement>("[data-claim-index]:checked")].map(
    (input) => Number(input.dataset.claimIndex),
  );
}

function updateSelection() {
  if (!["artifact", "context_capture"].includes(card?.card_type)) return;
  const selected =
    card.card_type === "artifact"
      ? document.querySelector<HTMLInputElement>("[data-artifact-selection]")?.checked
        ? 1
        : 0
      : selectedClaimIndices().length;
  const button = document.querySelector<HTMLButtonElement>("#save");
  const status = document.querySelector<HTMLElement>("#status");
  if (button) button.disabled = selected === 0 || Date.parse(card.expires_at) <= Date.now();
  if (status && Date.parse(card.expires_at) > Date.now()) {
    status.className = "notice";
    status.textContent = `${selected} ${selected === 1 ? "item" : "items"} selected. Nothing is saved yet.`;
  }
}

async function save() {
  const button = document.querySelector<HTMLButtonElement>("#save")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  button.disabled = true;
  status.textContent = "Saving the exact preview…";
  try {
    const result = await app.callServerTool({
      name:
        card.card_type === "host_attachments"
          ? "alice_confirm_host_files_save"
          : card.card_type === "host_attachment"
            ? "alice_confirm_host_file_save"
            : card.card_type === "artifact"
              ? "alice_commit_artifact_save"
              : "alice_commit_capture_save",
      arguments:
        card.card_type === "host_attachments"
          ? {
              offers: card.files.map((file: any) => ({
                offer_id: file.offer_id,
                preview_version: file.preview_version,
              })),
              preview_version: card.preview_version,
              authority_token: authority.token,
            }
          : card.card_type === "host_attachment"
            ? {
                offer_id: card.offer_id,
                preview_version: card.preview_version,
                authority_token: authority.token,
              }
            : {
                preview_id: card.preview_id,
                preview_version: card.preview_version,
                authority_token: authority.token,
                ...(card.card_type === "context_capture"
                  ? { selected_claim_indices: selectedClaimIndices() }
                  : {}),
              },
    });
    if (result.isError) throw new Error(resultText(result) || "The exact Save failed.");
    const savedResult: any = result.structuredContent;
    if (["host_attachment", "host_attachments"].includes(card.card_type)) {
      card = { ...card, ...savedResult };
      authority = undefined;
      render();
      return;
    }
    receipt = savedResult;
    authority = undefined;
    render();
  } catch (error) {
    status.className = "notice danger";
    status.textContent = error instanceof Error ? error.message : "The exact Save failed.";
    button.disabled = false;
  }
}

async function restoreReceipt() {
  if (
    restoringReceipt ||
    receipt ||
    !card?.preview_id ||
    ["host_attachment", "host_attachments"].includes(card.card_type)
  ) {
    return;
  }
  restoringReceipt = true;
  try {
    const result = await app.callServerTool({
      name: "alice_get_save_status",
      arguments: { preview_id: card.preview_id },
    });
    if (!result.isError && result.structuredContent?.status === "saved") {
      receipt = result.structuredContent;
      authority = undefined;
      render();
    }
  } catch {
    // The original unexpired selector remains usable if receipt restoration is unavailable.
  } finally {
    restoringReceipt = false;
  }
}

app.ontoolresult = (result: any) => {
  const incoming = result?.structuredContent;
  const incomingAuthority = result?._meta?.["alice/saveAuthority"];
  if (
    incoming?.contract_version === "alice_save_card_v1" &&
    (incomingAuthority?.token ||
      incoming.status === "save_file_only" ||
      incoming.status === "partially_authorized")
  ) {
    card = incoming;
    receipt = undefined;
    authority = incomingAuthority;
    render();
    void restoreReceipt();
  }
};
app.onhostcontextchanged = ({ theme }) => applyDocumentTheme(theme);
app.onerror = (error) => {
  root.innerHTML = `<p class="notice danger" role="alert">${escapeHtml(error.message)}</p>`;
};
await app.connect();
applyDocumentTheme(app.getHostContext()?.theme);
