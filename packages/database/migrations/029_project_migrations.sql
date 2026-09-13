CREATE TABLE migration_previews (
  id text PRIMARY KEY,
  user_workspace_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_id text NOT NULL,
  client_id text NOT NULL,
  source_provider text NOT NULL CHECK (source_provider IN ('chatgpt', 'claude')),
  alice_project_name text NOT NULL CHECK (char_length(alice_project_name) BETWEEN 1 AND 120),
  provider_project_id text CHECK (
    provider_project_id IS NULL OR char_length(provider_project_id) BETWEEN 1 AND 240
  ),
  provider_project_name text CHECK (
    provider_project_name IS NULL OR char_length(provider_project_name) BETWEEN 1 AND 240
  ),
  exact_payload_json text NOT NULL CHECK (char_length(exact_payload_json) BETWEEN 2 AND 131072),
  payload_sha256 text NOT NULL CHECK (char_length(payload_sha256) = 64),
  exact_preview_json text NOT NULL CHECK (char_length(exact_preview_json) BETWEEN 2 AND 196608),
  preview_version text NOT NULL CHECK (char_length(preview_version) = 64),
  authority_token_hash text NOT NULL CHECK (char_length(authority_token_hash) = 64),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL,
  FOREIGN KEY (user_workspace_id, user_id, connection_id, client_id)
    REFERENCES integration_connections(workspace_id, user_id, id, client_id)
);

CREATE INDEX migration_previews_expiry ON migration_previews (expires_at);

CREATE TABLE migration_sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_connection_workspace_id text NOT NULL,
  source_connection_id text NOT NULL,
  source_client_id text NOT NULL,
  source_provider text NOT NULL CHECK (source_provider IN ('chatgpt', 'claude')),
  provider_project_id text CHECK (
    provider_project_id IS NULL OR char_length(provider_project_id) BETWEEN 1 AND 240
  ),
  provider_project_name text CHECK (
    provider_project_name IS NULL OR char_length(provider_project_name) BETWEEN 1 AND 240
  ),
  migration_version text NOT NULL CHECK (char_length(migration_version) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (
    status IN ('CREATED', 'INGESTING', 'VERIFYING', 'COMPLETE', 'PARTIAL', 'FAILED')
  ),
  status_version integer NOT NULL CHECK (status_version > 0),
  observed_count integer NOT NULL CHECK (observed_count BETWEEN 0 AND 100000),
  imported_count integer NOT NULL CHECK (imported_count BETWEEN 0 AND observed_count),
  exact_bytes_count integer NOT NULL CHECK (exact_bytes_count BETWEEN 0 AND imported_count),
  content_only_count integer NOT NULL CHECK (content_only_count BETWEEN 0 AND imported_count),
  reference_count integer NOT NULL CHECK (reference_count BETWEEN 0 AND observed_count),
  missing_count integer NOT NULL CHECK (missing_count BETWEEN 0 AND observed_count),
  external_count integer NOT NULL CHECK (external_count BETWEEN 0 AND observed_count),
  unsupported_count integer NOT NULL CHECK (unsupported_count BETWEEN 0 AND observed_count),
  alice_confirmed_count integer NOT NULL CHECK (alice_confirmed_count BETWEEN 0 AND 100000),
  error_summary text CHECK (
    error_summary IS NULL OR error_summary IN (
      'Some supplied material is reference-only, missing, external, or unsupported.',
      'One or more referenced items were not supplied.',
      'The supplied source could not be processed.'
    )
  ),
  preview_id text NOT NULL UNIQUE CHECK (char_length(preview_id) BETWEEN 1 AND 240),
  intent_idempotency_key text NOT NULL CHECK (
    char_length(intent_idempotency_key) BETWEEN 8 AND 128
  ),
  input_payload_sha256 text NOT NULL CHECK (char_length(input_payload_sha256) = 64),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (
    source_connection_workspace_id, created_by_user_id, source_connection_id, source_client_id
  ) REFERENCES integration_connections(workspace_id, user_id, id, client_id),
  CHECK ((status = 'COMPLETE') = (completed_at IS NOT NULL)),
  CHECK ((status IN ('PARTIAL', 'FAILED')) = (error_summary IS NOT NULL)),
  CHECK (exact_bytes_count + content_only_count <= imported_count),
  UNIQUE (source_connection_id, intent_idempotency_key),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX migration_sessions_project
  ON migration_sessions (workspace_id, project_id, created_at DESC, id DESC);
CREATE INDEX migration_sessions_connection
  ON migration_sessions (source_connection_id, created_at DESC, id DESC);

CREATE TABLE migration_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  migration_session_id text NOT NULL,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  event_type text NOT NULL CHECK (
    event_type IN ('SESSION_CREATED', 'STATUS_CHANGED', 'SOURCE_INGESTED', 'RETRY_STARTED')
  ),
  previous_status text CHECK (
    previous_status IS NULL OR previous_status IN (
      'CREATED', 'INGESTING', 'VERIFYING', 'COMPLETE', 'PARTIAL', 'FAILED'
    )
  ),
  next_status text NOT NULL CHECK (
    next_status IN ('CREATED', 'INGESTING', 'VERIFYING', 'COMPLETE', 'PARTIAL', 'FAILED')
  ),
  status_version integer NOT NULL CHECK (status_version > 0),
  actor_type text NOT NULL CHECK (actor_type IN ('human_user', 'alice_system')),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 240),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, migration_session_id)
    REFERENCES migration_sessions(workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, migration_session_id, event_sequence),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX migration_events_session
  ON migration_events (workspace_id, project_id, migration_session_id, event_sequence, id);

