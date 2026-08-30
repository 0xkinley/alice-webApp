ALTER TABLE file_context_references
  ADD CONSTRAINT file_context_references_evidence_source_unique
  UNIQUE (workspace_id, project_id, context_id, id, file_object_id);

CREATE TABLE evidence_file_sources (
  evidence_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_context_id text NOT NULL,
  file_reference_id text NOT NULL,
  file_object_id text NOT NULL,
  logical_file_id text NOT NULL,
  file_version integer NOT NULL,
  content_sha256 text NOT NULL,
  extraction_version text NOT NULL,
  extraction_start_character integer NOT NULL,
  extraction_end_character integer NOT NULL,
  excerpt_sha256 text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, evidence_id)
    REFERENCES evidence_events(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, source_context_id, file_reference_id, file_object_id)
    REFERENCES file_context_references(workspace_id, project_id, context_id, id, file_object_id),
  CHECK (file_version > 0),
  CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (extraction_version = 'pdfjs_embedded_text_v1'),
  CHECK (extraction_start_character >= 0),
  CHECK (extraction_end_character > extraction_start_character),
  CHECK (extraction_end_character - extraction_start_character <= 12000),
  CHECK (excerpt_sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE (workspace_id, project_id, evidence_id)
);

CREATE INDEX evidence_file_sources_reference_lookup
  ON evidence_file_sources (workspace_id, project_id, file_reference_id, created_at, evidence_id);

CREATE TRIGGER evidence_file_sources_no_update
BEFORE UPDATE ON evidence_file_sources
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER evidence_file_sources_no_delete
BEFORE DELETE ON evidence_file_sources
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
