import { approveOAuthConsentTransaction, getOAuthConsentTransaction } from "@alice/domain";
import express from "express";
import {
  authenticatedUser,
  renderAppPage,
  renderStatusPage,
  requireAuthenticatedUser,
} from "./auth.ts";
import { escapeHtml } from "./human-readable.ts";
import { hostLabel } from "./product-copy.ts";

function providerForClient(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("chatgpt") || normalized.includes("openai")) return "chatgpt";
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude";
  return "unknown_mcp_client";
}

function scopeLabel(scope: string): string {
  if (scope === "mcp:read") return "Find and read the exact project named for a task";
  if (scope === "mcp:write") return "Prepare updates for your review and Save action";
  if (scope === "offline_access") return "Stay connected until you revoke access";
  return "Use alice. within the approved connection";
}

function invalidConsent(response) {
  return response
    .status(400)
    .type("html")
    .set("Cache-Control", "no-store")
    .send(
      renderStatusPage(
        "Connection request unavailable",
        '<h1>This connection request is unavailable</h1><p>It may have expired or already been used. Start the connection again from your AI platform.</p><p><a href="/connections">Return to AI connections</a></p>',
        "neutral",
      ),
    );
}

export function createOAuthConsentRouter({ database }) {
  const router = express.Router();

  router.get("/", async (request, response) => {
    const token = String(request.query.request || "");
    const consent = await getOAuthConsentTransaction(database, token);
    if (!consent) return invalidConsent(response);
    const user = await authenticatedUser(database, request);
    if (!user) {
      const next = `/oauth/consent?request=${encodeURIComponent(token)}`;
      return response.redirect(303, `/auth/login?next=${encodeURIComponent(next)}`);
    }
    const provider = hostLabel(providerForClient(consent.client_name));
    const permissions = consent.scopes
      .map((scope) => `<li>${escapeHtml(scopeLabel(scope))}</li>`)
      .join("");
    const action = consent.approved
      ? '<p class="notice accepted"><strong>Connection approved.</strong> Return to your AI platform to continue.</p>'
      : `<form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${escapeHtml(token)}"><button type="submit">Authorize ${escapeHtml(provider)}</button></form>`;
    const body = `<div class="consent-layout"><header class="hero"><p class="eyebrow">AI connection</p><h1>Connect ${escapeHtml(provider)} to alice.?</h1><p>You are signed in as <strong>${escapeHtml(user.email)}</strong>.</p></header><section><h2>What this connection can do</h2><ul class="permission-list">${permissions}</ul><aside class="notice"><strong>Your projects stay separated.</strong><p>${escapeHtml(provider)} can discover the names of projects you may access. For a task, alice. retrieves only the exact project named or selected—never every project’s contents.</p></aside><aside class="notice"><strong>You remain in control of changes.</strong><p>The AI can prepare a readable preview, but only your authenticated Save action can change trusted project information or authorize an attachment transfer.</p></aside>${action}<p><a href="/connections">Cancel and return to AI connections</a></p></section></div>`;
    response
      .type("html")
      .set("Cache-Control", "no-store")
      .send(
        renderAppPage(`Authorize ${provider}`, body, {
          email: user.email,
          activeSection: "connections",
        }),
      );
  });

  router.post("/", requireAuthenticatedUser(database), async (request, response) => {
    const result = await approveOAuthConsentTransaction(database, {
      token: request.body.request,
      userId: request.aliceUser!.id,
    });
    if (!result) return invalidConsent(response);
    response.redirect(303, result.complete_url);
  });

  return router;
}
