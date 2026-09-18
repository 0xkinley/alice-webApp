ALTER TABLE migration_sessions
  ADD COLUMN reported_source_scope text NOT NULL DEFAULT 'unknown'
    CHECK (reported_source_scope IN ('provider_project', 'conversation', 'unknown')),
  ADD COLUMN reported_scope_basis text NOT NULL DEFAULT 'unavailable'
    CHECK (reported_scope_basis IN (
      'provider_metadata', 'explicit_tool_context', 'user_statement',
      'visible_conversation_only', 'unavailable'
    )),
  ADD COLUMN source_scope text NOT NULL DEFAULT 'unknown'
    CHECK (source_scope IN ('provider_project', 'conversation', 'unknown')),
  ADD COLUMN scope_basis text NOT NULL DEFAULT 'unavailable'
    CHECK (scope_basis IN (
      'provider_metadata', 'explicit_tool_context', 'user_statement',
      'visible_conversation_only', 'unavailable'
    )),
  ADD COLUMN reported_scope_completeness text NOT NULL DEFAULT 'unknown'
    CHECK (reported_scope_completeness IN (
      'provider_claimed_complete', 'bounded_complete', 'partial', 'unknown'
    )),
  ADD COLUMN reported_completeness_basis text NOT NULL DEFAULT 'unavailable'
    CHECK (reported_completeness_basis IN (
      'provider_metadata', 'explicit_tool_result', 'observed_truncation',
      'user_statement', 'unavailable'
    )),
  ADD COLUMN scope_completeness text NOT NULL DEFAULT 'unknown'
    CHECK (scope_completeness IN (
      'provider_claimed_complete', 'bounded_complete', 'partial', 'unknown'
    )),
  ADD COLUMN completeness_basis text NOT NULL DEFAULT 'unavailable'
    CHECK (completeness_basis IN (
      'provider_metadata', 'explicit_tool_result', 'observed_truncation',
      'user_statement', 'unavailable'
    )),
  ADD COLUMN destination_action text NOT NULL DEFAULT 'create_project_from_source'
    CHECK (destination_action IN (
      'create_project_from_source', 'add_source_to_existing_project', 'create_empty_project'
    ));

CREATE TABLE migration_source_objects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  migration_session_id text NOT NULL,
  source_record_id text NOT NULL,
  source_position integer NOT NULL CHECK (source_position > 0),
  object_type text NOT NULL CHECK (object_type IN (
    'summary', 'instruction', 'message', 'artifact', 'artifact_reference',
    'file_reference', 'other'
  )),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 12000),
  content_sha256 text CHECK (content_sha256 IS NULL OR char_length(content_sha256) = 64),
  content_utf8_bytes integer NOT NULL CHECK (content_utf8_bytes BETWEEN 1 AND 48000),
  speaker text CHECK (speaker IS NULL OR char_length(speaker) BETWEEN 1 AND 120),
  occurred_at text CHECK (occurred_at IS NULL OR char_length(occurred_at) BETWEEN 1 AND 64),
  conversation_id text CHECK (
    conversation_id IS NULL OR char_length(conversation_id) BETWEEN 1 AND 240
  ),
  provider_item_id text CHECK (
    provider_item_id IS NULL OR char_length(provider_item_id) BETWEEN 1 AND 240
  ),
  representation text NOT NULL CHECK (representation IN (
    'structured_content', 'extracted_text', 'metadata', 'reference'
  )),
  completeness text NOT NULL CHECK (completeness IN (
    'complete', 'partial', 'unknown', 'unavailable'
  )),
  authority text NOT NULL CHECK (authority = 'SOURCE_UNVERIFIED'),
  capture_state text NOT NULL CHECK (capture_state IN (
    'CONTENT_ONLY', 'REFERENCE', 'MISSING', 'EXTERNAL'
  )),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, migration_session_id)
    REFERENCES migration_sessions(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, source_record_id)
    REFERENCES migration_source_records(workspace_id, project_id, id),
  UNIQUE (migration_session_id, source_record_id, source_position),
  UNIQUE (workspace_id, project_id, migration_session_id, id),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX migration_source_objects_session
  ON migration_source_objects (
    workspace_id, project_id, migration_session_id, source_position, id
  );

CREATE TABLE migration_source_relationships (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  migration_session_id text NOT NULL,
  from_source_object_id text NOT NULL,
  to_source_object_id text NOT NULL,
  relationship_type text NOT NULL CHECK (relationship_type IN (
    'contains', 'replies_to', 'attached_to', 'produced', 'version_of',
    'reported_supersedes'
  )),
  evidence_basis text NOT NULL CHECK (evidence_basis = 'PROVIDER_SUPPLIED'),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, migration_session_id)
    REFERENCES migration_sessions(workspace_id, project_id, id),
  FOREIGN KEY (
    workspace_id, project_id, migration_session_id, from_source_object_id
  ) REFERENCES migration_source_objects(
    workspace_id, project_id, migration_session_id, id
  ),
  FOREIGN KEY (
    workspace_id, project_id, migration_session_id, to_source_object_id
  ) REFERENCES migration_source_objects(
    workspace_id, project_id, migration_session_id, id
  ),
  CHECK (from_source_object_id <> to_source_object_id),
  UNIQUE (
    migration_session_id, from_source_object_id, to_source_object_id, relationship_type
  ),
  UNIQUE (workspace_id, project_id, id)
);

