import { listIntegrationConnections, revokeIntegrationConnection } from "@alice/domain";
import express from "express";
import { renderPage, requireAuthenticatedUser } from "./auth.ts";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function connectionCard(connection) {
  const status = connection.revoked_at ? "Revoked" : "Connected";
  const action = connection.revoked_at
    ? "<p>Reconnect from this host using the same stable alice. MCP address.</p>"
    : `<form method="post" action="/connections/${encodeURIComponent(connection.id)}/revoke"><button type="submit">Revoke this connection</button></form>`;
  return `<article><h2>${escapeHtml(connection.client_name)}</h2><p><strong>${status}</strong> · ${escapeHtml(connection.client_classification)}</p><dl><dt>Permissions</dt><dd>${escapeHtml(connection.granted_scopes)}</dd><dt>Connected</dt><dd>${escapeHtml(connection.first_connected_at)}</dd><dt>Last used</dt><dd>${escapeHtml(connection.last_used_at)}</dd></dl>${action}</article>`;
}

export function createConnectionsRouter({ database, mcpPublicUrl }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", async (request, response) => {
    const connections = await listIntegrationConnections(database, request.aliceUser!.id);
    const endpoint = new URL("/mcp", mcpPublicUrl).href;
    const cards = connections.map(connectionCard).join("");
    response
      .type("html")
      .send(
        renderPage(
          "AI connections",
          `<nav><a href="/">Projects</a></nav><h1>AI connections</h1><p>Connect each host with your own alice. account. Collaborators never inherit or share these permissions.</p><section><h2>Connect ChatGPT</h2><p>Add a custom remote MCP connection in ChatGPT and use this stable address:</p><pre>${escapeHtml(endpoint)}</pre><p>Complete alice. sign-in and review the requested read and candidate-save permissions.</p></section><section><h2>Connect Claude</h2><p>Add a custom remote connector in Claude using the same stable address, then authorize your own alice. account.</p><pre>${escapeHtml(endpoint)}</pre></section><h2>Connection status</h2>${cards || "<p>No AI host is connected yet.</p>"}`,
        ),
      );
  });

  router.post("/:connectionId/revoke", async (request, response) => {
    const result = await revokeIntegrationConnection(database, {
      userId: request.aliceUser!.id,
      connectionId: request.params.connectionId,
    });
    if (!result) {
      return response
        .status(404)
        .type("html")
        .send(renderPage("Not found", "<h1>Connection not found</h1>"));
    }
    response.redirect(303, "/connections");
  });

  return router;
}
