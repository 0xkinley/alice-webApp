CREATE TABLE capture_save_previews (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_workspace_id text NOT NULL,
  connection_id text NOT NULL,
  client_id text NOT NULL,
  client_classification text NOT NULL CHECK (client_classification IN ('chatgpt', 'claude')),
  exact_payload_json text NOT NULL,
  payload_hash text NOT NULL CHECK (char_length(payload_hash) = 64),
  replacement_snapshot_json text NOT NULL,
  exact_preview_json text NOT NULL,
  preview_version text NOT NULL CHECK (char_length(preview_version) = 64),
  authority_token_hash text NOT NULL CHECK (char_length(authority_token_hash) = 64),
  target_selection_version text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  FOREIGN KEY (connection_workspace_id, user_id, connection_id)
    REFERENCES integration_connections(workspace_id, user_id, id),
  CHECK (char_length(exact_payload_json) BETWEEN 2 AND 65536),
  CHECK (char_length(replacement_snapshot_json) BETWEEN 2 AND 65536),
  CHECK (char_length(exact_preview_json) BETWEEN 2 AND 131072),
  CHECK (char_length(target_selection_version) BETWEEN 1 AND 200),
  UNIQUE (workspace_id, project_id, context_id, id)
);

CREATE INDEX capture_save_previews_expiry
  ON capture_save_previews (expires_at, id);

CREATE INDEX capture_save_previews_user_lookup
  ON capture_save_previews (user_id, id, expires_at);

CREATE TRIGGER capture_save_previews_no_update
BEFORE UPDATE ON capture_save_previews
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TABLE host_file_save_offer_authorities (
  id text PRIMARY KEY,
  offer_id text NOT NULL REFERENCES host_file_save_offers(id),
  token_hash text NOT NULL CHECK (char_length(token_hash) = 64),
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL,
  UNIQUE (offer_id, token_hash)
);

CREATE INDEX host_file_save_offer_authorities_expiry
  ON host_file_save_offer_authorities (expires_at, id);

CREATE TRIGGER host_file_save_offer_authorities_no_update
BEFORE UPDATE ON host_file_save_offer_authorities
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

-- Undecided offers are now short-lived preview state rather than append-only
-- project history. A decided offer remains protected by its decision foreign key.
DROP TRIGGER host_file_save_offers_no_delete ON host_file_save_offers;
