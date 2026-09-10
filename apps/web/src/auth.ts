import {
  alphaInvitationForToken,
  authenticateUser,
  createUserSession,
  registerUser,
  revokeUserSession,
  userForSession,
} from "@alice/domain";
import express from "express";
import { localTimeScript } from "./product-copy.ts";

const SESSION_COOKIE = "alice_session";

declare global {
  namespace Express {
    interface Request {
      aliceUser?: { id: string; email: string; workspace_id: string };
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderPage(title, body, { showFooter = true, appShell = false } = {}) {
  const footer = showFooter
    ? '<footer><a href="/about">About alice.</a><a href="/privacy-security">Privacy and security</a></footer>'
    : "";
  const content = appShell ? body : `<main id="main-content">${body}${footer}</main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · alice.</title><style>
:root{color-scheme:dark;--canvas:#070a09;--surface:#0d1210;--surface-raised:#141a17;--surface-soft:#0a0f0d;--line:#26302b;--line-strong:#3c4b44;--ink:#f2f6f3;--ink-soft:#b7c1bb;--ink-muted:#7f8b85;--brand:#a5f3c1;--brand-strong:#71e89e;--brand-ink:#071b0f;--focus:#8cdcff;--danger:#ff9d9d;--danger-surface:#311b25;--success:#a5f3c1;--success-surface:#10251b;--shadow:0 20px 55px rgba(0,0,0,.24)}
*{box-sizing:border-box}html{background:var(--canvas)}body{min-width:20rem;margin:0;background:linear-gradient(90deg,transparent calc(100% - 1px),rgba(255,255,255,.025) 0) 0 0/5rem 100%,radial-gradient(circle at 82% -8rem,rgba(165,243,193,.1),transparent 33rem),var(--canvas);color:var(--ink);font:400 16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body>main{width:min(72rem,calc(100% - 2rem));margin:0 auto;padding:2.25rem 0 4rem}.skip-link{position:fixed;z-index:100;top:.75rem;left:.75rem;transform:translateY(-180%);padding:.65rem .85rem;border-radius:.5rem;background:var(--focus);color:#061321;font-weight:700;text-decoration:none}.skip-link:focus{transform:translateY(0)}
h1,h2,h3{max-width:42rem;margin:0 0 .55rem;letter-spacing:-.025em;line-height:1.15}h1{font-size:clamp(2rem,5vw,3.45rem)}h2{margin-top:2.25rem;font-size:clamp(1.25rem,2.5vw,1.75rem)}h3{font-size:1rem}p{max-width:68ch;margin:.55rem 0;color:var(--ink-soft)}a{display:inline-block;padding:.46rem .72rem;border:1px solid var(--line-strong);border-radius:.6rem;background:var(--surface-raised);color:#d6e8ff;font-weight:700;line-height:1.25;text-decoration:none}a:hover{border-color:var(--focus);background:#203047;color:#fff}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
nav{display:flex;align-items:center;gap:.65rem 1rem;flex-wrap:wrap;margin:0 0 1.8rem;padding:0 0 1rem;border-bottom:1px solid var(--line)}nav strong{margin-right:auto;color:var(--brand);font-size:1.2rem;letter-spacing:-.04em}nav span{color:var(--ink-muted);font-size:.9rem}nav form{margin:0}nav form button{padding:.36rem .55rem;background:transparent;color:var(--ink-soft);border-color:transparent}.actions{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin-top:1rem}.actions form{margin:0}
.eyebrow{margin:0 0 .8rem;color:var(--brand);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero{margin:0 0 2.25rem;padding:clamp(1.35rem,4vw,2.7rem);border:1px solid var(--line);border-radius:1.25rem;background:linear-gradient(120deg,rgba(165,243,193,.14),transparent 43%),linear-gradient(200deg,rgba(130,183,255,.09),transparent 55%),var(--surface)}.hero h1{max-width:18ch}.hero p:not(.eyebrow){font-size:1.08rem}.dashboard-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.dashboard-grid>section{margin:0}.dashboard-grid>section>h2{margin-top:0}.context-card{position:relative;overflow:hidden}.context-card::before{position:absolute;top:0;left:0;width:.24rem;height:100%;background:var(--brand);content:""}.context-card .context-meta{display:flex;gap:.45rem;flex-wrap:wrap;color:var(--ink-muted);font-size:.86rem}.badge{display:inline-flex;align-items:center;width:max-content;padding:.18rem .5rem;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-soft);color:var(--ink-soft);font-size:.78rem;font-weight:700}.empty-state{display:grid;gap:.45rem;min-height:11rem;align-content:center;padding:1.25rem;border:1px dashed var(--line-strong);border-radius:1rem;background:rgba(18,26,37,.55)}.empty-state h2{margin:0}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin:2.25rem 0 .8rem}.section-heading h2{margin:0}.section-heading p{margin:0}
.public-hero{min-height:32rem;display:grid;align-content:center;background:radial-gradient(circle at 82% 18%,rgba(130,183,255,.17),transparent 18rem),linear-gradient(120deg,rgba(165,243,193,.14),transparent 46%),var(--surface)}.public-hero h1{max-width:16ch}.button-link{display:inline-block;padding:.68rem .95rem;border:1px solid var(--brand);border-radius:.6rem;background:var(--brand);color:var(--brand-ink);font-weight:750;text-decoration:none}.button-link:hover{color:var(--brand-ink);filter:brightness(1.06)}.feature-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.feature-grid article{margin:0}.workflow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;padding:0;list-style:none;counter-reset:steps}.workflow li{display:grid;align-content:start;gap:.45rem;min-height:12rem;padding:1.2rem;border:1px solid var(--line);border-radius:1rem;background:var(--surface);counter-increment:steps}.workflow li::before{display:grid;width:2rem;height:2rem;place-content:center;border:1px solid var(--line-strong);border-radius:999px;color:var(--brand);font-weight:800;content:counter(steps)}.workflow span{color:var(--ink-soft)}.final-cta{padding:clamp(1.35rem,4vw,2.4rem);border:1px solid var(--line-strong);border-radius:1.2rem;background:linear-gradient(130deg,rgba(165,243,193,.1),transparent 55%),var(--surface)}.final-cta h2{margin-top:0}
.notice{margin:1rem 0;padding:1rem 1.1rem;border:1px solid var(--line-strong);border-radius:.85rem;background:var(--surface-soft)}.notice strong{color:var(--ink)}.notice.warning{border-color:#8d7041;background:#2b2315}.notice.danger{border-color:#8c4b5a;background:var(--danger-surface)}button.destructive{border-color:#9f5364;background:#562b38;color:#ffecef}button.destructive:hover{filter:brightness(1.16)}.connection-card{display:grid;gap:.35rem}.connection-card form{margin:.55rem 0 0}.connection-card.revoked{border-color:#6f6171;background:linear-gradient(135deg,rgba(180,160,190,.08),transparent 60%),var(--surface)}
.file-card{position:relative;overflow:hidden}.file-card::before{position:absolute;top:0;left:0;width:.24rem;height:100%;background:var(--brand);content:""}.file-card.unavailable::before{background:#c4934e}.file-card.removed-file::before{background:#8c4b5a}.file-card .file-meta{display:flex;gap:.45rem;flex-wrap:wrap;color:var(--ink-muted);font-size:.9rem}.upload-panel{padding:clamp(1rem,3vw,1.5rem);border:1px solid var(--line-strong);border-radius:1rem;background:linear-gradient(135deg,rgba(130,183,255,.08),transparent 65%),var(--surface-soft)}
.status-page{display:grid;min-height:min(30rem,70vh);place-content:center;padding:clamp(1.4rem,5vw,3.5rem);border:1px solid var(--line-strong);border-radius:1.25rem;background:linear-gradient(135deg,rgba(130,183,255,.08),transparent 55%),var(--surface);box-shadow:var(--shadow)}.status-page::before{width:2.6rem;height:.3rem;margin-bottom:1.2rem;border-radius:999px;background:var(--focus);content:""}.status-page.warning::before{background:#d9aa61}.status-page.danger::before{background:var(--danger)}.status-page h1{max-width:18ch}.status-page p{font-size:1.05rem}.status-page .actions{margin-top:1.25rem}
article,aside,section>dl{margin:1rem 0;padding:1.1rem 1.2rem;border:1px solid var(--line);border-radius:1rem;background:linear-gradient(135deg,rgba(255,255,255,.035),transparent 60%),var(--surface);box-shadow:var(--shadow)}article h2,article h3{margin-top:0}article p:last-child{margin-bottom:0}section{margin:2rem 0}.accepted{border-color:#477e5c;background:linear-gradient(135deg,rgba(165,243,193,.1),transparent 60%),var(--success-surface)}.rejected{border-color:#8c4b5a;background:linear-gradient(135deg,rgba(255,157,157,.08),transparent 60%),var(--danger-surface)}
form{max-width:44rem;margin:1.25rem 0;padding:1.2rem;border:1px solid var(--line);border-radius:1rem;background:var(--surface-soft)}label{display:block;margin:1rem 0;color:var(--ink);font-weight:650}input,textarea,select,button{font:inherit}input,textarea,select{display:block;width:100%;margin-top:.4rem;padding:.7rem .8rem;border:1px solid var(--line-strong);border-radius:.6rem;background:#0d141e;color:var(--ink)}textarea{min-height:7rem;resize:vertical}input[type="checkbox"],input[type="radio"]{display:inline-block;width:auto;margin-right:.45rem;accent-color:var(--brand)}input[type="file"]{padding:.55rem}button{cursor:pointer;padding:.68rem .95rem;border:1px solid var(--brand);border-radius:.6rem;background:var(--brand);color:var(--brand-ink);font-weight:750}button:hover{filter:brightness(1.06)}button:disabled{cursor:not-allowed;opacity:.55}.muted{color:var(--ink-muted);font-size:.93rem}.accepted strong{color:var(--success)}.rejected strong{color:var(--danger)}
code{padding:.08rem .28rem;border-radius:.25rem;background:#0c141e;color:#d5e6ff;overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;border:1px solid var(--line);border-radius:.7rem;background:#090f17;color:#d5e6ff;font-size:.88rem}dl{display:grid;grid-template-columns:minmax(10rem,max-content) 1fr;gap:.5rem 1rem;margin:1rem 0}dt{color:var(--ink-muted);font-weight:700}dd{min-width:0;margin:0}details{margin:1rem 0;padding:.8rem;border:1px solid var(--line);border-radius:.7rem;background:var(--surface-soft)}summary{cursor:pointer;color:var(--ink);font-weight:700}progress{accent-color:var(--brand);width:100%;margin-top:.75rem}footer{display:flex;gap:.5rem 1rem;flex-wrap:wrap;margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--ink-muted);font-size:.88rem}footer p{margin:0;color:inherit}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.app-frame{display:grid;grid-template-columns:17rem minmax(0,1fr);min-height:100vh;transition:grid-template-columns .18s ease}.app-sidebar{position:sticky;top:0;display:flex;height:100vh;flex-direction:column;padding:1.15rem;border-right:1px solid var(--line);background:rgba(7,10,9,.94);backdrop-filter:blur(16px)}.sidebar-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;min-height:2.75rem}.wordmark{padding:0;border:0;background:transparent;color:var(--brand);font-size:1.24rem;font-weight:850;letter-spacing:-.055em}.wordmark:hover{border:0;background:transparent;color:var(--brand-strong)}.sidebar-toggle,.mobile-menu{display:grid;width:2.5rem;height:2.5rem;place-content:center;padding:0;border-color:var(--line);background:var(--surface);color:var(--ink-soft)}.sidebar-toggle:hover,.mobile-menu:hover{border-color:var(--brand);background:var(--surface-raised)}.sidebar-nav{display:grid;gap:.3rem;margin:2.4rem 0}.sidebar-nav a{display:flex;align-items:center;gap:.8rem;min-height:2.7rem;padding:.62rem .7rem;border-color:transparent;background:transparent;color:var(--ink-soft);font-size:.92rem}.sidebar-nav a:hover{border-color:var(--line);background:var(--surface);color:var(--ink)}.sidebar-nav a[aria-current="page"]{border-color:rgba(165,243,193,.28);background:rgba(165,243,193,.09);color:var(--brand)}.nav-icon{display:grid;width:1.3rem;flex:0 0 1.3rem;place-content:center;color:inherit}.sidebar-meta{margin-top:auto;padding-top:1rem;border-top:1px solid var(--line)}.account-card{display:grid;grid-template-columns:2rem minmax(0,1fr);gap:.65rem;align-items:center;margin-bottom:.75rem}.account-avatar{display:grid;width:2rem;height:2rem;place-content:center;border:1px solid rgba(165,243,193,.35);border-radius:50%;background:rgba(165,243,193,.1);color:var(--brand);font-size:.78rem;font-weight:800;text-transform:uppercase}.account-copy{min-width:0}.account-copy strong,.account-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-copy strong{font-size:.8rem}.account-copy span{color:var(--ink-muted);font-size:.72rem}.sidebar-meta form{margin:0;padding:0;border:0;background:transparent}.sidebar-meta button{width:100%;border-color:var(--line);background:transparent;color:var(--ink-soft);font-size:.82rem}.sidebar-privacy{display:block;margin-top:.55rem;padding:.42rem;border:0;background:transparent;color:var(--ink-muted);font-size:.72rem;text-align:center}.app-frame.sidebar-collapsed{grid-template-columns:4.85rem minmax(0,1fr)}.sidebar-collapsed .sidebar-label,.sidebar-collapsed .account-copy,.sidebar-collapsed .sidebar-meta button,.sidebar-collapsed .sidebar-privacy,.sidebar-collapsed .wordmark{display:none}.sidebar-collapsed .sidebar-head{justify-content:center}.sidebar-collapsed .sidebar-nav a{justify-content:center}.sidebar-collapsed .account-card{display:flex;justify-content:center}.app-surface{min-width:0}.app-topbar{display:flex;min-height:4.75rem;align-items:center;justify-content:flex-end;gap:1rem;padding:0 2rem;border-bottom:1px solid var(--line);background:rgba(7,10,9,.72);backdrop-filter:blur(12px)}.mobile-menu,.mobile-wordmark{display:none}.topbar-account{max-width:20rem;overflow:hidden;color:var(--ink-muted);font-size:.82rem;text-overflow:ellipsis;white-space:nowrap}.app-main{width:min(92rem,100%);margin:0 auto;padding:clamp(1.4rem,4vw,3.5rem)}.workspace-home{min-height:calc(100vh - 11.75rem)}.workspace-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:2rem;margin-bottom:clamp(2.5rem,6vw,5.5rem)}.workspace-toolbar h1{font-size:clamp(2.35rem,5vw,4.8rem);font-weight:630;letter-spacing:-.065em}.workspace-toolbar p:not(.eyebrow){max-width:38rem;font-size:1.05rem}.create-project{width:min(26rem,100%);margin:0;padding:0;border:0;background:transparent}.create-project summary{width:max-content;margin-left:auto;padding:.78rem 1.05rem;border:1px solid var(--brand);border-radius:.65rem;background:var(--brand);color:var(--brand-ink);font-weight:800;list-style:none}.create-project summary::-webkit-details-marker{display:none}.create-project[open]{padding:1rem;border:1px solid var(--line-strong);border-radius:1rem;background:var(--surface)}.create-project[open] summary{margin-left:0}.create-project form{margin:1rem 0 0}.workspace-empty{display:grid;min-height:24rem;place-content:center;margin:0;padding:clamp(2rem,8vw,6rem);border:1px solid var(--line);border-radius:1rem;background:linear-gradient(90deg,transparent calc(100% - 1px),rgba(165,243,193,.035) 0) 0 0/4rem 100%,rgba(13,18,16,.58);text-align:center}.workspace-empty h2{margin:0 auto .6rem;font-size:clamp(1.5rem,3vw,2.3rem)}.workspace-empty p{margin-inline:auto}.workspace-empty .create-project{margin:1.4rem auto 0}.workspace-empty .create-project summary{margin-inline:auto}.project-section{margin:3.5rem 0}.project-section .section-heading{padding-bottom:.8rem;border-bottom:1px solid var(--line)}.project-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem}.project-card{display:flex;min-height:12rem;flex-direction:column;margin:0;padding:1.25rem;background:rgba(13,18,16,.78);box-shadow:none}.project-card h2,.project-card h3{font-size:1.12rem}.project-card .project-link{padding:0;border:0;background:transparent;color:var(--ink);font-size:inherit}.project-card .project-link:hover{border:0;background:transparent;color:var(--brand)}.project-card .project-meta{margin-top:auto;padding-top:1rem;color:var(--ink-muted);font-size:.82rem}.section-empty{min-height:8rem;padding:1.25rem;border:1px dashed var(--line);border-radius:.85rem;color:var(--ink-muted)}
.create-project-form{width:min(26rem,100%);margin:1rem 0 0}.workspace-empty .create-project-form{margin:1.4rem auto 0;text-align:left}.create-project-form .actions{justify-content:flex-end}.create-project-form button.secondary{border-color:var(--line-strong);background:transparent;color:var(--ink)}.create-project-form input[type="file"][hidden]{display:none!important}.file-selection{flex-basis:100%;color:var(--ink-muted);font-size:.82rem;text-align:right}.file-selection:empty{display:none}.create-project-form button:disabled{cursor:wait;opacity:.65}
.connections-home{max-width:70rem}.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:0}.provider-status{display:flex;min-height:9rem;align-items:center;justify-content:space-between;gap:1rem;margin:0;padding:1.35rem;background:rgba(13,18,16,.78);box-shadow:none}.provider-status.connected{border-color:rgba(165,243,193,.35)}.provider-name{display:flex;align-items:center;gap:.75rem}.provider-name h2{margin:0;font-size:1.25rem}.provider-light{width:.72rem;height:.72rem;flex:0 0 .72rem;border:1px solid var(--line-strong);border-radius:50%;background:var(--ink-muted)}.provider-light.connected{border-color:var(--brand);background:var(--brand);box-shadow:0 0 0 .25rem rgba(165,243,193,.12),0 0 1rem rgba(165,243,193,.45)}.advanced-link{margin-top:1rem;background:transparent;color:var(--ink-soft)}
.project-home{max-width:76rem}.project-header{display:flex;align-items:flex-start;justify-content:space-between;gap:2rem;margin-bottom:0;padding-bottom:2rem;border-bottom:1px solid var(--line)}.project-header h1{font-size:clamp(2.5rem,6vw,5.5rem);font-weight:630;letter-spacing:-.065em}.project-provider-row{display:flex;flex-wrap:wrap;align-items:center;gap:.8rem 1.4rem;margin-top:1.5rem}.project-providers{display:flex;flex-wrap:wrap;gap:.65rem 1.15rem}.project-provider{display:flex;align-items:center;gap:.5rem;color:var(--ink-muted);font-size:.86rem}.project-header-controls{display:flex;flex:0 0 auto;align-items:flex-start;gap:.65rem}.project-file-action{position:relative;display:flex;align-items:center;gap:.65rem}.project-file-action button{padding:.55rem .8rem}.project-file-action input[hidden]{display:none!important}.project-file-status{position:absolute;top:calc(100% + .45rem);left:0;width:max-content;max-width:24rem;color:var(--ink-muted);font-size:.78rem;text-align:left}.project-file-status.danger{color:var(--danger)}.project-menu{position:relative;z-index:5;flex:0 0 auto;margin:0;padding:0;border:0;background:transparent}.project-menu summary{display:grid;width:2.75rem;height:2.75rem;place-content:center;padding:0;border:1px solid var(--line-strong);border-radius:.65rem;background:var(--surface);font-size:1.4rem;line-height:1;list-style:none}.project-menu summary::-webkit-details-marker{display:none}.project-menu nav{position:absolute;right:0;display:grid;width:14rem;gap:.2rem;margin-top:.45rem;padding:.5rem;border:1px solid var(--line-strong);border-radius:.75rem;background:var(--surface-raised);box-shadow:0 1rem 3rem rgba(0,0,0,.35)}.project-menu nav a{display:flex;width:100%;align-items:center;justify-content:space-between;padding:.65rem;border:0;border-radius:.45rem;background:transparent;color:var(--ink-soft);font-weight:700;text-align:left}.project-menu nav a:hover{background:rgba(165,243,193,.08);color:var(--ink)}.project-menu nav a.destructive{color:var(--danger)}.project-tabs{display:flex;gap:1.5rem;margin:0 0 2rem;padding:0;border-bottom:1px solid var(--line);background:transparent}.project-tabs a{display:flex;align-items:center;gap:.45rem;padding:1rem .15rem .85rem;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--ink-muted);font-weight:750}.project-tabs a:hover{border-color:transparent;border-bottom-color:var(--line-strong);background:transparent;color:var(--ink)}.project-tabs a[aria-current="page"]{border-bottom-color:var(--brand);color:var(--ink)}.count-badge{display:inline-flex;width:max-content;padding:.2rem .42rem;border:1px solid rgba(165,243,193,.3);border-radius:999px;background:rgba(165,243,193,.08);color:var(--brand);font-size:.72rem;font-weight:800}
.change-log-list{display:grid;gap:.85rem}.change-entry{margin:0;padding:1.35rem;box-shadow:none}.change-entry h2{margin:.8rem 0 .45rem;font-size:1.25rem}.change-entry-meta{display:flex;align-items:center;gap:.45rem .8rem;flex-wrap:wrap;color:var(--ink-muted);font-size:.82rem}.change-entry-value>p,.readable-value>p{margin:.3rem 0;color:var(--ink);font-size:1.02rem}.change-value-list,.readable-list{display:grid;gap:.35rem;margin:.4rem 0;padding-left:1.25rem}.change-value-list li>p,.readable-list li>p{margin:0;color:var(--ink)}.change-value-fields,.readable-fields{grid-template-columns:minmax(7rem,max-content) 1fr;margin:.55rem 0}.change-value-fields dd>p,.readable-fields dd>p{margin:0;color:var(--ink)}
.project-header>div:first-child{min-width:0;flex:1}.project-provider-row{width:100%;justify-content:space-between}.project-file-action{margin-left:auto}.project-file-status{right:0;left:auto;text-align:right}.project-menu nav .project-menu-action{width:100%;margin:0;padding:0;border:0;background:transparent}.project-menu nav .project-menu-action button{display:flex;width:100%;align-items:center;padding:.65rem;border:0;border-radius:.45rem;background:transparent;color:var(--ink-soft);font-weight:700;text-align:left}.project-menu nav .project-menu-action button:hover{background:rgba(165,243,193,.08)}.project-menu nav .project-menu-action button.destructive{color:var(--danger)}
.sidebar-nav{padding:0;border:0}
@media (max-width:68rem){.project-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:52rem){.app-frame,.app-frame.sidebar-collapsed{display:block}.app-sidebar{position:fixed;z-index:80;left:0;width:min(18rem,88vw);transform:translateX(-105%);transition:transform .18s ease;box-shadow:1.5rem 0 4rem rgba(0,0,0,.45)}.app-frame.mobile-sidebar-open .app-sidebar{transform:translateX(0)}.app-frame.mobile-sidebar-open::after{position:fixed;z-index:70;inset:0;background:rgba(0,0,0,.6);content:""}.sidebar-toggle{display:none}.app-topbar{position:sticky;z-index:60;top:0;justify-content:space-between;min-height:4rem;padding:0 .9rem}.mobile-menu,.mobile-wordmark{display:grid}.mobile-wordmark{padding:0;border:0;background:transparent;color:var(--brand);font-size:1.12rem;font-weight:850;letter-spacing:-.05em}.topbar-account{max-width:42vw}.app-main{padding:1.35rem .9rem 3rem}.workspace-toolbar{display:grid;gap:1.4rem;margin-bottom:2.5rem}.project-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem}.project-provider-row{align-items:flex-start}.project-file-status{position:static;max-width:12rem}.create-project summary{margin-left:0}.project-grid,.provider-grid{grid-template-columns:1fr}}
@media (max-width:42rem){body>main{width:min(100% - 1.25rem,72rem);padding-top:1.35rem}nav{align-items:flex-start;gap:.5rem .8rem}nav strong{width:100%;margin-right:0}nav form{width:100%}h1{font-size:2rem}.dashboard-grid,.feature-grid,.workflow{grid-template-columns:1fr}.hero{border-radius:1rem}.public-hero{min-height:auto}article,aside,section>dl,form{padding:1rem;border-radius:.8rem}dl{grid-template-columns:1fr;gap:.15rem}dd{margin:0 0 .55rem}.actions>*{flex:1 1 auto}.actions a,.actions button{display:inline-block;width:100%;text-align:center}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}
</style></head><body><a class="skip-link" href="#main-content">Skip to content</a>${content}${localTimeScript()}</body></html>`;
}

function sidebarItem({ activeSection, href, icon, key, label }) {
  const current = activeSection === key ? ' aria-current="page"' : "";
  return `<a href="${href}"${current}><span class="nav-icon" aria-hidden="true">${icon}</span><span class="sidebar-label">${label}</span></a>`;
}

export function renderAppPage(title, body, { email, activeSection = "projects" }) {
  const accountInitial =
    String(email || "a")
      .trim()
      .charAt(0) || "a";
  const navigation = [
    { key: "projects", href: "/", icon: "□", label: "Your Projects" },
    { key: "shared", href: "/shared", icon: "◇", label: "Shared with You" },
    { key: "archived", href: "/archived", icon: "◷", label: "Archived Projects" },
    { key: "connections", href: "/connections", icon: "⌁", label: "AI Connections" },
  ]
    .map((item) => sidebarItem({ activeSection, ...item }))
    .join("");
  const shell = `<div class="app-frame" data-app-shell><aside class="app-sidebar" id="app-sidebar"><div class="sidebar-head"><a class="wordmark" href="/" aria-label="alice. workspace">alice.</a><button class="sidebar-toggle" type="button" data-sidebar-collapse aria-controls="app-sidebar" aria-expanded="true"><span aria-hidden="true">‹</span><span class="visually-hidden">Collapse sidebar</span></button></div><nav class="sidebar-nav" aria-label="Workspace">${navigation}</nav><div class="sidebar-meta"><div class="account-card"><span class="account-avatar" aria-hidden="true">${escapeHtml(accountInitial)}</span><span class="account-copy"><strong>Signed in</strong><span>${escapeHtml(email)}</span></span></div><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form><a class="sidebar-privacy" href="/privacy-security">Privacy and security</a></div></aside><div class="app-surface"><header class="app-topbar"><button class="mobile-menu" type="button" data-sidebar-menu aria-controls="app-sidebar" aria-expanded="false"><span aria-hidden="true">☰</span><span class="visually-hidden">Open navigation</span></button><a class="mobile-wordmark" href="/">alice.</a><span class="topbar-account">${escapeHtml(email)}</span></header><main class="app-main" id="main-content">${body}</main></div></div><script>
(()=>{const shell=document.querySelector("[data-app-shell]"),collapse=document.querySelector("[data-sidebar-collapse]"),menu=document.querySelector("[data-sidebar-menu]");if(!shell)return;const closeMobileMenu=()=>{shell.classList.remove("mobile-sidebar-open");menu?.setAttribute("aria-expanded","false")};const setCollapsed=value=>{shell.classList.toggle("sidebar-collapsed",value);collapse?.setAttribute("aria-expanded",String(!value));const label=collapse?.querySelector(".visually-hidden");if(label)label.textContent=value?"Expand sidebar":"Collapse sidebar"};try{setCollapsed(localStorage.getItem("alice-sidebar-collapsed")==="true")}catch{}collapse?.addEventListener("click",()=>{const next=!shell.classList.contains("sidebar-collapsed");setCollapsed(next);try{localStorage.setItem("alice-sidebar-collapsed",String(next))}catch{}});menu?.addEventListener("click",()=>{const open=shell.classList.toggle("mobile-sidebar-open");menu.setAttribute("aria-expanded",String(open))});shell.addEventListener("click",event=>{if(event.target===shell&&shell.classList.contains("mobile-sidebar-open"))closeMobileMenu()});document.addEventListener("keydown",event=>{if(event.key==="Escape"&&shell.classList.contains("mobile-sidebar-open")){closeMobileMenu();menu?.focus()}})})();
</script>`;
  return renderPage(title, shell, { showFooter: false, appShell: true });
}

export function renderStatusPage(title, body, tone = "warning") {
  const safeTone = new Set(["neutral", "warning", "danger"]).has(tone) ? tone : "warning";
  return renderPage(title, `<section class="status-page ${safeTone}">${body}</section>`);
}

export function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name, value]) => name && value)
      .map(([name, ...value]) => [name, decodeURIComponent(value.join("="))]),
  );
}

