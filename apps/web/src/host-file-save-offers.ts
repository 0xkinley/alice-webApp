import {
  decideHostFileSaveOffer,
  getHostFileSaveOfferPreview,
  HostFileSaveOfferUserError,
} from "@alice/domain";
import type { HostFileSaveDecision } from "@alice/domain";
import express from "express";
import { renderPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { accessLabel, hostLabel, timestampLabel } from "./product-copy.ts";

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

function decisionSummary(status) {
  if (status === "save_file_only") return "Save file only";
  if (status === "save_and_suggest_context") return "Save file and request context suggestions";
  if (status === "cancelled") return "Not now — no file transfer authorized";
  return "Awaiting your decision";
}

function offerPage(offer) {
  const unavailable = offer.expired || !offer.target_is_current;
  const pending = offer.status === "pending";
  const notice = !pending
    ? `<p class="notice"><strong>Already decided:</strong> ${escapeHtml(decisionSummary(offer.status))}. No attachment bytes were received by this confirmation step.</p>`
    : offer.expired
      ? '<p class="notice warning"><strong>This offer expired.</strong> Ask the host for a new exact preview. No attachment bytes were received.</p>'
      : !offer.target_is_current
        ? '<p class="notice warning"><strong>Your active project or context changed.</strong> Ask the host for a new exact preview. No attachment bytes were received.</p>'
        : '<p class="notice"><strong>No file has been copied.</strong> Confirming authorizes transfer only for the exact destination below. alice. still verifies, scans, stores, and authorizes the bytes before claiming the file is saved.</p>';
  const actions =
    pending && !unavailable
      ? `<form method="post" action="/file-save-offers/${encodeURIComponent(offer.offer_id)}/decision"><input type="hidden" name="preview_version" value="${escapeHtml(offer.decision_version)}"><fieldset><legend>Choose exactly one action</legend><button name="decision" value="save_file_only" type="submit">Save file only</button> <button name="decision" value="save_and_suggest_context" type="submit">Save file and suggest context</button> <button name="decision" value="cancelled" type="submit">Not now</button></fieldset></form>`
      : "";
  const conversation = offer.conversation_reference
    ? `<dt>Conversation reference</dt><dd><code>${escapeHtml(offer.conversation_reference)}</code> · opaque identifier only</dd>`
    : "";
  return renderPage(
    "Host file save offer",
    `<nav><a href="/">Private workspace</a><a href="/connections">AI connections</a></nav><header class="hero"><p class="eyebrow">Exact attachment preview</p><h1>Save this file to alice.?</h1><p>The host cannot answer this question for you. Only this authenticated alice. action can authorize attachment transfer.</p></header>${notice}<section><h2>Exact file and destination</h2><dl><dt>Filename</dt><dd>${escapeHtml(offer.file.name)}</dd>${optionalFileMetadata(offer)}<dt>Project</dt><dd>${escapeHtml(offer.destination.project_name)}</dd><dt>Work context</dt><dd>${escapeHtml(offer.destination.context_name)}</dd><dt>Access</dt><dd>${escapeHtml(accessLabel(offer.destination.access))}</dd><dt>Source host</dt><dd>${escapeHtml(hostLabel(offer.source_host))}</dd>${conversation}<dt>Offer expires</dt><dd>${escapeHtml(timestampLabel(offer.expires_at))}</dd><dt>Offer receipt</dt><dd><code>${escapeHtml(offer.offer_id)}</code></dd></dl></section>${actions}<p class="muted">“Save file and suggest context” requests suggestions only after a validated clean file exists. It does not activate any file statement as trusted project context.</p>`,
  );
}

export function createHostFileSaveOffersRouter({ database, publicUrl }) {
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
    response.type("html").send(offerPage(offer));
  });

  router.post("/:offerId/decision", async (request, response) => {
    try {
      const result = await decideHostFileSaveOffer(database, {
        userId: request.aliceUser!.id,
        offerId: request.params.offerId,
        previewVersion: String(request.body.preview_version || ""),
        decision: String(request.body.decision || "") as HostFileSaveDecision,
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
      const cancelled = result.status === "cancelled";
      response
        .type("html")
        .send(
          renderStatusPage(
            cancelled ? "File save cancelled" : "File transfer authorized",
            cancelled
              ? `<h1>Not now</h1><p>${escapeHtml(result.file.name)} was not authorized for transfer and no attachment bytes were received.</p><p><a href="/">Return to your private workspace</a></p>`
              : `<h1>Transfer authorized</h1><p>Return to ${escapeHtml(hostLabel(result.source_host))}. alice. has permission to receive only ${escapeHtml(result.file.name)} for ${escapeHtml(result.destination.project_name)} / ${escapeHtml(result.destination.context_name)}.</p><p><strong>The file is not saved yet.</strong> alice. will claim success only after receiving, verifying, scanning, storing, authorizing, and auditing the bytes.</p><p><a href="/file-save-offers/${encodeURIComponent(result.offer_id)}">View the decision receipt</a></p>`,
            cancelled ? "neutral" : "warning",
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

  return router;
}
