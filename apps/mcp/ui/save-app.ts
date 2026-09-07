import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "alice-save", version: "1.0.0" }, {}, { autoResize: true });
let card: any;
let authority: any;

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function accessLabel(value: string) {
  return (
    {
      all_members: "All project members",
      selected_members: "Selected project members",
      personal: "Personal draft",
    }[value] || value
  );
}

function resultText(result: any) {
  return (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join(" ");
}

function valueText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function capturePayload() {
  const claims = card.payload.candidate_claims
    .map(
      (claim: any) =>
        `<li><p><strong>${escapeHtml(claim.summary)}</strong></p><p><code>${escapeHtml(claim.state_key)}</code></p><pre>${escapeHtml(valueText(claim.value))}</pre>${
          claim.current_saved
            ? `<p class="replace">Replaces saved version ${escapeHtml(claim.current_saved.version)}: ${escapeHtml(valueText(claim.current_saved.value))}</p>`
            : '<p class="muted">Creates a new saved value.</p>'
        }</li>`,
    )
    .join("");
  const source = card.payload.source_context || card.payload.source_note;
  return `<section><p class="eyebrow">Exact requested context</p><h2>${escapeHtml(card.payload.summary)}</h2><ul class="claims">${claims}</ul>${source ? `<details><summary>Source material included in this save</summary><pre>${escapeHtml(source)}</pre></details>` : ""}</section>`;
}

function attachmentPayload() {
  const file = card.file;
  return `<section><p class="eyebrow">Exact host attachment</p><h2>${escapeHtml(file.name)}</h2><dl><dt>Host-reported type</dt><dd>${escapeHtml(file.declared_media_type || "Verified after transfer")}</dd><dt>Host-reported size</dt><dd>${file.declared_byte_size === null ? "Verified after transfer" : `${Number(file.declared_byte_size).toLocaleString()} bytes`}</dd><dt>Source</dt><dd>${escapeHtml(card.source_host)}</dd></dl><p class="muted">No bytes have been copied. After Save, alice. still verifies the exact bytes and requires both private-file security gates before creating a file reference.</p></section>`;
}

function render() {
  if (!card || (card.status === "awaiting_save" && !authority)) return;
  const expired = Date.parse(card.expires_at) <= Date.now();
  const alreadyAuthorized =
    card.card_type === "host_attachment" && card.status === "save_file_only";
  const statusText = alreadyAuthorized
    ? "Transfer authorized. No attachment bytes have been copied yet; alice. still requires exact-byte verification and both security scans."
    : expired
      ? "This card expired. Ask the host for a new exact preview."
      : `Nothing is saved unless you choose Save. Expires ${escapeHtml(new Date(card.expires_at).toLocaleString())}.`;
  const action = alreadyAuthorized
    ? ""
    : `<button id="save" type="button" ${expired ? "disabled" : ""}>Save</button>`;
  root.innerHTML = `<style>
    :root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--color-background-primary,#f4f3ee);color:var(--color-text-primary,#17201d)}main{padding:18px}.card{display:grid;gap:14px}.brand{font-size:19px;font-weight:800}.eyebrow{margin:0 0 5px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--color-text-secondary,#68716c)}h1,h2,p{margin-top:0}h1{font-size:25px;line-height:1.12}section,.destination,.notice{border:1px solid var(--color-border-secondary,#cbd0cb);border-radius:14px;padding:14px;background:var(--color-background-secondary,#fff)}.destination strong{display:block;font-size:18px}.badge{display:inline-block;margin-top:8px;border:1px solid var(--color-border-primary,#949c97);border-radius:999px;padding:3px 8px}.claims{list-style:none;margin:0;padding:0}.claims li{padding:10px 0;border-bottom:1px solid var(--color-border-secondary,#ddd)}pre{max-height:210px;overflow:auto;white-space:pre-wrap;word-break:break-word;border-radius:9px;padding:10px;background:var(--color-background-tertiary,#eef0ed)}code{font-family:var(--font-mono,ui-monospace,monospace)}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}dt{font-weight:700}.muted,.replace{color:var(--color-text-secondary,#68716c)}.replace{border-left:3px solid #b17a20;padding-left:9px}.notice.danger{border-color:#b84638}.notice.success{border-color:#377c59}button{width:100%;border:0;border-radius:999px;padding:11px 16px;background:#183f32;color:#fff;font:inherit;font-weight:800;cursor:pointer}button:disabled{cursor:default;opacity:.55}
  </style><div class="card"><div class="brand">alice.</div><header><p class="eyebrow">Exact Save preview</p><h1>${card.card_type === "host_attachment" ? "Save this file to alice.?" : "Save this to alice.?"}</h1><p>Only your Save click can create the accepted context or authorize the exact attachment transfer.</p></header><div class="destination"><p class="eyebrow">Destination</p><strong>${escapeHtml(card.destination.project_name)} / ${escapeHtml(card.destination.context_name)}</strong><span class="badge">${escapeHtml(accessLabel(card.destination.access))}</span></div>${card.card_type === "host_attachment" ? attachmentPayload() : capturePayload()}<p id="status" class="notice${alreadyAuthorized ? " success" : ""}" role="status" aria-live="polite">${statusText}</p>${action}</div>`;
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
        : `${receipt.accepted.length} saved context ${receipt.accepted.length === 1 ? "entry" : "entries"} accepted.`;
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
