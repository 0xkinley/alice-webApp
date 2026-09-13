CREATE TABLE context_provider_authorizations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('chatgpt', 'claude')),
  enabled integer NOT NULL CHECK (enabled IN (0, 1)),
  version text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, context_id, user_id, provider)
);

CREATE INDEX context_provider_authorizations_user_lookup
  ON context_provider_authorizations
  (user_id, provider, enabled, project_id, context_id);

CREATE FUNCTION alice_validate_context_provider_authorization_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.context_id IS DISTINCT FROM OLD.context_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'context provider authorization identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER context_provider_authorizations_validate_update
BEFORE UPDATE ON context_provider_authorizations
FOR EACH ROW EXECUTE FUNCTION alice_validate_context_provider_authorization_update();

CREATE TRIGGER context_provider_authorizations_no_delete
BEFORE DELETE ON context_provider_authorizations
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

-- Preserve the already-shipped connection behavior for contexts each current
-- member can actually read. New contexts have no provider authorization until
-- that user makes an explicit provider choice.
INSERT INTO context_provider_authorizations
  (id, workspace_id, project_id, context_id, user_id, provider, enabled,
   version, created_at, updated_at)
SELECT 'provider_auth_' || md5(context.id || ':' || membership.user_id || ':' || provider.name),
       context.workspace_id, context.project_id, context.id, membership.user_id,
       provider.name, 1,
       'provider_auth_version_' || md5(context.id || ':' || membership.user_id || ':' || provider.name),
       context.created_at, context.updated_at
FROM work_contexts context
JOIN project_memberships membership
  ON membership.workspace_id = context.workspace_id
 AND membership.project_id = context.project_id
 AND membership.ended_at IS NULL
CROSS JOIN (VALUES ('chatgpt'), ('claude')) AS provider(name)
WHERE context.archived_at IS NULL
  AND (
    context.context_kind = 'project_wide'
    OR context.visibility = 'all_members'
    OR context.created_by_user_id = membership.user_id
    OR EXISTS (
      SELECT 1 FROM context_access_grants context_grant
      WHERE context_grant.workspace_id = context.workspace_id
        AND context_grant.project_id = context.project_id
        AND context_grant.context_id = context.id
        AND context_grant.user_id = membership.user_id
        AND context_grant.ended_at IS NULL
    )
  );
