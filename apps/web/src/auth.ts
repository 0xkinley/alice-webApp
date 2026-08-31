import {
  alphaInvitationForToken,
  authenticateUser,
  createUserSession,
  registerUser,
  revokeUserSession,
  userForSession,
} from "@alice/domain";
import express from "express";

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

export function renderPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · alice.</title><style>
:root{color-scheme:dark;--canvas:#0b1017;--surface:#121a25;--surface-raised:#182230;--surface-soft:#101823;--line:#2a394b;--line-strong:#40546d;--ink:#edf3fa;--ink-soft:#b4c0d0;--ink-muted:#8290a2;--brand:#a5f3c1;--brand-ink:#092214;--focus:#82b7ff;--danger:#ff9d9d;--danger-surface:#311b25;--success:#a5f3c1;--success-surface:#11281f;--shadow:0 20px 55px rgba(0,0,0,.25)}
*{box-sizing:border-box}html{background:var(--canvas)}body{min-width:20rem;margin:0;background:radial-gradient(circle at top right,#1a2a3d 0,transparent 31rem),var(--canvas);color:var(--ink);font:400 16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body>main{width:min(72rem,calc(100% - 2rem));margin:0 auto;padding:2.25rem 0 4rem}.skip-link{position:fixed;z-index:10;top:.75rem;left:.75rem;transform:translateY(-180%);padding:.65rem .85rem;border-radius:.5rem;background:var(--focus);color:#061321;font-weight:700;text-decoration:none}.skip-link:focus{transform:translateY(0)}
h1,h2,h3{max-width:42rem;margin:0 0 .55rem;letter-spacing:-.025em;line-height:1.15}h1{font-size:clamp(2rem,5vw,3.45rem)}h2{margin-top:2.25rem;font-size:clamp(1.25rem,2.5vw,1.75rem)}h3{font-size:1rem}p{max-width:68ch;margin:.55rem 0;color:var(--ink-soft)}a{color:#b9d7ff;text-underline-offset:.18em}a:hover{color:#edf5ff}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
nav{display:flex;align-items:center;gap:.65rem 1rem;flex-wrap:wrap;margin:0 0 1.8rem;padding:0 0 1rem;border-bottom:1px solid var(--line)}nav strong{margin-right:auto;color:var(--brand);font-size:1.2rem;letter-spacing:-.04em}nav span{color:var(--ink-muted);font-size:.9rem}nav form{margin:0}nav form button{padding:.36rem .55rem;background:transparent;color:var(--ink-soft);border-color:transparent}.actions{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin-top:1rem}.actions form{margin:0}
.eyebrow{margin:0 0 .8rem;color:var(--brand);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero{margin:0 0 2.25rem;padding:clamp(1.35rem,4vw,2.7rem);border:1px solid var(--line);border-radius:1.25rem;background:linear-gradient(120deg,rgba(165,243,193,.14),transparent 43%),linear-gradient(200deg,rgba(130,183,255,.09),transparent 55%),var(--surface)}.hero h1{max-width:18ch}.hero p:not(.eyebrow){font-size:1.08rem}.dashboard-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.dashboard-grid>section{margin:0}.dashboard-grid>section>h2{margin-top:0}.context-card{position:relative;overflow:hidden}.context-card::before{position:absolute;top:0;left:0;width:.24rem;height:100%;background:var(--brand);content:""}.context-card .context-meta{display:flex;gap:.45rem;flex-wrap:wrap;color:var(--ink-muted);font-size:.86rem}.badge{display:inline-flex;align-items:center;width:max-content;padding:.18rem .5rem;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-soft);color:var(--ink-soft);font-size:.78rem;font-weight:700}.empty-state{display:grid;gap:.45rem;min-height:11rem;align-content:center;padding:1.25rem;border:1px dashed var(--line-strong);border-radius:1rem;background:rgba(18,26,37,.55)}.empty-state h2{margin:0}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin:2.25rem 0 .8rem}.section-heading h2{margin:0}.section-heading p{margin:0}
.notice{margin:1rem 0;padding:1rem 1.1rem;border:1px solid var(--line-strong);border-radius:.85rem;background:var(--surface-soft)}.notice strong{color:var(--ink)}.notice.warning{border-color:#8d7041;background:#2b2315}.notice.danger{border-color:#8c4b5a;background:var(--danger-surface)}button.destructive{border-color:#9f5364;background:#562b38;color:#ffecef}button.destructive:hover{filter:brightness(1.16)}.connection-card{display:grid;gap:.35rem}.connection-card form{margin:.55rem 0 0}.connection-card.revoked{border-color:#6f6171;background:linear-gradient(135deg,rgba(180,160,190,.08),transparent 60%),var(--surface)}
article,aside,section>dl{margin:1rem 0;padding:1.1rem 1.2rem;border:1px solid var(--line);border-radius:1rem;background:linear-gradient(135deg,rgba(255,255,255,.035),transparent 60%),var(--surface);box-shadow:var(--shadow)}article h2,article h3{margin-top:0}article p:last-child{margin-bottom:0}section{margin:2rem 0}.accepted{border-color:#477e5c;background:linear-gradient(135deg,rgba(165,243,193,.1),transparent 60%),var(--success-surface)}.rejected{border-color:#8c4b5a;background:linear-gradient(135deg,rgba(255,157,157,.08),transparent 60%),var(--danger-surface)}
form{max-width:44rem;margin:1.25rem 0;padding:1.2rem;border:1px solid var(--line);border-radius:1rem;background:var(--surface-soft)}label{display:block;margin:1rem 0;color:var(--ink);font-weight:650}input,textarea,select,button{font:inherit}input,textarea,select{display:block;width:100%;margin-top:.4rem;padding:.7rem .8rem;border:1px solid var(--line-strong);border-radius:.6rem;background:#0d141e;color:var(--ink)}textarea{min-height:7rem;resize:vertical}input[type="checkbox"],input[type="radio"]{display:inline-block;width:auto;margin-right:.45rem;accent-color:var(--brand)}input[type="file"]{padding:.55rem}button{cursor:pointer;padding:.68rem .95rem;border:1px solid var(--brand);border-radius:.6rem;background:var(--brand);color:var(--brand-ink);font-weight:750}button:hover{filter:brightness(1.06)}button:disabled{cursor:not-allowed;opacity:.55}.muted{color:var(--ink-muted);font-size:.93rem}.accepted strong{color:var(--success)}.rejected strong{color:var(--danger)}
code{padding:.08rem .28rem;border-radius:.25rem;background:#0c141e;color:#d5e6ff;overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;border:1px solid var(--line);border-radius:.7rem;background:#090f17;color:#d5e6ff;font-size:.88rem}dl{display:grid;grid-template-columns:minmax(10rem,max-content) 1fr;gap:.5rem 1rem;margin:1rem 0}dt{color:var(--ink-muted);font-weight:700}dd{min-width:0;margin:0}details{margin:1rem 0;padding:.8rem;border:1px solid var(--line);border-radius:.7rem;background:var(--surface-soft)}summary{cursor:pointer;color:var(--ink);font-weight:700}progress{accent-color:var(--brand);width:100%;margin-top:.75rem}
@media (max-width:42rem){body>main{width:min(100% - 1.25rem,72rem);padding-top:1.35rem}nav{align-items:flex-start;gap:.5rem .8rem}nav strong{width:100%;margin-right:0}nav form{width:100%}h1{font-size:2rem}.dashboard-grid{grid-template-columns:1fr}.hero{border-radius:1rem}article,aside,section>dl,form{padding:1rem;border-radius:.8rem}dl{grid-template-columns:1fr;gap:.15rem}dd{margin:0 0 .55rem}.actions>*{flex:1 1 auto}.actions a,.actions button{display:inline-block;width:100%;text-align:center}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}
</style></head><body><a class="skip-link" href="#main-content">Skip to content</a><main id="main-content">${body}</main></body></html>`;
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
    `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${session.maxAge}${secure}`,
  );
}

function clearSessionCookie(response, publicUrl) {
  const secure = new URL(publicUrl).protocol === "https:" ? "; Secure" : "";
  response.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
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
          renderPage(
            "Invitation required",
            '<h1>alice. is invite-only</h1><p>This invitation is missing, expired, used, or revoked.</p><p><a href="/auth/login">Sign in</a></p>',
          ),
        );
    }
    response
      .type("html")
      .send(
        renderPage(
          "Create alice. account",
          `<h1>Create your alice. account</h1><p>Your invitation is for <strong>${escapeHtml(invitation.email)}</strong>.</p><form method="post" action="/auth/register"><input type="hidden" name="invitationToken" value="${escapeHtml(invitationToken)}"><label>Email<input name="email" type="email" value="${escapeHtml(invitation.email)}" autocomplete="email" readonly required></label><label>Password<input name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></label><button type="submit">Accept invitation and create account</button></form><p><a href="/auth/login">Already have an account?</a></p>`,
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
          renderPage(
            "Account not created",
            `<h1>Account not created</h1><p>${escapeHtml(String(error))}</p>`,
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
          `<h1>Sign in to alice.</h1><form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form><p>New accounts require an alpha invitation.</p>`,
        ),
      );
  });

  router.post("/login", async (request, response) => {
    const user = await authenticateUser(database, request.body);
    if (!user) {
      return response
        .status(403)
        .type("html")
        .send(renderPage("Sign in denied", "<h1>Email or password is incorrect.</h1>"));
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
