ALTER TABLE file_context_references
  ADD COLUMN logical_file_id text,
  ADD COLUMN version integer;

ALTER TABLE file_context_references DISABLE TRIGGER file_context_references_no_update;

UPDATE file_context_references
SET logical_file_id = id, version = 1;

ALTER TABLE file_context_references ENABLE TRIGGER file_context_references_no_update;

ALTER TABLE file_context_references
  ALTER COLUMN logical_file_id SET NOT NULL,
  ALTER COLUMN version SET NOT NULL,
  ADD CONSTRAINT file_context_references_version_positive CHECK (version > 0),
  ADD CONSTRAINT file_context_references_version_unique
    UNIQUE (workspace_id, project_id, context_id, logical_file_id, version);

CREATE INDEX file_context_references_versions
  ON file_context_references (
    workspace_id, project_id, context_id, logical_file_id, version DESC, id
  );
