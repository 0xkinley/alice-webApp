ALTER TABLE accepted_project_state
  ADD CONSTRAINT accepted_project_state_workspace_project_id_unique
  UNIQUE (workspace_id, project_id, id);

INSERT INTO context_history_events
  (id, workspace_id, project_id, context_id, action, actor_user_id,
   safe_metadata_json, created_at)
SELECT 'context_event_' || md5(context.id), context.workspace_id, context.project_id,
       context.id, 'context_created', context.created_by_user_id,
       json_build_object('context_id', context.id, 'context_kind', context.context_kind)::text,
       context.created_at
FROM work_contexts context
WHERE NOT EXISTS (
  SELECT 1 FROM context_history_events event WHERE event.context_id = context.id
);

CREATE TABLE candidate_context_targets (
  candidate_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  targeted_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, candidate_id)
    REFERENCES candidate_claims(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, candidate_id, context_id)
);

CREATE TABLE accepted_context_entries (
  accepted_state_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  added_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id, accepted_state_id)
    REFERENCES accepted_project_state(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, context_id)
    REFERENCES work_contexts(workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, context_id, accepted_state_id)
);

INSERT INTO candidate_context_targets
  (candidate_id, workspace_id, project_id, context_id, targeted_at)
SELECT candidate.id, candidate.workspace_id, candidate.project_id, context.id,
       candidate.created_at
FROM candidate_claims candidate
JOIN work_contexts context
  ON context.workspace_id = candidate.workspace_id
 AND context.project_id = candidate.project_id
 AND context.context_kind = 'project_wide';

INSERT INTO accepted_context_entries
  (accepted_state_id, workspace_id, project_id, context_id, added_at)
SELECT accepted.id, accepted.workspace_id, accepted.project_id, target.context_id,
       accepted.accepted_at
FROM accepted_project_state accepted
JOIN candidate_context_targets target
  ON target.workspace_id = accepted.workspace_id
 AND target.project_id = accepted.project_id
 AND target.candidate_id = accepted.candidate_id;

CREATE INDEX candidate_context_targets_lookup
  ON candidate_context_targets (workspace_id, project_id, context_id, candidate_id);
CREATE INDEX accepted_context_entries_lookup
  ON accepted_context_entries (workspace_id, project_id, context_id, accepted_state_id);

CREATE TRIGGER candidate_context_targets_no_update
BEFORE UPDATE ON candidate_context_targets
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER candidate_context_targets_no_delete
BEFORE DELETE ON candidate_context_targets
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER accepted_context_entries_no_update
BEFORE UPDATE ON accepted_context_entries
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();

CREATE TRIGGER accepted_context_entries_no_delete
BEFORE DELETE ON accepted_context_entries
FOR EACH ROW EXECUTE FUNCTION alice_reject_immutable_change();