CREATE TABLE migration_source_records (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  migration_session_id text NOT NULL,
  source_type text NOT NULL CHECK (source_type = 'HOST_SNAPSHOT'),
  authority text NOT NULL CHECK (authority = 'UNVERIFIED_HOST_DERIVED'),
  capture_state text NOT NULL CHECK (
    capture_state IN ('EXACT_BYTES', 'CONTENT_ONLY', 'REFERENCE', 'MISSING', 'EXTERNAL')
  ),
  source_provider text NOT NULL CHECK (source_provider IN ('chatgpt', 'claude')),
  provider_project_id text CHECK (
    provider_project_id IS NULL OR char_length(provider_project_id) BETWEEN 1 AND 240
  ),
  provider_project_name text CHECK (
    provider_project_name IS NULL OR char_length(provider_project_name) BETWEEN 1 AND 240
  ),
  source_format text NOT NULL CHECK (char_length(source_format) BETWEEN 1 AND 100),
  parser_version text NOT NULL CHECK (char_length(parser_version) BETWEEN 1 AND 64),
  exact_content text,
  content_sha256 text NOT NULL CHECK (char_length(content_sha256) = 64),
  content_utf8_bytes integer NOT NULL CHECK (content_utf8_bytes BETWEEN 0 AND 131072),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, migration_session_id)
    REFERENCES migration_sessions(workspace_id, project_id, id),
  CHECK (
    (capture_state IN ('EXACT_BYTES', 'CONTENT_ONLY')
      AND exact_content IS NOT NULL
      AND content_utf8_bytes > 0)
    OR
    (capture_state IN ('REFERENCE', 'MISSING', 'EXTERNAL')
      AND exact_content IS NULL
      AND content_utf8_bytes = 0)
  ),
  UNIQUE (migration_session_id, idempotency_key),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX migration_source_records_session
  ON migration_source_records (workspace_id, project_id, migration_session_id, created_at, id);

CREATE FUNCTION alice_validate_migration_session_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.source_connection_workspace_id IS DISTINCT FROM OLD.source_connection_workspace_id
    OR NEW.source_connection_id IS DISTINCT FROM OLD.source_connection_id
    OR NEW.source_client_id IS DISTINCT FROM OLD.source_client_id
    OR NEW.source_provider IS DISTINCT FROM OLD.source_provider
    OR NEW.provider_project_id IS DISTINCT FROM OLD.provider_project_id
    OR NEW.provider_project_name IS DISTINCT FROM OLD.provider_project_name
    OR NEW.migration_version IS DISTINCT FROM OLD.migration_version
    OR NEW.preview_id IS DISTINCT FROM OLD.preview_id
    OR NEW.intent_idempotency_key IS DISTINCT FROM OLD.intent_idempotency_key
    OR NEW.input_payload_sha256 IS DISTINCT FROM OLD.input_payload_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.status_version <> OLD.status_version + 1
    OR NEW.updated_at <= OLD.updated_at
    OR NEW.observed_count < OLD.observed_count
    OR NEW.imported_count < OLD.imported_count
    OR NEW.exact_bytes_count < OLD.exact_bytes_count
    OR NEW.content_only_count < OLD.content_only_count
    OR NEW.reference_count < OLD.reference_count
    OR NEW.missing_count < OLD.missing_count
    OR NEW.external_count < OLD.external_count
    OR NEW.unsupported_count < OLD.unsupported_count
    OR NEW.alice_confirmed_count < OLD.alice_confirmed_count
    OR NOT (
      (OLD.status = 'CREATED' AND NEW.status IN ('INGESTING', 'FAILED'))
      OR (OLD.status = 'INGESTING' AND NEW.status IN ('VERIFYING', 'PARTIAL', 'FAILED'))
      OR (OLD.status = 'VERIFYING' AND NEW.status IN ('COMPLETE', 'PARTIAL', 'FAILED'))
      OR (OLD.status = 'PARTIAL' AND NEW.status IN ('INGESTING', 'VERIFYING', 'COMPLETE', 'FAILED'))
      OR (OLD.status = 'FAILED' AND NEW.status = 'INGESTING')
    )
  THEN
    RAISE EXCEPTION 'invalid or immutable migration session update'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER migration_sessions_validate_update
BEFORE UPDATE ON migration_sessions
FOR EACH ROW EXECUTE FUNCTION alice_validate_migration_session_update();
CREATE TRIGGER migration_sessions_no_delete
BEFORE DELETE ON migration_sessions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_previews_no_update
BEFORE UPDATE ON migration_previews
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_events_no_update
BEFORE UPDATE ON migration_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_events_no_delete
BEFORE DELETE ON migration_events
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_source_records_no_update
BEFORE UPDATE ON migration_source_records
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_source_records_no_delete
BEFORE DELETE ON migration_source_records
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
