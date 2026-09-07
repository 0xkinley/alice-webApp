import { randomUUID } from "node:crypto";
import { createProjectSchema } from "@alice/schemas";
import { appendAuditEvent } from "./audit.ts";
import { projectScopeForUser, tenantScopeForUser } from "./authorization.ts";
import { provisionInitialWorkContexts } from "./work-contexts.ts";

export async function createProject(
  database,
  userId,
  input,
  {
    providerAvailability = { chatgpt: false, claude: false },
    initialWorkContextVisibility = "all_members",
  } = {},
) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const project = createProjectSchema.parse(input);
  const projectId = `project_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  try {
    await database.transaction(async () => {
      await database
        .prepare(
          `INSERT INTO projects (id, workspace_id, name, brief, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, tenant.workspaceId, project.name, project.brief, createdAt, createdAt);
      await provisionInitialWorkContexts(database, {
        userId,
        workspaceId: tenant.workspaceId,
        projectId,
        createdAt,
        providerAvailability,
        initialWorkContextVisibility,
      });
      await appendAuditEvent(database, {
        workspaceId: tenant.workspaceId,
        projectId,
        action: "project_created",
        actorType: "human_user",
        actorId: userId,
        correlationId: `project_${randomUUID()}`,
        metadata: { project_id: projectId },
      });
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      throw new Error("A project with this name already exists in your workspace.", {
        cause: error,
      });
    }
    throw error;
  }
  return {
    id: projectId,
    workspace_id: tenant.workspaceId,
    name: project.name,
    brief: project.brief,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export async function getProject(database, userId, projectId) {
  const scope = await projectScopeForUser(database, { userId, projectId });
  if (!scope) return undefined;
  return await database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at, ? AS project_role
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(scope.projectRole, projectId, scope.projectWorkspaceId);
}
