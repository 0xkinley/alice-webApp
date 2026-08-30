import {
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>
body{font:16px system-ui;max-width:58rem;margin:3rem auto;padding:0 1rem;color:#171717}article{border:1px solid #ddd;border-radius:.7rem;padding:1rem;margin:1rem 0}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f7f7;padding:.8rem;border-radius:.4rem}button,input,textarea{font:inherit;padding:.6rem}.muted{color:#666}.accepted{border-color:#9ccca9;background:#f3fff5}.rejected{border-color:#d5a1a1;background:#fff6f6}label{display:block;margin:.8rem 0}input,textarea{width:100%;box-sizing:border-box}nav,.actions{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .8rem}dt{font-weight:700}dd{margin:0}</style></head><body>${body}</body></html>`;
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

  router.get("/register", (_request, response) => {
    response
      .type("html")
      .send(
        renderPage(
          "Create alice. account",
          `<h1>Create your alice. account</h1><p>Each account receives one private workspace.</p><form method="post" action="/auth/register"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></label><button type="submit">Create account</button></form><p><a href="/auth/login">Already have an account?</a></p>`,
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
          `<h1>Sign in to alice.</h1><form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form><p><a href="/auth/register">Create an account</a></p>`,
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