function setSessionCookie(response, publicUrl, session) {
  const secure = new URL(publicUrl).protocol === "https:" ? "; Secure" : "";
  response.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${session.maxAge}${secure}`,
  );
}

function clearSessionCookie(response, publicUrl) {
  const secure = new URL(publicUrl).protocol === "https:" ? "; Secure" : "";
  response.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );
}

export async function authenticatedUser(database, request) {
  return await userForSession(database, parseCookies(request.get("cookie"))[SESSION_COOKIE]);
}

export function requireAuthenticatedUser(database) {
  return async (request, response, next) => {
    const user = await authenticatedUser(database, request);
    if (!user) {
      const nextUrl = request.originalUrl.startsWith("/") ? request.originalUrl : "/";
      return response.redirect(303, `/auth/login?next=${encodeURIComponent(nextUrl)}`);
    }
    request.aliceUser = user;
    next();
  };
}

function safeNext(value) {
  const next = String(value || "/");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function createAuthRouter({ database, publicUrl }) {
  const router = express.Router();

  router.get("/register", async (request, response) => {
    const invitationToken = String(request.query.invite || "");
    const invitation = await alphaInvitationForToken(database, invitationToken);
    if (!invitation) {
      return response
        .status(403)
        .type("html")
        .send(
          renderStatusPage(
            "Invitation required",
            '<h1>alice. is invite-only</h1><p>This invitation is missing, expired, used, or revoked. No account was created.</p><p><a href="/auth/login">Sign in</a></p>',
            "neutral",
          ),
        );
    }
    response
      .type("html")
      .send(
        renderPage(
          "Create alice. account",
          `<nav><strong>alice.</strong><a href="/about">What alice. does</a><a href="/auth/login">Sign in</a></nav><h1>Create your alice. account</h1><p>Your invitation is for <strong>${escapeHtml(invitation.email)}</strong>.</p><aside class="notice warning"><strong>Private alpha data boundary</strong><p>Do not enter sensitive, regulated, or client-confidential information. Review the <a href="/privacy-security">privacy and security notice</a> before creating your account.</p></aside><form method="post" action="/auth/register"><input type="hidden" name="invitationToken" value="${escapeHtml(invitationToken)}"><label>Email<input name="email" type="email" value="${escapeHtml(invitation.email)}" autocomplete="email" readonly required></label><label>Password<input name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></label><button type="submit">Accept invitation and create account</button></form><p><a href="/auth/login">Already have an account?</a></p>`,
        ),
      );
  });

  router.post("/register", async (request, response) => {
    try {
      const user = await registerUser(database, request.body);
      setSessionCookie(response, publicUrl, await createUserSession(database, user.id));
      response.redirect(303, "/");
    } catch (error) {
      response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Account not created",
            `<h1>Account not created</h1><p>${escapeHtml(String(error))}</p><p><a href="/auth/login">Return to sign in</a></p>`,
            "danger",
          ),
        );
    }
  });

  router.get("/login", (request, response) => {
    const next = safeNext(request.query.next);
    response
      .type("html")
      .send(
        renderPage(
          "Sign in to alice.",
          `<nav><strong>alice.</strong></nav><header class="hero"><p class="eyebrow">Private workspace</p><h1>Continue your projects across AI tools.</h1><p>Sign in to your invite-only alice. workspace. Your projects, AI connections, files, collaborators, and Save decisions stay under your account and current permissions.</p></header><form method="post" action="/auth/login"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Sign in</button></form><p>New accounts require a private invitation.</p>`,
          { showFooter: false },
        ),
      );
  });

  router.post("/login", async (request, response) => {
    const user = await authenticateUser(database, request.body);
    if (!user) {
      return response
        .status(403)
        .type("html")
        .send(
          renderStatusPage(
            "Sign in denied",
            '<h1>Email or password is incorrect.</h1><p>No session was created.</p><p><a href="/auth/login">Try signing in again</a></p>',
            "danger",
          ),
        );
    }
    setSessionCookie(response, publicUrl, await createUserSession(database, user.id));
    response.redirect(303, safeNext(request.body.next));
  });

  router.post("/logout", async (request, response) => {
    await revokeUserSession(database, parseCookies(request.get("cookie"))[SESSION_COOKIE]);
    clearSessionCookie(response, publicUrl);
    response.redirect(303, "/auth/login");
  });

  return router;
}
