CREATE TABLE project_memberships (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL)),
  UNIQUE (workspace_id, project_id, id)
);

CREATE UNIQUE INDEX project_memberships_active_user
  ON project_memberships (project_id, user_id)
  WHERE ended_at IS NULL;

CREATE INDEX project_memberships_user_lookup
  ON project_memberships (user_id, ended_at, project_id, role);

CREATE INDEX project_memberships_project_lookup
  ON project_memberships (workspace_id, project_id, ended_at, role, user_id);

CREATE TABLE project_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL,
  accepted_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  declined_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  declined_at timestamptz,
  revoked_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
  CHECK ((declined_at IS NULL) = (declined_by_user_id IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
  CHECK (
    (CASE WHEN accepted_at IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN declined_at IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END) <= 1
  )
);

CREATE UNIQUE INDEX project_invitations_pending_email
  ON project_invitations (project_id, lower(email))
  WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;

CREATE INDEX project_invitations_project_lookup
  ON project_invitations (workspace_id, project_id, created_at DESC, id);

INSERT INTO project_memberships
  (id, workspace_id, project_id, user_id, role, created_by_user_id,
   created_at, updated_at)
SELECT 'membership_owner_' || project.id, project.workspace_id, project.id,
       workspace.user_id, 'owner', workspace.user_id, project.created_at,
       project.updated_at
FROM projects project
JOIN workspaces workspace ON workspace.id = project.workspace_id;

CREATE FUNCTION alice_create_project_owner_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_user_id text;
BEGIN
  SELECT user_id INTO owner_user_id FROM workspaces WHERE id = NEW.workspace_id;
  INSERT INTO project_memberships
    (id, workspace_id, project_id, user_id, role, created_by_user_id,
     created_at, updated_at)
  VALUES (
    'membership_owner_' || NEW.id, NEW.workspace_id, NEW.id, owner_user_id,
    'owner', owner_user_id, NEW.created_at, NEW.updated_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_create_owner_membership
AFTER INSERT ON projects
FOR EACH ROW EXECUTE FUNCTION alice_create_project_owner_membership();

CREATE FUNCTION alice_validate_project_membership_update() RETURNS trigger
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER project_memberships_validate_update
BEFORE UPDATE ON project_memberships
FOR EACH ROW EXECUTE FUNCTION alice_validate_project_membership_update();

CREATE TRIGGER project_memberships_no_delete
BEFORE DELETE ON project_memberships
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE FUNCTION alice_validate_project_invitation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.accepted_at IS NOT NULL
    OR OLD.declined_at IS NOT NULL
    OR OLD.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'project invitations preserve their issued and terminal history'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_invitations_validate_update
BEFORE UPDATE ON project_invitations
FOR EACH ROW EXECUTE FUNCTION alice_validate_project_invitation_update();

CREATE TRIGGER project_invitations_no_delete
BEFORE DELETE ON project_invitations
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
