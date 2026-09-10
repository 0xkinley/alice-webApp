CREATE TABLE project_default_contexts (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id),
  UNIQUE (context_id)
);

INSERT INTO work_contexts
  (id, workspace_id, project_id, name, description, context_kind, visibility,
   created_by_user_id, created_at, updated_at)
SELECT 'context_default_' || md5(project.id), project.workspace_id, project.id,
       '__alice_project_default_' || md5(project.id),
       'Internal project default.', 'work', 'all_members', owner.user_id,
       project.created_at, project.updated_at
FROM projects project
JOIN LATERAL (
  SELECT membership.user_id
  FROM project_memberships membership
  WHERE membership.workspace_id = project.workspace_id
    AND membership.project_id = project.id
    AND membership.role = 'owner'
    AND membership.ended_at IS NULL
  ORDER BY membership.created_at, membership.id
  LIMIT 1
) owner ON true;

INSERT INTO project_default_contexts
  (workspace_id, project_id, context_id, created_at)
SELECT context.workspace_id, context.project_id, context.id, context.created_at
FROM work_contexts context
WHERE context.id = 'context_default_' || md5(context.project_id);

CREATE FUNCTION alice_reject_project_default_context_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project default context mapping is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER project_default_contexts_no_update
BEFORE UPDATE ON project_default_contexts
FOR EACH ROW EXECUTE FUNCTION alice_reject_project_default_context_update();

CREATE TRIGGER project_default_contexts_no_delete
BEFORE DELETE ON project_default_contexts
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE INDEX project_default_contexts_lookup
  ON project_default_contexts (workspace_id, project_id, context_id);
