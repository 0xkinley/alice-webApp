CREATE TABLE project_erasure_jobs (
  id text PRIMARY KEY,
  project_id text,
  project_fingerprint text NOT NULL,
  deletion_request_fingerprint text NOT NULL,
  preview_version text NOT NULL,
  object_manifest_sha256 text NOT NULL,
  object_key_count integer NOT NULL,
  object_version_count integer NOT NULL,
  shared_object_count integer NOT NULL,
  database_row_count integer NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  active_data_deleted_at timestamptz,
  provider_backup_expires_at timestamptz,
  CHECK (project_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (deletion_request_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (preview_version ~ '^project_erasure_preview_[0-9a-f]{64}$'),
  CHECK (object_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (object_key_count BETWEEN 0 AND 10000),
  CHECK (object_version_count BETWEEN 0 AND 50000),
  CHECK (shared_object_count BETWEEN 0 AND 10000),
  CHECK (database_row_count >= 0),
  CHECK (status IN ('prepared', 'completed')),
  CHECK (
    (status = 'prepared' AND project_id IS NOT NULL
      AND completed_at IS NULL AND active_data_deleted_at IS NULL
      AND provider_backup_expires_at IS NULL)
    OR
    (status = 'completed' AND project_id IS NULL
      AND completed_at IS NOT NULL AND active_data_deleted_at IS NOT NULL
      AND provider_backup_expires_at IS NOT NULL)
  ),
  UNIQUE (project_fingerprint, deletion_request_fingerprint)
);

CREATE INDEX project_erasure_jobs_status_lookup
  ON project_erasure_jobs (status, started_at, id);

CREATE FUNCTION alice_validate_project_erasure_job_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'prepared'
    OR NEW.status <> 'completed'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_fingerprint IS DISTINCT FROM OLD.project_fingerprint
    OR NEW.deletion_request_fingerprint IS DISTINCT FROM OLD.deletion_request_fingerprint
    OR NEW.preview_version IS DISTINCT FROM OLD.preview_version
    OR NEW.object_manifest_sha256 IS DISTINCT FROM OLD.object_manifest_sha256
    OR NEW.object_key_count IS DISTINCT FROM OLD.object_key_count
    OR NEW.object_version_count IS DISTINCT FROM OLD.object_version_count
    OR NEW.shared_object_count IS DISTINCT FROM OLD.shared_object_count
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.project_id IS NOT NULL
    OR NEW.completed_at IS NULL
    OR NEW.active_data_deleted_at IS NULL
    OR NEW.provider_backup_expires_at IS NULL
    OR NEW.database_row_count < OLD.database_row_count
  THEN
    RAISE EXCEPTION 'project erasure jobs permit only one terminal completion transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_erasure_jobs_validate_update
BEFORE UPDATE ON project_erasure_jobs
FOR EACH ROW EXECUTE FUNCTION alice_validate_project_erasure_job_update();

CREATE TRIGGER project_erasure_jobs_no_delete
BEFORE DELETE ON project_erasure_jobs
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE FUNCTION alice_reject_deletion_cancellation_after_erasure_started() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM project_erasure_jobs
    WHERE project_id = OLD.project_id AND status = 'prepared'
  ) THEN
    RAISE EXCEPTION 'project erasure has started; cancellation is no longer safe'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION alice_reject_deletion_cancellation_after_erasure_started() FROM PUBLIC;

CREATE TRIGGER project_deletion_requests_erasure_started
BEFORE UPDATE ON project_deletion_requests
FOR EACH ROW
WHEN (OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL)
EXECUTE FUNCTION alice_reject_deletion_cancellation_after_erasure_started();
