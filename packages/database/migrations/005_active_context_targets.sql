ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_workspace_user_id_unique
  UNIQUE (workspace_id, user_id, id);

CREATE TABLE active_connection_targets (
  connection_id text PRIMARY KEY,
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  surface text NOT NULL,
  selection_version text NOT NULL,
  selected_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, user_id, connection_id)
    REFERENCES integration_connections(workspace_id, user_id, id),
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id)
);

CREATE INDEX active_connection_targets_user_lookup
  ON active_connection_targets (user_id, workspace_id, updated_at, connection_id);
