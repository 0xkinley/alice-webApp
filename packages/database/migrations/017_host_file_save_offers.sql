CREATE TABLE host_file_save_offers (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_workspace_id text NOT NULL,
  connection_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  target_selection_version text NOT NULL,
  display_name text NOT NULL,
  declared_media_type text,
  declared_byte_size integer,
  declared_sha256 text,
  source_host text NOT NULL,
  conversation_reference text,
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  FOREIGN KEY (connection_workspace_id, user_id, connection_id)
    REFERENCES integration_connections(workspace_id, user_id, id),
  CHECK (char_length(target_selection_version) BETWEEN 1 AND 200),
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  CHECK (char_length(request_hash) = 64),
  CHECK (char_length(display_name) BETWEEN 1 AND 180),
  CHECK (declared_media_type IS NULL OR declared_media_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'text/plain', 'text/markdown'
  )),
  CHECK (declared_byte_size IS NULL OR declared_byte_size BETWEEN 1 AND 26214400),
  CHECK (declared_sha256 IS NULL OR declared_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(source_host) BETWEEN 1 AND 80),
  CHECK (conversation_reference IS NULL OR char_length(conversation_reference) BETWEEN 1 AND 200),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_id, context_id, id),
  UNIQUE (workspace_id, project_id, context_id, id, user_id),
  UNIQUE (connection_workspace_id, connection_id, idempotency_key)
);

CREATE TABLE host_file_save_decisions (
  offer_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  decided_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN (
    'save_file_only', 'save_and_suggest_context', 'cancelled'
  )),
  decision_version text NOT NULL,
  decided_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id, offer_id, decided_by_user_id)
    REFERENCES host_file_save_offers(workspace_id, project_id, context_id, id, user_id),
  CHECK (char_length(decision_version) = 64)
);

CREATE INDEX host_file_save_offers_user_expiry
  ON host_file_save_offers (user_id, workspace_id, expires_at, id);

CREATE TRIGGER host_file_save_offers_no_update
BEFORE UPDATE ON host_file_save_offers
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_offers_no_delete
BEFORE DELETE ON host_file_save_offers
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_decisions_no_update
BEFORE UPDATE ON host_file_save_decisions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_decisions_no_delete
BEFORE DELETE ON host_file_save_decisions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
