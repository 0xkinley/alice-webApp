import { randomUUID } from "node:crypto";
import { createProjectSchema } from "@alice/schemas";

function workspaceIdForUser(database, userId) {
  return database.prepare("SELECT id FROM workspaces WHERE user_id = ?").get(userId)?.id;
}

export function createProject(database, userId, input) {
  const workspaceId = workspaceIdForUser(database, userId);
  if (!workspaceId) return undefined;
  const project = createProjectSchema.parse(input);
  const projectId = `project_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  try {
    database
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, brief, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, workspaceId, project.name, project.brief, createdAt, createdAt);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: projects.workspace_id, projects.name")) {
      throw new Error("A project with this name already exists in your workspace.", {
        cause: error,
      });
    }
    throw error;
  }
  return {
    id: projectId,
    workspace_id: workspaceId,
    name: project.name,
    brief: project.brief,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function getProject(database, userId, projectId) {
  const workspaceId = workspaceIdForUser(database, userId);
  if (!workspaceId) return undefined;
  return database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, workspaceId);
}
