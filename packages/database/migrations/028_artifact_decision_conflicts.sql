ALTER TABLE artifact_versions
  ADD COLUMN decision_records_json text NOT NULL DEFAULT '[]'
  CHECK (char_length(decision_records_json) BETWEEN 2 AND 32768);

CREATE UNIQUE INDEX artifact_versions_decision_reference
  ON artifact_versions (workspace_id, project_id, artifact_id, id);

CREATE TABLE artifact_decision_resolutions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  decision_key text NOT NULL CHECK (char_length(decision_key) BETWEEN 1 AND 200),
  conflict_fingerprint text NOT NULL CHECK (char_length(conflict_fingerprint) = 64),
  selected_artifact_id text NOT NULL,
  selected_version_id text NOT NULL,
  selected_value_json text NOT NULL CHECK (char_length(selected_value_json) BETWEEN 1 AND 8192),
  resolved_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, selected_artifact_id, selected_version_id)
    REFERENCES artifact_versions(workspace_id, project_id, artifact_id, id),
  UNIQUE (workspace_id, project_id, conflict_fingerprint),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX artifact_decision_resolutions_lookup
  ON artifact_decision_resolutions (workspace_id, project_id, decision_key, resolved_at DESC);

CREATE TRIGGER artifact_decision_resolutions_no_update
BEFORE UPDATE ON artifact_decision_resolutions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifact_decision_resolutions_no_delete
BEFORE DELETE ON artifact_decision_resolutions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
