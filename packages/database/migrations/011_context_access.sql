ALTER TABLE project_memberships
  ADD CONSTRAINT project_memberships_project_user_id_unique
  UNIQUE (workspace_id, project_id, user_id, id);

CREATE TABLE context_access_grants (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  membership_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  granted_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, user_id, membership_id)
    REFERENCES project_memberships(workspace_id, project_id, user_id, id),
  CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL)),
  UNIQUE (workspace_id, project_id, context_id, id)
);

CREATE UNIQUE INDEX context_access_grants_active_user
  ON context_access_grants (context_id, user_id)
  WHERE ended_at IS NULL;

CREATE INDEX context_access_grants_user_lookup
  ON context_access_grants (user_id, ended_at, project_id, context_id, role);

CREATE INDEX context_access_grants_context_lookup
  ON context_access_grants (workspace_id, project_id, context_id, ended_at, role, user_id);

CREATE FUNCTION alice_validate_context_access_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  context_visibility text;
  membership_role text;
  membership_ended_at timestamptz;
BEGIN
  SELECT visibility INTO context_visibility
  FROM work_contexts
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND id = NEW.context_id;

  SELECT role, ended_at INTO membership_role, membership_ended_at
  FROM project_memberships
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND user_id = NEW.user_id
    AND id = NEW.membership_id;

  IF context_visibility IS DISTINCT FROM 'selected_members'
    OR membership_ended_at IS NOT NULL
    OR (membership_role = 'viewer' AND NEW.role <> 'viewer')
  THEN
    RAISE EXCEPTION 'context grants require an active bounded project membership and selected context'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.context_id IS DISTINCT FROM OLD.context_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.ended_at IS NOT NULL
    OR (NEW.ended_at IS NULL AND NEW.ended_by_user_id IS NOT NULL)
    OR (NEW.ended_at IS NOT NULL AND NEW.ended_by_user_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'context grant identity and ended history are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER context_access_grants_validate_insert
BEFORE INSERT ON context_access_grants
FOR EACH ROW EXECUTE FUNCTION alice_validate_context_access_grant();

CREATE TRIGGER context_access_grants_validate_update
BEFORE UPDATE ON context_access_grants
FOR EACH ROW EXECUTE FUNCTION alice_validate_context_access_grant();

CREATE TRIGGER context_access_grants_no_delete
BEFORE DELETE ON context_access_grants
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE OR REPLACE FUNCTION alice_validate_project_membership_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.ended_at IS NOT NULL
    OR (NEW.ended_at IS NULL AND NEW.ended_by_user_id IS NOT NULL)
    OR (NEW.ended_at IS NOT NULL AND NEW.ended_by_user_id IS NULL)
  THEN
    RAISE EXCEPTION 'project membership identity and ended history are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.ended_at IS NULL AND OLD.role = 'owner'
    AND (NEW.role <> 'owner' OR NEW.ended_at IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM project_memberships membership
      WHERE membership.project_id = OLD.project_id
        AND membership.id <> OLD.id
        AND membership.role = 'owner'
        AND membership.ended_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'a project must retain an active owner'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.ended_at IS NULL
    AND (NEW.ended_at IS NOT NULL OR NEW.role = 'viewer')
    AND EXISTS (
      SELECT 1 FROM context_access_grants context_grant
      WHERE context_grant.membership_id = OLD.id
        AND context_grant.ended_at IS NULL
        AND (NEW.ended_at IS NOT NULL OR context_grant.role <> 'viewer')
    )
  THEN
    RAISE EXCEPTION 'end or reduce context grants before changing project membership'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM work_contexts context
      WHERE context.workspace_id = OLD.workspace_id
        AND context.project_id = OLD.project_id
        AND context.created_by_user_id = OLD.user_id
        AND context.visibility = 'personal'
        AND context.archived_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'personal contexts require disposition before membership ends'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM work_contexts context
      WHERE context.workspace_id = OLD.workspace_id
        AND context.project_id = OLD.project_id
        AND context.created_by_user_id = OLD.user_id
        AND context.visibility = 'selected_members'
        AND context.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM context_access_grants context_grant
          JOIN project_memberships membership
            ON membership.workspace_id = context_grant.workspace_id
           AND membership.project_id = context_grant.project_id
           AND membership.id = context_grant.membership_id
           AND membership.user_id = context_grant.user_id
          WHERE context_grant.workspace_id = context.workspace_id
            AND context_grant.project_id = context.project_id
            AND context_grant.context_id = context.id
            AND context_grant.user_id <> OLD.user_id
            AND context_grant.role = 'manager'
            AND context_grant.ended_at IS NULL
            AND membership.ended_at IS NULL
        )
    )
  THEN
    RAISE EXCEPTION 'selected contexts require another manager before membership ends'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE evidence_events
  ADD COLUMN connection_workspace_id text;

ALTER TABLE evidence_events DISABLE TRIGGER evidence_events_no_update;

UPDATE evidence_events evidence
SET connection_workspace_id = connection.workspace_id
FROM integration_connections connection
WHERE connection.id = evidence.connection_id;

ALTER TABLE evidence_events ENABLE TRIGGER evidence_events_no_update;

ALTER TABLE evidence_events
  ALTER COLUMN connection_workspace_id SET NOT NULL,
  DROP CONSTRAINT evidence_events_workspace_id_connection_id_fkey,
  ADD CONSTRAINT evidence_events_connection_workspace_connection_fkey
    FOREIGN KEY (connection_workspace_id, connection_id)
    REFERENCES integration_connections(workspace_id, id);

CREATE INDEX evidence_connection_workspace_lookup
  ON evidence_events (connection_workspace_id, connection_id, created_at, id);

ALTER TABLE active_connection_targets
  ADD COLUMN project_workspace_id text;

UPDATE active_connection_targets SET project_workspace_id = workspace_id;

ALTER TABLE active_connection_targets
  ALTER COLUMN project_workspace_id SET NOT NULL,
  DROP CONSTRAINT active_connection_targets_workspace_id_project_id_context__fkey,
  ADD CONSTRAINT active_connection_targets_project_context_fkey
    FOREIGN KEY (project_workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id);

CREATE INDEX active_connection_targets_project_lookup
  ON active_connection_targets (project_workspace_id, project_id, context_id, user_id);

ALTER TABLE context_entry_exclusions
  DROP CONSTRAINT context_entry_exclusions_workspace_id_removed_by_user_id_fkey,
  ADD CONSTRAINT context_entry_exclusions_removed_by_user_id_fkey
    FOREIGN KEY (removed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE file_context_references
  DROP CONSTRAINT file_context_references_workspace_id_uploader_user_id_fkey,
  ADD CONSTRAINT file_context_references_uploader_user_id_fkey
    FOREIGN KEY (uploader_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE file_reference_exclusions
  DROP CONSTRAINT file_reference_exclusions_workspace_id_removed_by_user_id_fkey,
  ADD CONSTRAINT file_reference_exclusions_removed_by_user_id_fkey
    FOREIGN KEY (removed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
