import {
  listContextReadEvents,
  listIntegrationConnections,
  revokeIntegrationConnection,
} from "@alice/domain";
import express from "express";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { hostLabel, permissionLabel, timestampLabel } from "./product-copy.ts";

const CHATGPT_PLUGIN_DIRECTORY_URL = "https://chatgpt.com/plugins";
const CLAUDE_CONNECTOR_SETTINGS_URL = "https://claude.ai/customize/connectors";

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
    ? "<p>Reconnect from this host using the alice. MCP address configured for this environment.</p>"
    : `<p>Every project you can access is discoverable through this connection. Only the project named for a task is retrieved.</p><form method="post" action="/connections/${encodeURIComponent(connection.id)}/revoke"><button class="destructive" type="submit">Revoke this connection</button></form>`;
  return `<article class="connection-card${connection.revoked_at ? " revoked" : ""}"><p class="eyebrow">${escapeHtml(hostLabel(connection.client_classification))}</p><h2>${escapeHtml(connection.client_name)}</h2><p><span class="badge">${status}</span></p><dl><dt>Permissions</dt><dd>${escapeHtml(permissionLabel(connection.granted_scopes))}</dd><dt>Connected</dt><dd>${escapeHtml(timestampLabel(connection.first_connected_at))}</dd><dt>Last used</dt><dd>${escapeHtml(timestampLabel(connection.last_used_at))}</dd></dl>${action}</article>`;
}

function readEventCard(event) {
  const route = event.requested_via === "active_target" ? "single-project lookup" : "named project";
  const destination = event.project_name ? ` · ${escapeHtml(event.project_name)}` : "";
  const result =
    event.status === "succeeded"
      ? `Succeeded · package ${escapeHtml(event.package_version)} · ${escapeHtml(event.package_utf8_bytes)} UTF-8 bytes`
      : `Failed · ${escapeHtml(String(event.failure_code).replaceAll("_", " "))}`;
  return `<article><p><strong>${result}</strong></p><p>${escapeHtml(event.client_name)} · ${escapeHtml(hostLabel(event.client_classification))} · ${route}${destination}</p><p class="muted">${escapeHtml(timestampLabel(event.created_at))}</p></article>`;
}

function guidedConnectionScript() {
  return `<script>
for(const link of document.querySelectorAll("[data-copy-mcp-address]")){link.addEventListener("click",()=>{const status=document.getElementById("mcp-copy-status"),address=link.dataset.copyMcpAddress;if(!navigator.clipboard?.writeText){status.textContent="Copy the address above, paste it and choose Connect.";status.className="notice warning";return}navigator.clipboard.writeText(address).then(()=>{status.textContent="The address is copied. Paste it and choose Connect.";status.className="notice accepted"}).catch(()=>{status.textContent="Copy the address above, paste it and choose Connect.";status.className="notice warning"})})}
</script>`;
}

function providerStatusCard({ name, setupUrl, endpoint, connected }) {
  const status = connected
    ? '<span class="provider-light connected"><span class="visually-hidden">Connected</span></span>'
    : '<span class="provider-light"><span class="visually-hidden">Not connected</span></span>';
  const action = connected
    ? ""
    : `<a class="button-link" href="${escapeHtml(setupUrl)}" target="_blank" rel="noopener noreferrer" data-copy-mcp-address="${escapeHtml(endpoint)}" aria-describedby="mcp-copy-status">Connect ${escapeHtml(name)} <span aria-hidden="true">↗</span></a>`;
  return `<article class="provider-status${connected ? " connected" : ""}"><div class="provider-name">${status}<h2>${escapeHtml(name)}</h2></div>${action}</article>`;
}

export function createConnectionsRouter({ database, mcpPublicUrl }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", async (request, response) => {
    const connections = await listIntegrationConnections(database, request.aliceUser!.id);
    const endpoint = new URL("/mcp", mcpPublicUrl).href;
    const claudeSetupUrl = new URL(CLAUDE_CONNECTOR_SETTINGS_URL);
    claudeSetupUrl.searchParams.set("modal", "add-custom-connector");
    claudeSetupUrl.searchParams.set("connectorName", "alice.");
    claudeSetupUrl.searchParams.set("connectorUrl", endpoint);
    const activeProviders = new Set(
      connections
        .filter(({ revoked_at: revokedAt }) => !revokedAt)
        .map(({ client_classification: provider }) => provider),
    );
    const providers = [
      {
        name: "ChatGPT",
        setupUrl: CHATGPT_PLUGIN_DIRECTORY_URL,
        connected: activeProviders.has("chatgpt"),
      },
      {
        name: "Claude",
        setupUrl: claudeSetupUrl.href,
        connected: activeProviders.has("claude"),
      },
    ];
    const providerCards = providers
      .map((provider) => providerStatusCard({ ...provider, endpoint }))
      .join("");
    response
      .type("html")
      .send(
        renderAppPage(
          "AI connections",
          `<div class="connections-home"><header class="workspace-toolbar"><div><p class="eyebrow">AI connections</p><h1>Connect your AI tools.</h1><p>A green light means that provider has an active alice. connection for your account.</p></div></header><section class="provider-grid" aria-label="AI provider status">${providerCards}</section><p id="mcp-copy-status" class="notice" role="status" aria-live="polite">When you connect a provider, alice. copies the exact MCP address and opens its setup page. You review and approve the connection there.</p><a class="advanced-link" href="/connections/advanced">Advanced connection settings</a>${guidedConnectionScript()}</div>`,
          { email: request.aliceUser!.email, activeSection: "connections" },
        ),
      );
  });

  router.get("/advanced", async (request, response) => {
    const [connections, readEvents] = await Promise.all([
      listIntegrationConnections(database, request.aliceUser!.id),
      listContextReadEvents(database, { userId: request.aliceUser!.id, limit: 25 }),
    ]);
    const endpoint = new URL("/mcp", mcpPublicUrl).href;
    const escapedEndpoint = escapeHtml(endpoint);
    const cards = connections.map((connection) => connectionCard(connection)).join("");
    const readActivity = readEvents.length
      ? readEvents.map(readEventCard).join("")
      : "<p>No successful or failed host context read has been recorded for your AI connections. This does not mean a host consulted alice.</p>";
    response
      .type("html")
      .send(
        renderAppPage(
          "Advanced AI connection settings",
          `<header class="hero"><p class="eyebrow">Advanced settings</p><h1>Connection details and activity</h1><p>Review individual OAuth connections, revocation, and content-free read receipts.</p><p><a href="/connections">Back to AI connections</a></p></header><section class="connection-setup"><div class="section-heading"><h2>Your alice. MCP address</h2><p class="muted">One address for your account connections</p></div><pre id="mcp-address"><code>${escapedEndpoint}</code></pre></section><section><div class="section-heading"><h2>Individual connections</h2><p class="muted">${connections.filter(({ revoked_at: revokedAt }) => !revokedAt).length} active</p></div>${cards || '<div class="empty-state"><h2>No connection records</h2><p>Return to AI connections to add ChatGPT or Claude.</p></div>'}</section><section><div class="section-heading"><h2>Your recent host reads</h2><p class="muted">Immutable, content-free receipts</p></div><p>These receipts distinguish successful retrieval from failure. Success does not prove that a host used the returned project information in its answer.</p>${readActivity}</section>`,
          { email: request.aliceUser!.email, activeSection: "connections" },
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
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Connection not found</h1><p>The connection may already be revoked or outside your account.</p><p><a href="/connections">Return to AI connections</a></p>',
            "neutral",
          ),
        );
    }
    response.redirect(303, "/connections");
  });

  return router;
}
