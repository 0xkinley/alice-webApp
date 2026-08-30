CREATE TABLE context_entry_exclusions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  accepted_state_id text NOT NULL UNIQUE,
  reason text NOT NULL,
  removed_by_user_id text NOT NULL,
  removed_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id, accepted_state_id)
    REFERENCES accepted_context_entries(workspace_id, project_id, context_id, accepted_state_id),
  FOREIGN KEY (workspace_id, removed_by_user_id)
    REFERENCES workspaces(id, user_id),
  CHECK (char_length(reason) <= 500)
);

CREATE INDEX context_entry_exclusions_lookup
  ON context_entry_exclusions (workspace_id, project_id, context_id, removed_at, id);

CREATE TRIGGER context_entry_exclusions_no_update
BEFORE UPDATE ON context_entry_exclusions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER context_entry_exclusions_no_delete
BEFORE DELETE ON context_entry_exclusions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
