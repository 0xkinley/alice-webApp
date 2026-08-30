import { DatabaseSync } from "node:sqlite";

function sqliteSql(sql: string): string {
  return sql
    .replace(/\s+FOR UPDATE(?: OF [a-z_]+)?\b/g, "")
    .replace(
      /(?:([a-z_]+)\.)?safe_metadata_json::jsonb ->> '([a-z_]+)'/g,
      (_match, alias, key) =>
        `json_extract(${alias ? `${alias}.` : ""}safe_metadata_json, '$.${key}')`,
    )
    .replace("SELECT pg_advisory_xact_lock(hashtext(?))", "SELECT ? AS advisory_lock_key");
}

class SQLitePreparedStatement {
  private readonly statement;

  constructor(statement) {
    this.statement = statement;
  }

  get(...parameters: unknown[]) {
    return this.statement.get(...parameters);
  }

  all(...parameters: unknown[]) {
    return this.statement.all(...parameters);
  }

  run(...parameters: unknown[]) {
    return this.statement.run(...parameters);
  }
}

export class SQLiteTestDatabase {
  readonly #database: DatabaseSync;

  constructor() {
    this.#database = new DatabaseSync(":memory:");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    createSchema(this.#database);
  }

  prepare(sql: string) {
    return new SQLitePreparedStatement(this.#database.prepare(sqliteSql(sql)));
  }

  query(sql: string, parameters: unknown[] = []) {
    return this.prepare(sql).all(...parameters);
  }

  exec(sql: string) {
    this.#database.exec(sql);
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.#database.close();
  }
}

export function openSqliteTestDatabase(): SQLiteTestDatabase {
  return new SQLiteTestDatabase();
}

function createSchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (id, user_id)
    ) STRICT;

    CREATE TABLE web_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE alpha_invitations (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      accepted_by_user_id TEXT UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      accepted_at TEXT,
      revoked_at TEXT,
      CHECK ((accepted_by_user_id IS NULL) = (accepted_at IS NULL))
    ) STRICT;

    CREATE TABLE oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret_hash TEXT,
      client_name TEXT NOT NULL,
      redirect_uris_json TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE integration_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      workspace_id TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
      client_classification TEXT NOT NULL,
      granted_scopes TEXT NOT NULL,
      first_connected_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (workspace_id, user_id) REFERENCES workspaces(id, user_id),
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, user_id, id),
      UNIQUE (workspace_id, user_id, id, client_id)
    ) STRICT;

    CREATE TABLE oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
      user_id TEXT NOT NULL REFERENCES users(id),
      connection_id TEXT NOT NULL REFERENCES integration_connections(id),
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at TEXT
    ) STRICT;

    CREATE TABLE oauth_access_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
      user_id TEXT NOT NULL REFERENCES users(id),
      connection_id TEXT NOT NULL REFERENCES integration_connections(id),
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at TEXT
    ) STRICT;

    CREATE TABLE oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
      user_id TEXT NOT NULL REFERENCES users(id),
      connection_id TEXT NOT NULL REFERENCES integration_connections(id),
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at TEXT
    ) STRICT;

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      brief TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      archived_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL)),
      UNIQUE (workspace_id, name),
      UNIQUE (workspace_id, id)
    ) STRICT;

    CREATE TABLE project_memberships (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      ended_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL)),
      UNIQUE (workspace_id, project_id, id),
      UNIQUE (workspace_id, project_id, user_id, id)
    ) STRICT;

    CREATE UNIQUE INDEX project_memberships_active_user
      ON project_memberships (project_id, user_id) WHERE ended_at IS NULL;
    CREATE INDEX project_memberships_user_lookup
      ON project_memberships (user_id, ended_at, project_id, role);
    CREATE INDEX project_memberships_project_lookup
      ON project_memberships (workspace_id, project_id, ended_at, role, user_id);

    CREATE TABLE project_invitations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
      token_hash TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      accepted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      accepted_at TEXT,
      declined_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      declined_at TEXT,
      revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      revoked_at TEXT,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
      CHECK ((declined_at IS NULL) = (declined_by_user_id IS NULL)),
      CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
      CHECK (
        (CASE WHEN accepted_at IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN declined_at IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END) <= 1
      )
    ) STRICT;

    CREATE UNIQUE INDEX project_invitations_pending_email
      ON project_invitations (project_id, email)
      WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;
    CREATE INDEX project_invitations_project_lookup
      ON project_invitations (workspace_id, project_id, created_at DESC, id);

    CREATE TABLE project_deletion_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      requested_at TEXT NOT NULL,
      not_before TEXT NOT NULL,
      cancelled_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      cancelled_at TEXT,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      CHECK (not_before > requested_at),
      CHECK ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)),
      UNIQUE (workspace_id, project_id, id)
    ) STRICT;

    CREATE UNIQUE INDEX project_deletion_requests_active_project
      ON project_deletion_requests (project_id) WHERE cancelled_at IS NULL;
    CREATE INDEX project_deletion_requests_operator_queue
      ON project_deletion_requests (not_before, requested_at, id) WHERE cancelled_at IS NULL;

    CREATE TRIGGER projects_create_owner_membership
    AFTER INSERT ON projects
    BEGIN
      INSERT INTO project_memberships
        (id, workspace_id, project_id, user_id, role, created_by_user_id,
         created_at, updated_at)
      SELECT 'membership_owner_' || NEW.id, NEW.workspace_id, NEW.id, user_id,
             'owner', user_id, NEW.created_at, NEW.updated_at
      FROM workspaces WHERE id = NEW.workspace_id;
    END;

    CREATE TABLE work_contexts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      context_kind TEXT NOT NULL CHECK (context_kind IN ('project_wide', 'work')),
      visibility TEXT NOT NULL CHECK (visibility IN ('all_members', 'selected_members', 'personal')),
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      UNIQUE (workspace_id, project_id, id)
    ) STRICT;

    CREATE UNIQUE INDEX work_contexts_name_unique
      ON work_contexts (project_id, name COLLATE NOCASE);
    CREATE UNIQUE INDEX work_contexts_one_project_wide
      ON work_contexts (project_id) WHERE context_kind = 'project_wide';

    CREATE TABLE context_access_grants (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      membership_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
      granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      ended_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id),
      FOREIGN KEY (workspace_id, project_id, user_id, membership_id)
        REFERENCES project_memberships(workspace_id, project_id, user_id, id),
      CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL)),
      UNIQUE (workspace_id, project_id, context_id, id)
    ) STRICT;

    CREATE UNIQUE INDEX context_access_grants_active_user
      ON context_access_grants (context_id, user_id) WHERE ended_at IS NULL;
    CREATE INDEX context_access_grants_user_lookup
      ON context_access_grants (user_id, ended_at, project_id, context_id, role);
    CREATE INDEX context_access_grants_context_lookup
      ON context_access_grants (workspace_id, project_id, context_id, ended_at, role, user_id);

    CREATE TABLE context_read_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      connection_workspace_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
      client_name TEXT NOT NULL,
      client_classification TEXT NOT NULL,
      requested_via TEXT NOT NULL CHECK (requested_via IN ('active_target', 'explicit_fallback')),
      status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
      failure_code TEXT CHECK (
        failure_code IN ('no_active_target', 'not_accessible', 'budget_error', 'internal_error')
      ),
      project_workspace_id TEXT,
      project_id TEXT,
      context_id TEXT,
      package_version TEXT,
      package_utf8_bytes INTEGER CHECK (package_utf8_bytes > 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (connection_workspace_id, user_id, connection_id, client_id)
        REFERENCES integration_connections(workspace_id, user_id, id, client_id),
      FOREIGN KEY (project_workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id),
      CHECK (
        (status = 'succeeded'
          AND failure_code IS NULL
          AND project_workspace_id IS NOT NULL
          AND project_id IS NOT NULL
          AND context_id IS NOT NULL
          AND package_version IS NOT NULL
          AND package_utf8_bytes IS NOT NULL)
        OR
        (status = 'failed'
          AND failure_code IS NOT NULL
          AND package_version IS NULL
          AND package_utf8_bytes IS NULL
          AND ((project_workspace_id IS NULL AND project_id IS NULL AND context_id IS NULL)
            OR (project_workspace_id IS NOT NULL AND project_id IS NOT NULL
              AND context_id IS NOT NULL)))
      )
    ) STRICT;

    CREATE INDEX context_read_events_user_lookup
      ON context_read_events (user_id, created_at DESC, id DESC);
    CREATE INDEX context_read_events_project_lookup
      ON context_read_events (
        user_id, project_workspace_id, project_id, context_id, created_at DESC, id DESC
      );

    CREATE TABLE context_history_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      safe_metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id)
    ) STRICT;

    CREATE TABLE evidence_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      exact_payload_json TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_workspace_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_classification TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      FOREIGN KEY (connection_workspace_id, connection_id)
        REFERENCES integration_connections(workspace_id, id),
      UNIQUE (connection_id, project_id, idempotency_key),
      UNIQUE (workspace_id, project_id, id)
    ) STRICT;

    CREATE TABLE candidate_claims (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      FOREIGN KEY (workspace_id, project_id, evidence_id)
        REFERENCES evidence_events(workspace_id, project_id, id),
      UNIQUE (workspace_id, project_id, id),
      UNIQUE (workspace_id, project_id, id, evidence_id)
    ) STRICT;

    CREATE TABLE accepted_project_state (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL UNIQUE,
      evidence_id TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      accepted_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      FOREIGN KEY (workspace_id, project_id, candidate_id)
        REFERENCES candidate_claims(workspace_id, project_id, id),
      FOREIGN KEY (workspace_id, project_id, candidate_id, evidence_id)
        REFERENCES candidate_claims(workspace_id, project_id, id, evidence_id),
      FOREIGN KEY (workspace_id, project_id, evidence_id)
        REFERENCES evidence_events(workspace_id, project_id, id),
      UNIQUE (project_id, state_key, version),
      UNIQUE (workspace_id, project_id, id)
    ) STRICT;

    CREATE TABLE candidate_context_targets (
      candidate_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      targeted_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id, candidate_id)
        REFERENCES candidate_claims(workspace_id, project_id, id),
      FOREIGN KEY (workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id),
      UNIQUE (workspace_id, project_id, candidate_id, context_id)
    ) STRICT;

    CREATE TABLE accepted_context_entries (
      accepted_state_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id, accepted_state_id)
        REFERENCES accepted_project_state(workspace_id, project_id, id),
      FOREIGN KEY (workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id),
      UNIQUE (workspace_id, project_id, context_id, accepted_state_id)
    ) STRICT;

    CREATE TABLE active_connection_targets (
      connection_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      selection_version TEXT NOT NULL,
      selected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, user_id, connection_id)
        REFERENCES integration_connections(workspace_id, user_id, id),
      FOREIGN KEY (project_workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id)
    ) STRICT;

    CREATE TABLE context_entry_exclusions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      accepted_state_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL CHECK (length(reason) <= 500),
      removed_by_user_id TEXT NOT NULL,
      removed_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id, context_id, accepted_state_id)
        REFERENCES accepted_context_entries(workspace_id, project_id, context_id, accepted_state_id),
      FOREIGN KEY (removed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE file_objects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
      verified_media_type TEXT NOT NULL CHECK (verified_media_type IN (
        'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
        'text/plain', 'text/markdown'
      )),
      storage_key TEXT NOT NULL UNIQUE,
      storage_version_id TEXT,
      storage_etag TEXT,
      scan_provider TEXT NOT NULL CHECK (scan_provider = 'aws_guardduty_s3'),
      scan_status TEXT NOT NULL CHECK (scan_status IN (
        'pending_upload', 'scanning', 'clean', 'threats_found',
        'unsupported', 'scan_failed', 'storage_failed'
      )),
      scan_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, content_sha256)
    ) STRICT;

    CREATE TABLE file_context_references (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      file_object_id TEXT NOT NULL,
      logical_file_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 180),
      source_host TEXT NOT NULL CHECK (length(source_host) BETWEEN 1 AND 80),
      uploader_user_id TEXT NOT NULL,
      access_scope TEXT NOT NULL CHECK (access_scope = 'inherit_context'),
      referenced_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id),
      FOREIGN KEY (workspace_id, file_object_id)
        REFERENCES file_objects(workspace_id, id),
      FOREIGN KEY (uploader_user_id) REFERENCES users(id) ON DELETE RESTRICT,
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, project_id, context_id, id),
      UNIQUE (workspace_id, project_id, context_id, logical_file_id, version),
      UNIQUE (workspace_id, project_id, context_id, file_object_id)
    ) STRICT;

    CREATE TABLE file_reference_exclusions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      file_reference_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL CHECK (length(reason) <= 500),
      removed_by_user_id TEXT NOT NULL,
      removed_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id, context_id, file_reference_id)
        REFERENCES file_context_references(workspace_id, project_id, context_id, id),
      FOREIGN KEY (removed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX file_reference_exclusions_lookup
      ON file_reference_exclusions (workspace_id, project_id, context_id, removed_at, id);

    CREATE INDEX file_objects_scan_queue
      ON file_objects (workspace_id, scan_status, scan_updated_at, id);
    CREATE INDEX file_context_references_lookup
      ON file_context_references (workspace_id, project_id, context_id, referenced_at, id);
    CREATE INDEX file_context_references_versions
      ON file_context_references (
        workspace_id, project_id, context_id, logical_file_id, version DESC, id
      );

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      safe_metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
    ) STRICT;

    CREATE TRIGGER evidence_events_no_update
    BEFORE UPDATE ON evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'evidence events are immutable');
    END;

    CREATE TRIGGER evidence_events_no_delete
    BEFORE DELETE ON evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'evidence events are immutable');
    END;

    CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are append-only');
    END;

    CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are append-only');
    END;

    CREATE TRIGGER projects_lifecycle_only_update
    BEFORE UPDATE ON projects
    WHEN NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.created_at IS NOT OLD.created_at
      OR ((NEW.archived_at IS NULL) IS NOT (NEW.archived_by_user_id IS NULL))
    BEGIN
      SELECT RAISE(ABORT, 'project identity is immutable');
    END;

    CREATE TRIGGER projects_no_delete
    BEFORE DELETE ON projects
    BEGIN
      SELECT RAISE(ABORT, 'projects require privileged erasure');
    END;

    CREATE TRIGGER project_deletion_requests_validate_insert
    BEFORE INSERT ON project_deletion_requests
    WHEN NOT EXISTS (
      SELECT 1 FROM projects project
      WHERE project.workspace_id = NEW.workspace_id
        AND project.id = NEW.project_id
        AND project.archived_at IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'a project must be archived before deletion is requested');
    END;

    CREATE TRIGGER project_deletion_requests_validate_update
    BEFORE UPDATE ON project_deletion_requests
    WHEN NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.requested_by_user_id IS NOT OLD.requested_by_user_id
      OR NEW.requested_at IS NOT OLD.requested_at
      OR NEW.not_before IS NOT OLD.not_before
      OR OLD.cancelled_at IS NOT NULL
      OR NEW.cancelled_at IS NULL
      OR NEW.cancelled_by_user_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'deletion request history is immutable');
    END;

    CREATE TRIGGER project_deletion_requests_no_delete
    BEFORE DELETE ON project_deletion_requests
    BEGIN
      SELECT RAISE(ABORT, 'deletion request history is retained until privileged erasure');
    END;

    CREATE TRIGGER project_memberships_validate_update
    BEFORE UPDATE ON project_memberships
    WHEN NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.user_id IS NOT OLD.user_id
      OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
      OR NEW.created_at IS NOT OLD.created_at
      OR OLD.ended_at IS NOT NULL
      OR (NEW.ended_at IS NULL AND NEW.ended_by_user_id IS NOT NULL)
      OR (NEW.ended_at IS NOT NULL AND NEW.ended_by_user_id IS NULL)
      OR (
        OLD.ended_at IS NULL AND OLD.role = 'owner'
        AND (NEW.role <> 'owner' OR NEW.ended_at IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM project_memberships membership
          WHERE membership.project_id = OLD.project_id
            AND membership.id <> OLD.id
            AND membership.role = 'owner'
          AND membership.ended_at IS NULL
        )
      )
      OR (
        OLD.ended_at IS NULL
        AND (NEW.ended_at IS NOT NULL OR NEW.role = 'viewer')
        AND EXISTS (
          SELECT 1 FROM context_access_grants context_grant
          WHERE context_grant.membership_id = OLD.id
            AND context_grant.ended_at IS NULL
          AND (NEW.ended_at IS NOT NULL OR context_grant.role <> 'viewer')
        )
      )
      OR (
        OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM work_contexts context
          WHERE context.workspace_id = OLD.workspace_id
            AND context.project_id = OLD.project_id
            AND context.created_by_user_id = OLD.user_id
            AND context.visibility = 'personal'
            AND context.archived_at IS NULL
        )
      )
      OR (
        OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
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
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid membership rewrite or project would have no owner');
    END;

    CREATE TRIGGER project_memberships_no_delete
    BEFORE DELETE ON project_memberships
    BEGIN
      SELECT RAISE(ABORT, 'project membership history is retained');
    END;

    CREATE TRIGGER project_invitations_validate_update
    BEFORE UPDATE ON project_invitations
    WHEN NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.email IS NOT OLD.email
      OR NEW.role IS NOT OLD.role
      OR NEW.token_hash IS NOT OLD.token_hash
      OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
      OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.created_at IS NOT OLD.created_at
      OR OLD.accepted_at IS NOT NULL
      OR OLD.declined_at IS NOT NULL
      OR OLD.revoked_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'project invitation history is retained');
    END;

    CREATE TRIGGER project_invitations_no_delete
    BEFORE DELETE ON project_invitations
    BEGIN
      SELECT RAISE(ABORT, 'project invitation history is retained');
    END;

    CREATE TRIGGER context_access_grants_validate_insert
    BEFORE INSERT ON context_access_grants
    WHEN NOT EXISTS (
        SELECT 1 FROM work_contexts context
        WHERE context.workspace_id = NEW.workspace_id
          AND context.project_id = NEW.project_id
          AND context.id = NEW.context_id
          AND context.visibility = 'selected_members'
      )
      OR NOT EXISTS (
        SELECT 1 FROM project_memberships membership
        WHERE membership.workspace_id = NEW.workspace_id
          AND membership.project_id = NEW.project_id
          AND membership.user_id = NEW.user_id
          AND membership.id = NEW.membership_id
          AND membership.ended_at IS NULL
          AND (membership.role <> 'viewer' OR NEW.role = 'viewer')
      )
    BEGIN
      SELECT RAISE(ABORT, 'context grants require an active bounded membership');
    END;

    CREATE TRIGGER context_access_grants_validate_update
    BEFORE UPDATE ON context_access_grants
    WHEN NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.context_id IS NOT OLD.context_id
      OR NEW.membership_id IS NOT OLD.membership_id
      OR NEW.user_id IS NOT OLD.user_id
      OR NEW.granted_by_user_id IS NOT OLD.granted_by_user_id
      OR NEW.created_at IS NOT OLD.created_at
      OR OLD.ended_at IS NOT NULL
      OR (NEW.ended_at IS NULL AND NEW.ended_by_user_id IS NOT NULL)
      OR (NEW.ended_at IS NOT NULL AND NEW.ended_by_user_id IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM work_contexts context
        WHERE context.workspace_id = NEW.workspace_id
          AND context.project_id = NEW.project_id
          AND context.id = NEW.context_id
          AND context.visibility = 'selected_members'
      )
      OR NOT EXISTS (
        SELECT 1 FROM project_memberships membership
        WHERE membership.workspace_id = NEW.workspace_id
          AND membership.project_id = NEW.project_id
          AND membership.user_id = NEW.user_id
          AND membership.id = NEW.membership_id
          AND membership.ended_at IS NULL
          AND (membership.role <> 'viewer' OR NEW.role = 'viewer')
      )
    BEGIN
      SELECT RAISE(ABORT, 'context grant identity, bounds, and ended history are retained');
    END;

    CREATE TRIGGER context_access_grants_no_delete
    BEFORE DELETE ON context_access_grants
    BEGIN
      SELECT RAISE(ABORT, 'context access grant history is retained');
    END;

    CREATE TRIGGER context_read_events_no_update
    BEFORE UPDATE ON context_read_events
    BEGIN
      SELECT RAISE(ABORT, 'context read events are append-only');
    END;

    CREATE TRIGGER context_read_events_no_delete
    BEFORE DELETE ON context_read_events
    BEGIN
      SELECT RAISE(ABORT, 'context read events are append-only');
    END;

    CREATE TRIGGER candidate_claims_status_only_update
    BEFORE UPDATE ON candidate_claims
    WHEN OLD.status <> 'pending'
      OR NEW.status NOT IN ('accepted', 'rejected')
      OR NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.evidence_id IS NOT OLD.evidence_id
      OR NEW.state_key IS NOT OLD.state_key
      OR NEW.value_json IS NOT OLD.value_json
      OR NEW.summary IS NOT OLD.summary
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'candidate claims preserve submitted content and terminal status');
    END;

    CREATE TRIGGER candidate_claims_no_delete
    BEFORE DELETE ON candidate_claims
    BEGIN
      SELECT RAISE(ABORT, 'candidate claims preserve history');
    END;

    CREATE TRIGGER accepted_project_state_no_update
    BEFORE UPDATE ON accepted_project_state
    BEGIN
      SELECT RAISE(ABORT, 'accepted project state is versioned and immutable');
    END;

    CREATE TRIGGER accepted_project_state_no_delete
    BEFORE DELETE ON accepted_project_state
    BEGIN
      SELECT RAISE(ABORT, 'accepted project state is versioned and immutable');
    END;

    CREATE TRIGGER context_history_events_no_update
    BEFORE UPDATE ON context_history_events
    BEGIN
      SELECT RAISE(ABORT, 'context history is append-only');
    END;

    CREATE TRIGGER context_history_events_no_delete
    BEFORE DELETE ON context_history_events
    BEGIN
      SELECT RAISE(ABORT, 'context history is append-only');
    END;

    CREATE TRIGGER candidate_context_targets_no_update
    BEFORE UPDATE ON candidate_context_targets
    BEGIN
      SELECT RAISE(ABORT, 'candidate context targets are immutable');
    END;

    CREATE TRIGGER candidate_context_targets_no_delete
    BEFORE DELETE ON candidate_context_targets
    BEGIN
      SELECT RAISE(ABORT, 'candidate context targets are immutable');
    END;

    CREATE TRIGGER accepted_context_entries_no_update
    BEFORE UPDATE ON accepted_context_entries
    BEGIN
      SELECT RAISE(ABORT, 'accepted context entries are immutable');
    END;

    CREATE TRIGGER accepted_context_entries_no_delete
    BEFORE DELETE ON accepted_context_entries
    BEGIN
      SELECT RAISE(ABORT, 'accepted context entries are immutable');
    END;

    CREATE TRIGGER context_entry_exclusions_no_update
    BEFORE UPDATE ON context_entry_exclusions
    BEGIN
      SELECT RAISE(ABORT, 'context entry exclusions are immutable');
    END;

    CREATE TRIGGER context_entry_exclusions_no_delete
    BEFORE DELETE ON context_entry_exclusions
    BEGIN
      SELECT RAISE(ABORT, 'context entry exclusions are immutable');
    END;

    CREATE TRIGGER file_objects_validate_update
    BEFORE UPDATE ON file_objects
    WHEN NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.content_sha256 IS NOT OLD.content_sha256
      OR NEW.byte_size IS NOT OLD.byte_size
      OR NEW.verified_media_type IS NOT OLD.verified_media_type
      OR NEW.storage_key IS NOT OLD.storage_key
      OR NEW.scan_provider IS NOT OLD.scan_provider
      OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.storage_version_id IS NOT NULL AND (
        NEW.storage_version_id IS NOT OLD.storage_version_id
        OR NEW.storage_etag IS NOT OLD.storage_etag
      ))
      OR (OLD.scan_status = 'pending_upload' AND NEW.scan_status NOT IN (
        'pending_upload', 'scanning', 'storage_failed'
      ))
      OR (OLD.scan_status = 'storage_failed' AND NEW.scan_status NOT IN (
        'storage_failed', 'pending_upload'
      ))
      OR (OLD.scan_status = 'scanning' AND NEW.scan_status NOT IN (
        'scanning', 'clean', 'threats_found', 'unsupported', 'scan_failed'
      ))
      OR (OLD.scan_status IN ('clean', 'threats_found', 'unsupported', 'scan_failed')
        AND NEW.scan_status IS NOT OLD.scan_status)
      OR (NEW.scan_status NOT IN ('pending_upload', 'storage_failed')
        AND NEW.storage_version_id IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid or immutable file object update');
    END;

    CREATE TRIGGER file_objects_no_delete
    BEFORE DELETE ON file_objects
    BEGIN
      SELECT RAISE(ABORT, 'file objects preserve history');
    END;

    CREATE TRIGGER file_context_references_no_update
    BEFORE UPDATE ON file_context_references
    BEGIN
      SELECT RAISE(ABORT, 'file context references are immutable');
    END;

    CREATE TRIGGER file_context_references_no_delete
    BEFORE DELETE ON file_context_references
    BEGIN
      SELECT RAISE(ABORT, 'file context references are immutable');
    END;

    CREATE TRIGGER file_reference_exclusions_no_update
    BEFORE UPDATE ON file_reference_exclusions
    BEGIN
      SELECT RAISE(ABORT, 'file reference exclusions are immutable');
    END;

    CREATE TRIGGER file_reference_exclusions_no_delete
    BEFORE DELETE ON file_reference_exclusions
    BEGIN
      SELECT RAISE(ABORT, 'file reference exclusions are immutable');
    END;
  `);
}
