CREATE TABLE artifact_read_receipts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_workspace_id text NOT NULL,
  connection_id text NOT NULL,
  client_id text NOT NULL,
  artifact_id text NOT NULL,
  version_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL,
  FOREIGN KEY (workspace_id, project_id, artifact_id)
    REFERENCES artifacts(workspace_id, project_id, id),
  FOREIGN KEY (version_id) REFERENCES artifact_versions(id),
  FOREIGN KEY (connection_workspace_id, user_id, connection_id, client_id)
    REFERENCES integration_connections(workspace_id, user_id, id, client_id),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX artifact_read_receipts_expiry ON artifact_read_receipts (expires_at);

CREATE TABLE artifact_read_receipt_uses (
  receipt_id text PRIMARY KEY REFERENCES artifact_read_receipts(id) ON DELETE RESTRICT,
  preview_id text NOT NULL UNIQUE,
  used_at timestamptz NOT NULL
);

CREATE TRIGGER artifact_read_receipts_no_update
BEFORE UPDATE ON artifact_read_receipts
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifact_read_receipt_uses_no_update
BEFORE UPDATE ON artifact_read_receipt_uses
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifact_read_receipt_uses_no_delete
BEFORE DELETE ON artifact_read_receipt_uses
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
