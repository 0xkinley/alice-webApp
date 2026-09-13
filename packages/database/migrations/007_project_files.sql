CREATE TABLE file_objects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  content_sha256 text NOT NULL,
  byte_size integer NOT NULL,
  verified_media_type text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  storage_version_id text,
  storage_etag text,
  scan_provider text NOT NULL,
  scan_status text NOT NULL,
  scan_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (byte_size BETWEEN 1 AND 26214400),
  CHECK (verified_media_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'text/plain', 'text/markdown'
  )),
  CHECK (char_length(storage_key) BETWEEN 1 AND 512),
  CHECK (scan_provider = 'aws_guardduty_s3'),
  CHECK (scan_status IN (
    'pending_upload', 'scanning', 'clean', 'threats_found',
    'unsupported', 'scan_failed', 'storage_failed'
  )),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, content_sha256)
);

CREATE TABLE file_context_references (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  file_object_id text NOT NULL,
  display_name text NOT NULL,
  source_host text NOT NULL,
  uploader_user_id text NOT NULL,
  access_scope text NOT NULL,
  referenced_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, file_object_id)
    REFERENCES file_objects(workspace_id, id),
  FOREIGN KEY (workspace_id, uploader_user_id)
    REFERENCES workspaces(id, user_id),
  CHECK (char_length(display_name) BETWEEN 1 AND 180),
  CHECK (char_length(source_host) BETWEEN 1 AND 80),
  CHECK (access_scope = 'inherit_context'),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_id, context_id, file_object_id)
);

CREATE INDEX file_objects_scan_queue
  ON file_objects (workspace_id, scan_status, scan_updated_at, id);

CREATE INDEX file_context_references_lookup
  ON file_context_references (workspace_id, project_id, context_id, referenced_at, id);

CREATE FUNCTION alice_validate_file_object_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.verified_media_type IS DISTINCT FROM OLD.verified_media_type
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.scan_provider IS DISTINCT FROM OLD.scan_provider
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'file object content metadata is immutable';
  END IF;

  IF OLD.storage_version_id IS NOT NULL
     AND (NEW.storage_version_id IS DISTINCT FROM OLD.storage_version_id
       OR NEW.storage_etag IS DISTINCT FROM OLD.storage_etag) THEN
    RAISE EXCEPTION 'stored file object version is immutable';
  END IF;

  IF OLD.scan_status = 'pending_upload'
     AND NEW.scan_status NOT IN ('pending_upload', 'scanning', 'storage_failed') THEN
    RAISE EXCEPTION 'invalid file object lifecycle transition';
  ELSIF OLD.scan_status = 'storage_failed'
     AND NEW.scan_status NOT IN ('storage_failed', 'pending_upload') THEN
    RAISE EXCEPTION 'invalid file object lifecycle transition';
  ELSIF OLD.scan_status = 'scanning'
     AND NEW.scan_status NOT IN (
       'scanning', 'clean', 'threats_found', 'unsupported', 'scan_failed'
     ) THEN
    RAISE EXCEPTION 'invalid file object lifecycle transition';
  ELSIF OLD.scan_status IN ('clean', 'threats_found', 'unsupported', 'scan_failed')
     AND NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
    RAISE EXCEPTION 'terminal file scan status is immutable';
  END IF;

  IF NEW.scan_status <> 'pending_upload' AND NEW.scan_status <> 'storage_failed'
     AND NEW.storage_version_id IS NULL THEN
    RAISE EXCEPTION 'stored file object version is required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_objects_validate_update
BEFORE UPDATE ON file_objects
FOR EACH ROW EXECUTE FUNCTION alice_validate_file_object_update();

CREATE TRIGGER file_objects_no_delete
BEFORE DELETE ON file_objects
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER file_context_references_no_update
BEFORE UPDATE ON file_context_references
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER file_context_references_no_delete
BEFORE DELETE ON file_context_references
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
