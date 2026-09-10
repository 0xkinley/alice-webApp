import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";
import {
  escapeHtml,
  formatLocalTime,
  readableText,
  renderReadableValue,
} from "@alice/presentation";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "alice-save", version: "1.0.0" }, {}, { autoResize: true });
let card: any;
let authority: any;

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
      (claim: any) =>
        `<li><h3>${escapeHtml(readableText(claim.summary) || "Project update")}</h3><div class="readable-value">${renderReadableValue(claim.value)}</div>${
          claim.current_saved
            ? `<aside class="replace"><strong>Replaces current saved information</strong><div class="readable-value">${renderReadableValue(claim.current_saved.value)}</div></aside>`
            : '<p class="muted">Creates new project information.</p>'
        }</li>`,
    )
    .join("");
  const source = card.payload.source_context || card.payload.source_note;
  return `<section><p class="eyebrow">What will be saved</p><h2>${escapeHtml(readableText(card.payload.summary) || "Project update")}</h2><ul class="claims">${claims}</ul>${source ? `<details><summary>Supporting information</summary><p>${escapeHtml(readableText(source))}</p></details>` : ""}</section>`;
}

function attachmentPayload() {
  const file = card.file;
  return `<section><p class="eyebrow">File</p><h2>${escapeHtml(file.name)}</h2><dl><dt>Type</dt><dd>${escapeHtml(file.declared_media_type || "Verified after transfer")}</dd><dt>Size</dt><dd>${file.declared_byte_size === null ? "Verified after transfer" : `${Number(file.declared_byte_size).toLocaleString()} bytes`}</dd><dt>Source</dt><dd>${escapeHtml(providerName(card.source_host))}</dd></dl><p class="muted">No file has been copied. Save authorizes transfer; Alice will verify the exact file and complete both security scans before it becomes available.</p></section>`;
}

function render() {
  if (!card || (card.status === "awaiting_save" && !authority)) return;
  const expired = Date.parse(card.expires_at) <= Date.now();
  const alreadyAuthorized =
    card.card_type === "host_attachment" && card.status === "save_file_only";
  const statusText = alreadyAuthorized
    ? "Transfer authorized. The file is not available yet; Alice still needs the exact file and both security scans."
    : expired
      ? "This card expired. Ask the host for a new exact preview."
      : `Nothing is saved unless you choose Save. Expires ${escapeHtml(formatLocalTime(card.expires_at))}.`;
  const action = alreadyAuthorized
    ? ""
    : `<button id="save" type="button" ${expired ? "disabled" : ""}>Save</button>`;
  const source = card.source_host
    ? `<span>From ${escapeHtml(providerName(card.source_host))}</span>`
    : "";
  const created = card.created_at
    ? `<span>${escapeHtml(formatLocalTime(card.created_at))}</span>`
    : "";
  root.innerHTML = `<style>
    :root{color-scheme:light dark;font:400 15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--canvas:var(--color-background-primary,#070b09);--surface:var(--color-background-secondary,#0d1411);--surface-raised:var(--color-background-tertiary,#121b17);--line:var(--color-border-secondary,#2b3a32);--line-strong:var(--color-border-primary,#496055);--ink:var(--color-text-primary,#f2f7f4);--muted:var(--color-text-secondary,#9ba9a1);--brand:#9cf0bd;--brand-ink:#06140c;--danger:#ffaaa5}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}main{padding:clamp(16px,4vw,24px)}button,summary{font:inherit}.card{display:grid;gap:14px;max-width:680px;margin:0 auto}.topline{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:13px;border-bottom:1px solid var(--line)}.brand{font-size:21px;font-weight:850;letter-spacing:-.05em}.source-meta{display:flex;justify-content:flex-end;gap:6px 12px;flex-wrap:wrap;color:var(--muted);font-size:13px}.eyebrow{margin:0 0 5px;color:var(--brand);font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}h1,h2,h3,p{margin-top:0}h1{margin-bottom:7px;font-size:clamp(26px,6vw,38px);font-weight:680;letter-spacing:-.04em;line-height:1.08}h2{margin-bottom:10px;font-size:19px}h3{margin-bottom:6px;font-size:16px}header p{margin-bottom:0;color:var(--muted)}section,.destination,.notice{border:1px solid var(--line);border-radius:15px;padding:15px;background:var(--surface)}.destination{display:flex;align-items:center;justify-content:space-between;gap:14px}.destination .eyebrow{margin:0}.destination strong{font-size:18px}.claims{list-style:none;margin:0;padding:0}.claims li{padding:13px 0;border-bottom:1px solid var(--line)}.claims li:last-child{padding-bottom:0;border-bottom:0}.readable-value>p{margin:4px 0;color:var(--ink)}.readable-list{display:grid;gap:5px;margin:6px 0;padding-left:20px}.readable-list p{margin:0}.readable-fields{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:6px 12px;margin:8px 0}.readable-fields dt{color:var(--muted);font-weight:720}.readable-fields dd{margin:0}.replace{display:block;margin-top:9px;padding:10px 12px;border-left:3px solid #e0ad58;border-radius:0 9px 9px 0;background:rgba(224,173,88,.08);color:var(--muted)}details{margin-top:12px}summary{cursor:pointer;font-weight:720}.muted{color:var(--muted)}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}dt{font-weight:720}.notice{margin:0;color:var(--muted)}.notice.danger{border-color:var(--danger);color:var(--danger)}.notice.success{border-color:var(--brand);color:var(--brand)}button{width:100%;border:1px solid var(--brand);border-radius:999px;padding:11px 16px;background:var(--brand);color:var(--brand-ink);font:inherit;font-weight:850;cursor:pointer}button:hover{filter:brightness(1.06)}button:focus-visible,summary:focus-visible{outline:3px solid #86d8ff;outline-offset:3px}button:disabled{cursor:default;opacity:.55}@media(max-width:500px){main{padding:14px}.topline,.destination{align-items:flex-start;flex-direction:column}.source-meta{justify-content:flex-start}.readable-fields,dl{grid-template-columns:1fr;gap:2px}.readable-fields dd,dd{margin:0 0 7px}}
  </style><div class="card"><div class="topline"><strong class="brand">alice.</strong><div class="source-meta">${source}${created}</div></div><header><p class="eyebrow">Save preview</p><h1>${card.card_type === "host_attachment" ? "Save this file?" : "Save this update?"}</h1><p>Only your Save click can add this to the project. Closing or ignoring this card saves nothing.</p></header><div class="destination"><p class="eyebrow">Project</p><strong>${escapeHtml(card.destination.project_name)}</strong></div>${card.card_type === "host_attachment" ? attachmentPayload() : capturePayload()}<p id="status" class="notice${alreadyAuthorized ? " success" : ""}" role="status" aria-live="polite">${statusText}</p>${action}</div>`;
  document.querySelector("#save")?.addEventListener("click", save);
}

