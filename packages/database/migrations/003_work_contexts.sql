CREATE TABLE work_contexts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  context_kind text NOT NULL CHECK (context_kind IN ('project_wide', 'work')),
  visibility text NOT NULL CHECK (visibility IN ('all_members', 'selected_members', 'personal')),
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  UNIQUE (workspace_id, project_id, id)
);

CREATE UNIQUE INDEX work_contexts_name_unique
  ON work_contexts (project_id, lower(name));
CREATE UNIQUE INDEX work_contexts_one_project_wide
  ON work_contexts (project_id) WHERE context_kind = 'project_wide';
CREATE INDEX work_contexts_project_visibility_lookup
  ON work_contexts (workspace_id, project_id, visibility, archived_at, name, id);

INSERT INTO work_contexts
  (id, workspace_id, project_id, name, description, context_kind, visibility,
   created_by_user_id, created_at, updated_at)
SELECT 'context_project_' || md5(project.id), project.workspace_id, project.id,
       'Project-wide', 'Active context shared across every work context in this project.',
       'project_wide', 'all_members', workspace.user_id, project.created_at, project.updated_at
FROM projects project
JOIN workspaces workspace ON workspace.id = project.workspace_id;

INSERT INTO work_contexts
  (id, workspace_id, project_id, name, description, context_kind, visibility,
   created_by_user_id, created_at, updated_at)
SELECT 'context_general_' || md5(project.id), project.workspace_id, project.id,
       'General', 'Default work context for uncategorized project work.',
       'work', 'all_members', workspace.user_id, project.created_at, project.updated_at
FROM projects project
JOIN workspaces workspace ON workspace.id = project.workspace_id;

CREATE TABLE context_history_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  action text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  safe_metadata_json text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id)
);

CREATE INDEX context_history_lookup
  ON context_history_events (workspace_id, project_id, context_id, created_at, id);

INSERT INTO context_history_events
  (id, workspace_id, project_id, context_id, action, actor_user_id,
   safe_metadata_json, created_at)
SELECT 'context_event_' || md5(context.id), context.workspace_id, context.project_id,
       context.id, 'context_created', context.created_by_user_id,
       json_build_object('context_id', context.id, 'context_kind', context.context_kind)::text,
       context.created_at
FROM work_contexts context;

CREATE TRIGGER context_history_events_no_update
BEFORE UPDATE ON context_history_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER context_history_events_no_delete
BEFORE DELETE ON context_history_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
