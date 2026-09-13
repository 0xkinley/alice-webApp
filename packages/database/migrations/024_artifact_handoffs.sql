CREATE TABLE artifacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  UNIQUE (workspace_id, project_id, id)
);

CREATE TABLE artifact_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  artifact_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  parent_version_id text,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  artifact_type text NOT NULL CHECK (artifact_type IN (
    'article', 'report', 'proposal', 'research', 'strategy', 'specification',
    'plan', 'document', 'analysis', 'presentation', 'email_draft',
    'marketing_copy', 'code', 'other'
  )),
  category text NOT NULL CHECK (category IN (
    'founder', 'product', 'engineering', 'marketing', 'sales', 'customer',
    'team', 'operations', 'finance', 'legal', 'research', 'strategy',
    'fundraising', 'partnerships', 'hiring', 'content', 'design', 'support',
    'personal', 'other'
  )),
  tags_json text NOT NULL CHECK (char_length(tags_json) BETWEEN 2 AND 4096),
  content_storage_kind text NOT NULL CHECK (content_storage_kind IN ('inline_text', 'object')),
  content_text text,
  storage_key text,
  storage_version_id text,
  media_type text NOT NULL,
  content_sha256 text NOT NULL CHECK (char_length(content_sha256) = 64),
  content_utf8_bytes integer NOT NULL CHECK (content_utf8_bytes BETWEEN 1 AND 2097152),
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 2000),
  summary text CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 2000),
  decisions_json text NOT NULL CHECK (char_length(decisions_json) BETWEEN 2 AND 32768),
  constraints_json text NOT NULL CHECK (char_length(constraints_json) BETWEEN 2 AND 32768),
  rejected_directions_json text NOT NULL CHECK (
    char_length(rejected_directions_json) BETWEEN 2 AND 32768
  ),
  open_questions_json text NOT NULL CHECK (char_length(open_questions_json) BETWEEN 2 AND 32768),
  next_steps_json text NOT NULL CHECK (char_length(next_steps_json) BETWEEN 2 AND 32768),
  relevant_context_json text NOT NULL CHECK (
    char_length(relevant_context_json) BETWEEN 2 AND 32768
  ),
  source_connection_workspace_id text NOT NULL,
  source_connection_id text NOT NULL,
  source_client_id text NOT NULL,
  source_provider text NOT NULL CHECK (source_provider IN ('chatgpt', 'claude')),
  saved_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  payload_sha256 text NOT NULL CHECK (char_length(payload_sha256) = 64),
  saved_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, artifact_id)
    REFERENCES artifacts(workspace_id, project_id, id),
  FOREIGN KEY (parent_version_id) REFERENCES artifact_versions(id),
  FOREIGN KEY (
    source_connection_workspace_id, saved_by_user_id, source_connection_id, source_client_id
  ) REFERENCES integration_connections(workspace_id, user_id, id, client_id),
  CHECK (
    (content_storage_kind = 'inline_text'
      AND content_text IS NOT NULL
      AND storage_key IS NULL
      AND storage_version_id IS NULL
      AND content_utf8_bytes <= 49152)
    OR
    (content_storage_kind = 'object'
      AND content_text IS NULL
      AND storage_key IS NOT NULL
      AND storage_version_id IS NOT NULL)
  ),
  UNIQUE (workspace_id, project_id, artifact_id, version),
  UNIQUE (source_connection_id, project_id, idempotency_key),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX artifact_versions_current
  ON artifact_versions (workspace_id, project_id, artifact_id, version DESC);
CREATE INDEX artifact_versions_search
  ON artifact_versions (workspace_id, project_id, saved_at DESC, id DESC);

CREATE TABLE artifact_save_previews (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_workspace_id text NOT NULL,
  connection_id text NOT NULL,
  client_id text NOT NULL,
  source_provider text NOT NULL CHECK (source_provider IN ('chatgpt', 'claude')),
  save_kind text NOT NULL CHECK (save_kind IN ('create_artifact', 'new_version')),
  artifact_id text,
  current_version integer NOT NULL CHECK (current_version >= 0),
  exact_payload_json text NOT NULL CHECK (char_length(exact_payload_json) BETWEEN 2 AND 131072),
  payload_sha256 text NOT NULL CHECK (char_length(payload_sha256) = 64),
  exact_preview_json text NOT NULL CHECK (char_length(exact_preview_json) BETWEEN 2 AND 196608),
  preview_version text NOT NULL CHECK (char_length(preview_version) = 64),
  authority_token_hash text NOT NULL CHECK (char_length(authority_token_hash) = 64),
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, artifact_id)
    REFERENCES artifacts(workspace_id, project_id, id),
  FOREIGN KEY (connection_workspace_id, user_id, connection_id, client_id)
    REFERENCES integration_connections(workspace_id, user_id, id, client_id),
  CHECK (
    (save_kind = 'create_artifact' AND artifact_id IS NULL AND current_version = 0)
    OR
    (save_kind = 'new_version' AND artifact_id IS NOT NULL AND current_version > 0)
  ),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX artifact_save_previews_expiry ON artifact_save_previews (expires_at);

CREATE TRIGGER artifacts_no_update
BEFORE UPDATE ON artifacts
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifacts_no_delete
BEFORE DELETE ON artifacts
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifact_versions_no_update
BEFORE UPDATE ON artifact_versions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifact_versions_no_delete
BEFORE DELETE ON artifact_versions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifact_save_previews_no_update
BEFORE UPDATE ON artifact_save_previews
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