CREATE INDEX migration_source_relationships_session
  ON migration_source_relationships (
    workspace_id, project_id, migration_session_id, from_source_object_id, id
  );

CREATE TABLE migration_candidate_sources (
  candidate_id text NOT NULL,
  evidence_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  migration_session_id text NOT NULL,
  source_object_id text NOT NULL,
  cited_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, candidate_id, evidence_id)
    REFERENCES candidate_claims(workspace_id, project_id, id, evidence_id),
  FOREIGN KEY (workspace_id, project_id, migration_session_id)
    REFERENCES migration_sessions(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, migration_session_id, source_object_id)
    REFERENCES migration_source_objects(workspace_id, project_id, migration_session_id, id),
  PRIMARY KEY (candidate_id, source_object_id),
  UNIQUE (workspace_id, project_id, candidate_id, source_object_id)
);

CREATE INDEX migration_candidate_sources_session
  ON migration_candidate_sources (
    workspace_id, project_id, migration_session_id, candidate_id, source_object_id
  );

ALTER TABLE artifact_versions
  ADD COLUMN source_authority text NOT NULL DEFAULT 'HUMAN_CONFIRMED'
    CHECK (source_authority IN ('HUMAN_CONFIRMED', 'IMPORTED_UNVERIFIED')),
  ADD COLUMN migration_source_object_id text,
  ADD CONSTRAINT artifact_versions_migration_source_object
    FOREIGN KEY (workspace_id, project_id, migration_source_object_id)
    REFERENCES migration_source_objects(workspace_id, project_id, id),
  ADD CONSTRAINT artifact_versions_source_authority_matches
    CHECK (
      (source_authority = 'HUMAN_CONFIRMED' AND migration_source_object_id IS NULL)
      OR
      (source_authority = 'IMPORTED_UNVERIFIED' AND migration_source_object_id IS NOT NULL)
    );

CREATE UNIQUE INDEX artifact_versions_migration_projection
  ON artifact_versions (migration_source_object_id)
  WHERE migration_source_object_id IS NOT NULL;

CREATE OR REPLACE FUNCTION alice_validate_migration_session_update() RETURNS trigger
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
    OR NEW.reported_source_scope IS DISTINCT FROM OLD.reported_source_scope
    OR NEW.reported_scope_basis IS DISTINCT FROM OLD.reported_scope_basis
    OR NEW.source_scope IS DISTINCT FROM OLD.source_scope
    OR NEW.scope_basis IS DISTINCT FROM OLD.scope_basis
    OR NEW.reported_scope_completeness IS DISTINCT FROM OLD.reported_scope_completeness
    OR NEW.reported_completeness_basis IS DISTINCT FROM OLD.reported_completeness_basis
    OR NEW.scope_completeness IS DISTINCT FROM OLD.scope_completeness
    OR NEW.completeness_basis IS DISTINCT FROM OLD.completeness_basis
    OR NEW.destination_action IS DISTINCT FROM OLD.destination_action
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

INSERT INTO migration_source_objects (
  id, workspace_id, project_id, migration_session_id, source_record_id,
  source_position, object_type, title, content, content_sha256, content_utf8_bytes,
  speaker, occurred_at, conversation_id, provider_item_id, representation,
  completeness, authority, capture_state, created_at
)
SELECT
  source.id || '_item_' || item.ordinality,
  source.workspace_id,
  source.project_id,
  source.migration_session_id,
  source.id,
  item.ordinality,
  CASE item.value->>'kind'
    WHEN 'artifact_description' THEN 'artifact_reference'
    ELSE item.value->>'kind'
  END,
  NULL,
  item.value->>'content',
  NULL,
  octet_length(item.value->>'content'),
  NULLIF(item.value->>'speaker', ''),
  NULLIF(item.value->>'occurred_at', ''),
  NULL,
  NULL,
  CASE
    WHEN item.value->>'kind' = 'artifact_description' THEN 'reference'
    WHEN item.value->>'capture_state' IN ('reference', 'missing', 'external') THEN 'reference'
    ELSE 'structured_content'
  END,
  CASE
    WHEN item.value->>'capture_state' = 'content_only' THEN 'complete'
    WHEN item.value->>'capture_state' IN ('reference', 'missing', 'external') THEN 'unavailable'
    ELSE 'unknown'
  END,
  'SOURCE_UNVERIFIED',
  upper(item.value->>'capture_state'),
  source.created_at
FROM migration_source_records source
CROSS JOIN LATERAL jsonb_array_elements(source.exact_content::jsonb)
  WITH ORDINALITY AS item(value, ordinality)
WHERE source.source_type = 'HOST_SNAPSHOT'
  AND source.source_format = 'alice_supplied_material_json'
  AND source.parser_version = 'identity_v1'
  AND source.exact_content IS JSON ARRAY;

CREATE TRIGGER migration_source_objects_no_update
BEFORE UPDATE ON migration_source_objects
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_source_objects_no_delete
BEFORE DELETE ON migration_source_objects
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_source_relationships_no_update
BEFORE UPDATE ON migration_source_relationships
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_source_relationships_no_delete
BEFORE DELETE ON migration_source_relationships
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_candidate_sources_no_update
BEFORE UPDATE ON migration_candidate_sources
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
CREATE TRIGGER migration_candidate_sources_no_delete
BEFORE DELETE ON migration_candidate_sources
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
