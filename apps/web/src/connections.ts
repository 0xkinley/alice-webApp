import {
  listIntegrationConnections,
  listSelectableProjectContexts,
  revokeIntegrationConnection,
  setActiveConnectionTarget,
} from "@alice/domain";
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
    ? "<p>Reconnect from this host using the same stable alice. MCP address.</p>"
    : `${projects.some(({ contexts }) => contexts.length > 0) ? `<form method="post" action="/connections/${encodeURIComponent(connection.id)}/target"><input type="hidden" name="expected_versions" value="${escapeHtml(JSON.stringify(expectedVersions))}"><label>Active project and work context<select name="target" required>${selectionOptions(projects, connection)}</select></label><label><input name="apply_all" type="checkbox" value="yes"> Apply this target to all active AI connections</label><button type="submit">Confirm active target</button></form>` : "<p>Create a project work context before selecting a target.</p>"}<form method="post" action="/connections/${encodeURIComponent(connection.id)}/revoke"><button type="submit">Revoke this connection</button></form>`;
  const current = connection.context_id
    ? `<p><strong>Active target:</strong> ${escapeHtml(connection.project_name)} / ${escapeHtml(connection.context_name)}</p>`
    : "<p><strong>Active target:</strong> Not selected</p>";
  return `<article><h2>${escapeHtml(connection.client_name)}</h2><p><strong>${status}</strong> · ${escapeHtml(connection.client_classification)}</p>${current}<dl><dt>Permissions</dt><dd>${escapeHtml(connection.granted_scopes)}</dd><dt>Connected</dt><dd>${escapeHtml(connection.first_connected_at)}</dd><dt>Last used</dt><dd>${escapeHtml(connection.last_used_at)}</dd></dl>${action}</article>`;
}

export function createConnectionsRouter({ database, mcpPublicUrl }) {
  const router = express.Router();
  router.use(requireAuthenticatedUser(database));

  router.get("/", async (request, response) => {
    const [connections, projects] = await Promise.all([
      listIntegrationConnections(database, request.aliceUser!.id),
      listSelectableProjectContexts(database, request.aliceUser!.id),
    ]);
    const expectedVersions = Object.fromEntries(
      connections
        .filter(({ revoked_at: revokedAt }) => !revokedAt)
        .map((connection) => [connection.id, connection.target_version || null]),
    );
    const endpoint = new URL("/mcp", mcpPublicUrl).href;
    const cards = connections
      .map((connection) => connectionCard(connection, projects, expectedVersions))
      .join("");
    response
      .type("html")
      .send(
        renderPage(
          "AI connections",
          `<nav><a href="/">Projects</a></nav><h1>AI connections</h1><p>Connect each host with your own alice. account. Collaborators never inherit or share these permissions.</p><section><h2>Connect ChatGPT</h2><p>Add a custom remote MCP connection in ChatGPT and use this stable address:</p><pre>${escapeHtml(endpoint)}</pre><p>Complete alice. sign-in and review the requested read and candidate-save permissions.</p></section><section><h2>Connect Claude</h2><p>Add a custom remote connector in Claude using the same stable address, then authorize your own alice. account.</p><pre>${escapeHtml(endpoint)}</pre></section><h2>Connection status</h2>${cards || "<p>No AI host is connected yet.</p>"}`,
        ),
      );
  });

  router.post("/:connectionId/target", async (request, response) => {
    const [projectId, contextId, extra] = String(request.body.target || "").split("|");
    if (!projectId || !contextId || extra) {
      return response
        .status(400)
        .type("html")
        .send(renderPage("Invalid target", "<h1>Select a valid project and work context.</h1>"));
    }
    let expectedVersions;
    try {
      expectedVersions = JSON.parse(String(request.body.expected_versions || ""));
    } catch {
      return response
        .status(409)
        .type("html")
        .send(renderPage("Selection changed", "<h1>Reload before changing this target.</h1>"));
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
        .send(renderPage("Not found", "<h1>Connection or target not found</h1>"));
    }
    if (result.conflict) {
      return response
        .status(409)
        .type("html")
        .send(
          renderPage(
            "Selection changed",
            '<h1>An active target changed in another session.</h1><p><a href="/connections">Review current targets and try again.</a></p>',
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
        .send(renderPage("Not found", "<h1>Connection not found</h1>"));
    }
    response.redirect(303, "/connections");
  });

  return router;
}
