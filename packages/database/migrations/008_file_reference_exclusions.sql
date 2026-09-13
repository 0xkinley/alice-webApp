ALTER TABLE file_context_references
  ADD CONSTRAINT file_context_references_scope_unique
  UNIQUE (workspace_id, project_id, context_id, id);

CREATE TABLE file_reference_exclusions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  file_reference_id text NOT NULL UNIQUE,
  reason text NOT NULL,
  removed_by_user_id text NOT NULL,
  removed_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id, file_reference_id)
    REFERENCES file_context_references(workspace_id, project_id, context_id, id),
  FOREIGN KEY (workspace_id, removed_by_user_id)
    REFERENCES workspaces(id, user_id),
  CHECK (char_length(reason) <= 500)
);

CREATE INDEX file_reference_exclusions_lookup
  ON file_reference_exclusions (workspace_id, project_id, context_id, removed_at, id);

CREATE TRIGGER file_reference_exclusions_no_update
BEFORE UPDATE ON file_reference_exclusions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER file_reference_exclusions_no_delete
BEFORE DELETE ON file_reference_exclusions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