async function save() {
  const button = document.querySelector<HTMLButtonElement>("#save")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  button.disabled = true;
  status.textContent = "Saving the exact preview…";
  try {
    const result = await app.callServerTool({
      name:
        card.card_type === "host_attachment"
          ? "alice_confirm_host_file_save"
          : "alice_commit_capture_save",
      arguments:
        card.card_type === "host_attachment"
          ? {
              offer_id: card.offer_id,
              preview_version: card.preview_version,
              authority_token: authority.token,
            }
          : {
              preview_id: card.preview_id,
              preview_version: card.preview_version,
              authority_token: authority.token,
            },
    });
    if (result.isError) throw new Error(resultText(result) || "The exact Save failed.");
    const receipt: any = result.structuredContent;
    status.className = "notice success";
    status.textContent =
      card.card_type === "host_attachment"
        ? "Transfer authorized. alice. will report the file saved only after exact-byte verification and both security scans."
        : `${receipt.accepted.length} project ${receipt.accepted.length === 1 ? "item" : "items"} saved.`;
    button.textContent = "Saved";
  } catch (error) {
    status.className = "notice danger";
    status.textContent = error instanceof Error ? error.message : "The exact Save failed.";
    button.disabled = false;
  }
}

app.ontoolresult = (result: any) => {
  const incoming = result?.structuredContent;
  const incomingAuthority = result?._meta?.["alice/saveAuthority"];
  if (
    incoming?.contract_version === "alice_save_card_v1" &&
    (incomingAuthority?.token || incoming.status === "save_file_only")
  ) {
    card = incoming;
    authority = incomingAuthority;
    render();
  }
};
app.onhostcontextchanged = ({ theme }) => applyDocumentTheme(theme);
app.onerror = (error) => {
  root.innerHTML = `<p class="notice danger" role="alert">${escapeHtml(error.message)}</p>`;
};
await app.connect();
applyDocumentTheme(app.getHostContext()?.theme);
