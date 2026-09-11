CREATE TABLE save_confirmation_receipts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_workspace_id text NOT NULL,
  connection_id text NOT NULL,
  client_id text NOT NULL,
  save_kind text NOT NULL CHECK (save_kind IN ('artifact', 'project_information')),
  receipt_json text NOT NULL CHECK (char_length(receipt_json) BETWEEN 2 AND 65536),
  saved_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (connection_workspace_id, user_id, connection_id, client_id)
    REFERENCES integration_connections(workspace_id, user_id, id, client_id),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX save_confirmation_receipts_checkpoint
  ON save_confirmation_receipts (connection_id, project_id, saved_at DESC, id DESC);

CREATE TRIGGER save_confirmation_receipts_no_update
BEFORE UPDATE ON save_confirmation_receipts
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER save_confirmation_receipts_no_delete
BEFORE DELETE ON save_confirmation_receipts
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
