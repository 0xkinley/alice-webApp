CREATE TABLE artifact_lifecycle_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  artifact_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'superseded', 'archived')),
  replacement_artifact_id text,
  changed_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, artifact_id)
    REFERENCES artifacts(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, replacement_artifact_id)
    REFERENCES artifacts(workspace_id, project_id, id),
  CHECK ((lifecycle_state = 'superseded') = (replacement_artifact_id IS NOT NULL)),
  CHECK (replacement_artifact_id IS NULL OR replacement_artifact_id <> artifact_id),
  UNIQUE (workspace_id, project_id, artifact_id, version),
  UNIQUE (workspace_id, project_id, id)
);

ALTER TABLE artifact_read_receipts
  ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0);
ALTER TABLE artifact_read_receipts ALTER COLUMN lifecycle_version DROP DEFAULT;

CREATE INDEX artifact_lifecycle_current
  ON artifact_lifecycle_events (workspace_id, project_id, artifact_id, version DESC);

CREATE TRIGGER artifact_lifecycle_events_no_update
BEFORE UPDATE ON artifact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER artifact_lifecycle_events_no_delete
BEFORE DELETE ON artifact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
