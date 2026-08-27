import { randomUUID } from "node:crypto";
import { createProjectSchema } from "@alice/schemas";
import { appendAuditEvent } from "./audit.ts";
import { tenantScopeForUser } from "./authorization.ts";

export function createProject(database, userId, input) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  const project = createProjectSchema.parse(input);
  const projectId = `project_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, brief, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, tenant.workspaceId, project.name, project.brief, createdAt, createdAt);
    appendAuditEvent(database, {
      workspaceId: tenant.workspaceId,
      projectId,
      action: "project_created",
      actorType: "human_user",
      actorId: userId,
      correlationId: `project_${randomUUID()}`,
      metadata: { project_id: projectId },
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    if (String(error).includes("UNIQUE constraint failed: projects.workspace_id, projects.name")) {
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

export function getProject(database, userId, projectId) {
  const tenant = tenantScopeForUser(database, userId);
  if (!tenant) return undefined;
  return database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, tenant.workspaceId);
}
