ALTER TABLE host_file_save_decisions
  ADD CONSTRAINT host_file_save_decisions_exact_unique
  UNIQUE (workspace_id, project_id, context_id, offer_id, decided_by_user_id, decision);

ALTER TABLE file_upload_intents
  ADD CONSTRAINT file_upload_intents_exact_user_unique
  UNIQUE (workspace_id, project_id, context_id, id, initiated_by_user_id);

ALTER TABLE file_upload_completions
  ADD CONSTRAINT file_upload_completions_exact_reference_unique
  UNIQUE (intent_id, workspace_id, project_id, context_id, file_reference_id);

CREATE TABLE host_file_save_transfer_intents (
  intent_id text PRIMARY KEY,
  offer_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  initiated_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN (
    'save_file_only', 'save_and_suggest_context'
  )),
  transfer_path text NOT NULL CHECK (transfer_path IN (
    'host_capability', 'browser_fallback'
  )),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (
    workspace_id, project_id, context_id, offer_id, initiated_by_user_id, decision
  ) REFERENCES host_file_save_decisions(
    workspace_id, project_id, context_id, offer_id, decided_by_user_id, decision
  ),
  FOREIGN KEY (
    workspace_id, project_id, context_id, intent_id, initiated_by_user_id
  ) REFERENCES file_upload_intents(
    workspace_id, project_id, context_id, id, initiated_by_user_id
  ),
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (workspace_id, project_id, context_id, offer_id, intent_id),
  UNIQUE (offer_id, transfer_path, idempotency_key)
);

CREATE TABLE host_file_save_transfer_completions (
  offer_id text PRIMARY KEY,
  intent_id text NOT NULL UNIQUE,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  file_reference_id text NOT NULL UNIQUE,
  completed_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, context_id, offer_id, intent_id)
    REFERENCES host_file_save_transfer_intents(
      workspace_id, project_id, context_id, offer_id, intent_id
    ),
  FOREIGN KEY (intent_id, workspace_id, project_id, context_id, file_reference_id)
    REFERENCES file_upload_completions(
      intent_id, workspace_id, project_id, context_id, file_reference_id
    ),
  UNIQUE (offer_id, intent_id, workspace_id, project_id, context_id, file_reference_id)
);

CREATE TABLE host_file_save_transfer_availability (
  offer_id text PRIMARY KEY,
  intent_id text NOT NULL UNIQUE,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  file_reference_id text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL,
  FOREIGN KEY (offer_id, intent_id, workspace_id, project_id, context_id, file_reference_id)
    REFERENCES host_file_save_transfer_completions(
      offer_id, intent_id, workspace_id, project_id, context_id, file_reference_id
    )
);

CREATE INDEX host_file_save_transfer_intents_offer
  ON host_file_save_transfer_intents (offer_id, created_at, intent_id);

CREATE TRIGGER host_file_save_transfer_intents_no_update
BEFORE UPDATE ON host_file_save_transfer_intents
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_transfer_intents_no_delete
BEFORE DELETE ON host_file_save_transfer_intents
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_transfer_completions_no_update
BEFORE UPDATE ON host_file_save_transfer_completions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_transfer_completions_no_delete
BEFORE DELETE ON host_file_save_transfer_completions
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_transfer_availability_no_update
BEFORE UPDATE ON host_file_save_transfer_availability
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER host_file_save_transfer_availability_no_delete
BEFORE DELETE ON host_file_save_transfer_availability
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
