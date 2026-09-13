ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_workspace_user_id_client_unique
  UNIQUE (workspace_id, user_id, id, client_id);

CREATE TABLE context_read_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_workspace_id text NOT NULL,
  connection_id text NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
  client_name text NOT NULL,
  client_classification text NOT NULL,
  requested_via text NOT NULL CHECK (requested_via IN ('active_target', 'explicit_fallback')),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  failure_code text CHECK (
    failure_code IN ('no_active_target', 'not_accessible', 'budget_error', 'internal_error')
  ),
  project_workspace_id text,
  project_id text,
  context_id text,
  package_version text,
  package_utf8_bytes integer CHECK (package_utf8_bytes > 0),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (connection_workspace_id, user_id, connection_id, client_id)
    REFERENCES integration_connections(workspace_id, user_id, id, client_id),
  FOREIGN KEY (project_workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  CHECK (
    (status = 'succeeded'
      AND failure_code IS NULL
      AND project_workspace_id IS NOT NULL
      AND project_id IS NOT NULL
      AND context_id IS NOT NULL
      AND package_version IS NOT NULL
      AND package_utf8_bytes IS NOT NULL)
    OR
    (status = 'failed'
      AND failure_code IS NOT NULL
      AND package_version IS NULL
      AND package_utf8_bytes IS NULL
      AND ((project_workspace_id IS NULL AND project_id IS NULL AND context_id IS NULL)
        OR (project_workspace_id IS NOT NULL AND project_id IS NOT NULL AND context_id IS NOT NULL)))
  )
);

CREATE INDEX context_read_events_user_lookup
  ON context_read_events (user_id, created_at DESC, id DESC);

CREATE INDEX context_read_events_project_lookup
  ON context_read_events (
    user_id, project_workspace_id, project_id, context_id, created_at DESC, id DESC
  );

CREATE TRIGGER context_read_events_no_update
BEFORE UPDATE ON context_read_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER context_read_events_no_delete
BEFORE DELETE ON context_read_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
