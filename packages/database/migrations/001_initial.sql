CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX users_email_normalized_unique ON users (lower(email));

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (id, user_id)
);

CREATE TABLE web_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE oauth_clients (
  client_id text PRIMARY KEY,
  client_secret_hash text,
  client_name text NOT NULL,
  redirect_uris_json text NOT NULL,
  token_endpoint_auth_method text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE integration_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
  client_classification text NOT NULL,
  granted_scopes text NOT NULL,
  first_connected_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspaces(id, user_id),
  UNIQUE (workspace_id, id)
);

CREATE TABLE oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id),
  user_id text NOT NULL REFERENCES users(id),
  connection_id text NOT NULL REFERENCES integration_connections(id),
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  resource text NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE oauth_access_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id),
  user_id text NOT NULL REFERENCES users(id),
  connection_id text NOT NULL REFERENCES integration_connections(id),
  scope text NOT NULL,
  resource text NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id),
  user_id text NOT NULL REFERENCES users(id),
  connection_id text NOT NULL REFERENCES integration_connections(id),
  scope text NOT NULL,
  resource text NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL,
  brief text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE evidence_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  exact_payload_json text NOT NULL,
  actor_type text NOT NULL,
  connection_id text NOT NULL,
  client_id text NOT NULL,
  client_classification text NOT NULL,
  tool_name text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integration_connections(workspace_id, id),
  UNIQUE (connection_id, project_id, idempotency_key),
  UNIQUE (workspace_id, project_id, id)
);

CREATE TABLE candidate_claims (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  evidence_id text NOT NULL,
  state_key text NOT NULL,
  value_json text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, evidence_id)
    REFERENCES evidence_events(workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, id, evidence_id)
);

CREATE TABLE accepted_project_state (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL UNIQUE,
  evidence_id text NOT NULL,
  state_key text NOT NULL,
  value_json text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  accepted_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, candidate_id)
    REFERENCES candidate_claims(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, candidate_id, evidence_id)
    REFERENCES candidate_claims(workspace_id, project_id, id, evidence_id),
  FOREIGN KEY (workspace_id, project_id, evidence_id)
    REFERENCES evidence_events(workspace_id, project_id, id),
  UNIQUE (project_id, state_key, version)
);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text,
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  safe_metadata_json text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE FUNCTION alice_reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER evidence_events_no_update
BEFORE UPDATE ON evidence_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER evidence_events_no_delete
BEFORE DELETE ON evidence_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE FUNCTION alice_candidate_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending'
    OR NEW.status NOT IN ('accepted', 'rejected')
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
    OR NEW.state_key IS DISTINCT FROM OLD.state_key
    OR NEW.value_json IS DISTINCT FROM OLD.value_json
    OR NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'candidate claims preserve submitted content and terminal status'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER candidate_claims_status_only_update
BEFORE UPDATE ON candidate_claims
FOR EACH ROW EXECUTE FUNCTION alice_candidate_status_transition();

CREATE TRIGGER candidate_claims_no_delete
BEFORE DELETE ON candidate_claims
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER accepted_project_state_no_update
BEFORE UPDATE ON accepted_project_state
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER accepted_project_state_no_delete
BEFORE DELETE ON accepted_project_state
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE INDEX projects_workspace_lookup ON projects (workspace_id, id);
CREATE INDEX candidates_project_status_lookup
  ON candidate_claims (workspace_id, project_id, status, created_at, id);
CREATE INDEX accepted_project_state_current_lookup
  ON accepted_project_state (workspace_id, project_id, state_key, version DESC);
CREATE INDEX evidence_capture_lookup
  ON evidence_events (workspace_id, connection_id, project_id, idempotency_key);
CREATE INDEX audit_project_action_lookup
  ON audit_events (workspace_id, project_id, action, created_at, id);
