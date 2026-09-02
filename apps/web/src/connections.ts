import {
  listContextReadEvents,
  listIntegrationConnections,
  listSelectableProjectContexts,
  revokeIntegrationConnection,
  setActiveConnectionTarget,
} from "@alice/domain";
import express from "express";
import { renderPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { hostLabel, permissionLabel, timestampLabel } from "./product-copy.ts";

const CHATGPT_APP_SETTINGS_URL = "https://chatgpt.com/#settings/Apps";
const CLAUDE_CONNECTOR_SETTINGS_URL = "https://claude.ai/settings/connectors";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function selectionOptions(projects, connection) {
  return projects
    .map(
      (project) =>
        `<optgroup label="${escapeHtml(project.name)}">${project.contexts
          .map(
            (context) =>
              `<option value="${escapeHtml(`${project.id}|${context.id}`)}"${connection.project_id === project.id && connection.context_id === context.id ? " selected" : ""}>${escapeHtml(context.name)}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("");
}

function connectionCard(connection, projects, expectedVersions) {
  const status = connection.revoked_at ? "Revoked" : "Connected";
  const action = connection.revoked_at
    ? "<p>Reconnect from this host using the alice. MCP address configured for this environment.</p>"
    : `${projects.some(({ contexts }) => contexts.length > 0) ? `<form method="post" action="/connections/${encodeURIComponent(connection.id)}/target"><label>Active project and work context<select name="target" required>${selectionOptions(projects, connection)}</select></label><input type="hidden" name="expected_versions" value="${escapeHtml(JSON.stringify(expectedVersions))}"><label><input name="apply_all" type="checkbox" value="yes"> Apply this target to all active AI connections</label><button type="submit">Confirm active target</button></form>` : '<p class="notice">Create a project work context before selecting a target.</p>'}<form method="post" action="/connections/${encodeURIComponent(connection.id)}/revoke"><button class="destructive" type="submit">Revoke this connection</button></form>`;
  const current = connection.context_id
    ? `<p><strong>Active target:</strong> ${escapeHtml(connection.project_name)} / ${escapeHtml(connection.context_name)}</p>`
    : "<p><strong>Active target:</strong> Not selected</p>";
  return `<article class="connection-card${connection.revoked_at ? " revoked" : ""}"><p class="eyebrow">${escapeHtml(hostLabel(connection.client_classification))}</p><h2>${escapeHtml(connection.client_name)}</h2><p><span class="badge">${status}</span></p>${current}<dl><dt>Permissions</dt><dd>${escapeHtml(permissionLabel(connection.granted_scopes))}</dd><dt>Connected</dt><dd>${escapeHtml(timestampLabel(connection.first_connected_at))}</dd><dt>Last used</dt><dd>${escapeHtml(timestampLabel(connection.last_used_at))}</dd></dl>${action}</article>`;
}

function readEventCard(event) {
  const route = event.requested_via === "active_target" ? "active target" : "explicit fallback";
  const destination = event.context_name
    ? ` · ${escapeHtml(event.project_name)} / ${escapeHtml(event.context_name)}`
    : "";
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

export function createConnectionsRouter({ database, mcpPublicUrl }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", async (request, response) => {
    const [connections, projects, readEvents] = await Promise.all([
      listIntegrationConnections(database, request.aliceUser!.id),
      listSelectableProjectContexts(database, request.aliceUser!.id),
      listContextReadEvents(database, { userId: request.aliceUser!.id, limit: 25 }),
    ]);
    const expectedVersions = Object.fromEntries(
      connections
        .filter(({ revoked_at: revokedAt }) => !revokedAt)
        .map((connection) => [connection.id, connection.target_version || null]),
    );
    const endpoint = new URL("/mcp", mcpPublicUrl).href;
    const escapedEndpoint = escapeHtml(endpoint);
    const cards = connections
      .map((connection) => connectionCard(connection, projects, expectedVersions))
      .join("");
    const readActivity = readEvents.length
      ? readEvents.map(readEventCard).join("")
      : "<p>No successful or failed host context read has been recorded for your AI connections. This does not mean a host consulted alice.</p>";
    response
      .type("html")
      .send(
        renderPage(
          "AI connections",
          `<nav><a href="/">Projects</a></nav><header class="hero"><p class="eyebrow">Your connections</p><h1>Add alice. to the AI tools you use.</h1><p>Choose a provider below. alice. copies this environment's exact MCP address and opens the provider in a new tab. You still review and approve the connection there.</p></header><section class="connection-setup"><div class="section-heading"><h2>Your alice. MCP address</h2><p class="muted">One address for your account connections</p></div><pre id="mcp-address"><code>${escapedEndpoint}</code></pre><p id="mcp-copy-status" class="notice" role="status" aria-live="polite">Choose a provider to copy the address and continue.</p><div class="dashboard-grid"><section><p class="eyebrow">OpenAI</p><h2>Add alice. to ChatGPT</h2><p>In ChatGPT, open Apps and add a custom app. Paste the copied address, then choose Connect.</p><a class="button-link" href="${CHATGPT_APP_SETTINGS_URL}" target="_blank" rel="noopener noreferrer" data-copy-mcp-address="${escapedEndpoint}" aria-describedby="mcp-copy-status">Add alice. to ChatGPT <span aria-hidden="true">↗</span></a></section><section><p class="eyebrow">Anthropic</p><h2>Add alice. to Claude</h2><p>In Claude Connectors, choose Add custom connector. Paste the copied address, then choose Connect.</p><a class="button-link" href="${CLAUDE_CONNECTOR_SETTINGS_URL}" target="_blank" rel="noopener noreferrer" data-copy-mcp-address="${escapedEndpoint}" aria-describedby="mcp-copy-status">Add alice. to Claude <span aria-hidden="true">↗</span></a></section></div><p class="muted">If copying is unavailable, select the address above and paste it manually. Complete alice. sign-in and review the requested read and propose-for-review permissions. Provider availability still depends on the exact account, plan, workspace, region, and client surface.</p></section><section><div class="section-heading"><h2>Connection status</h2><p class="muted">${connections.filter(({ revoked_at: revokedAt }) => !revokedAt).length} active</p></div>${cards || '<div class="empty-state"><h2>No AI host is connected</h2><p>Use a guided setup above when this environment is ready for a supported host connection.</p></div>'}</section><section><div class="section-heading"><h2>Your recent host reads</h2><p class="muted">Immutable, content-free receipts</p></div><p>These receipts distinguish successful retrieval from failure. Success does not prove that a host used the returned context in its answer.</p>${readActivity}</section>${guidedConnectionScript()}`,
        ),
      );
  });

  router.post("/:connectionId/target", async (request, response) => {
    const [projectId, contextId, extra] = String(request.body.target || "").split("|");
    if (!projectId || !contextId || extra) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Invalid target",
            '<h1>Select a valid project and work context.</h1><p><a href="/connections">Return to AI connections</a></p>',
          ),
        );
    }
    let expectedVersions;
    try {
      expectedVersions = JSON.parse(String(request.body.expected_versions || ""));
    } catch {
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Selection changed",
            '<h1>Reload before changing this target.</h1><p>Nothing was changed.</p><p><a href="/connections">Review current targets</a></p>',
          ),
        );
    }
    const result = await setActiveConnectionTarget(database, {
      userId: request.aliceUser!.id,
      connectionId: request.params.connectionId,
      projectId,
      contextId,
      applyToAll: request.body.apply_all === "yes",
      expectedVersions,
    });
    if (!result) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Connection or target not found</h1><p>The connection may be unavailable or outside your account.</p><p><a href="/connections">Return to AI connections</a></p>',
            "neutral",
          ),
        );
    }
    if (result.conflict) {
      return response
        .status(409)
        .type("html")
        .send(
          renderStatusPage(
            "Selection changed",
            '<h1>An active target changed in another session.</h1><p>Nothing was overwritten.</p><p><a href="/connections">Review current targets and try again.</a></p>',
          ),
        );
    }
    response.redirect(303, "/connections");
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
