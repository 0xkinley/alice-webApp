import { createHash } from "node:crypto";
import { issueAlphaInvitation, provisionInitialWorkContexts, registerUser } from "@alice/domain";

export const TEST_EMAIL = "tester@alice.example";
export const TEST_PASSWORD = "correct horse battery staple";

export async function createTestIdentity(
  database,
  { email = TEST_EMAIL, password = TEST_PASSWORD, projectId = "project_switchboard_launch" } = {},
) {
  const invitation = await issueAlphaInvitation(database, { email });
  const user = await registerUser(database, {
    email,
    password,
    invitationToken: invitation.token,
  });
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO projects (id, workspace_id, name, brief, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      user.workspace_id,
      projectId === "project_switchboard_launch" ? "Switchboard Launch" : "Private project",
      "Test project",
      now,
      now,
    );
  await provisionInitialWorkContexts(database, {
    userId: user.id,
    workspaceId: user.workspace_id,
    projectId,
    createdAt: now,
    providerAvailability: { chatgpt: true, claude: true },
  });
  return { ...user, project_id: projectId };
}

export async function getProjectDefaultContext(database, projectId) {
  return await database
    .prepare(
      `SELECT context.*
       FROM project_default_contexts mapping
       JOIN work_contexts context
         ON context.workspace_id = mapping.workspace_id
        AND context.project_id = mapping.project_id
        AND context.id = mapping.context_id
       WHERE mapping.project_id = ?`,
    )
    .get(projectId);
}

// Shared round-trip helpers exercise the workspace source entry points.

export async function authorize(
  baseUrl,
  { email = TEST_EMAIL, password = TEST_PASSWORD, clientName = "ChatGPT integration test" } = {},
) {
  const redirectUri = "http://127.0.0.1/callback";
  const registrationResponse = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  const client = await registrationResponse.json();
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationResponse = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "test-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write offline_access",
      resource: "http://127.0.0.1/mcp",
      email,
      password,
    }),
    redirect: "manual",
  });
  const redirect = new URL(authorizationResponse.headers.get("location"));
  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: redirect.searchParams.get("code"),
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: "http://127.0.0.1/mcp",
    }),
  });
  return { client, tokens: await tokenResponse.json() };
}

export async function callMcp(baseUrl, accessToken, method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const text = await response.text();
  const payload = text.startsWith("event:")
    ? JSON.parse(text.split("\ndata: ")[1].split("\n")[0])
    : JSON.parse(text);
  return { response, payload };
}
