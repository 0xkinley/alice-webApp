ALTER TABLE projects
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT projects_archive_pair
    CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL));

CREATE INDEX projects_archive_lookup
  ON projects (workspace_id, archived_at, updated_at DESC, id);

CREATE TABLE project_deletion_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  requested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL,
  not_before timestamptz NOT NULL,
  cancelled_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK (not_before > requested_at),
  CHECK ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)),
  UNIQUE (workspace_id, project_id, id)
);

CREATE UNIQUE INDEX project_deletion_requests_active_project
  ON project_deletion_requests (project_id)
  WHERE cancelled_at IS NULL;

CREATE INDEX project_deletion_requests_operator_queue
  ON project_deletion_requests (not_before, requested_at, id)
  WHERE cancelled_at IS NULL;

CREATE FUNCTION alice_validate_project_lifecycle_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR ((NEW.archived_at IS NULL) IS DISTINCT FROM (NEW.archived_by_user_id IS NULL))
  THEN
    RAISE EXCEPTION 'project identity is immutable; archive is a separate lifecycle'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_lifecycle_only_update
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION alice_validate_project_lifecycle_update();

CREATE TRIGGER projects_no_delete
BEFORE DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE FUNCTION alice_validate_project_deletion_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM projects project
      WHERE project.workspace_id = NEW.workspace_id
        AND project.id = NEW.project_id
        AND project.archived_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'a project must be archived before deletion is requested'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.not_before IS DISTINCT FROM OLD.not_before
    OR OLD.cancelled_at IS NOT NULL
    OR NEW.cancelled_at IS NULL
    OR NEW.cancelled_by_user_id IS NULL
  THEN
    RAISE EXCEPTION 'deletion requests preserve identity and terminal cancellation history'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_deletion_requests_validate_insert
BEFORE INSERT ON project_deletion_requests
FOR EACH ROW EXECUTE FUNCTION alice_validate_project_deletion_request();

CREATE TRIGGER project_deletion_requests_validate_update
BEFORE UPDATE ON project_deletion_requests
FOR EACH ROW EXECUTE FUNCTION alice_validate_project_deletion_request();

CREATE TRIGGER project_deletion_requests_no_delete
BEFORE DELETE ON project_deletion_requests
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
