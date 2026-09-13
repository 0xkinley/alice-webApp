CREATE TABLE file_upload_intents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  initiated_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  claimed_media_type text NOT NULL,
  declared_byte_size integer NOT NULL,
  declared_sha256 text NOT NULL,
  staging_storage_key text NOT NULL UNIQUE,
  replaces_reference_id text,
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, context_id, replaces_reference_id)
    REFERENCES file_context_references(workspace_id, project_id, context_id, id),
  CHECK (char_length(display_name) BETWEEN 1 AND 180),
  CHECK (claimed_media_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'text/plain', 'text/markdown'
  )),
  CHECK (declared_byte_size BETWEEN 1 AND 26214400),
  CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(staging_storage_key) BETWEEN 1 AND 512),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_id, context_id, id)
);

CREATE TABLE file_upload_completions (
  intent_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  staging_storage_version_id text NOT NULL,
  file_reference_id text NOT NULL UNIQUE,
  completed_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id, intent_id)
    REFERENCES file_upload_intents(workspace_id, project_id, context_id, id),
  FOREIGN KEY (workspace_id, project_id, context_id, file_reference_id)
    REFERENCES file_context_references(workspace_id, project_id, context_id, id),
  CHECK (char_length(staging_storage_version_id) BETWEEN 1 AND 1024)
);

CREATE INDEX file_upload_intents_expiry
  ON file_upload_intents (workspace_id, initiated_by_user_id, expires_at, id);

CREATE TRIGGER file_upload_intents_no_update
BEFORE UPDATE ON file_upload_intents
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER file_upload_intents_no_delete
BEFORE DELETE ON file_upload_intents
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER file_upload_completions_no_update
BEFORE UPDATE ON file_upload_completions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER file_upload_completions_no_delete
BEFORE DELETE ON file_upload_completions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
