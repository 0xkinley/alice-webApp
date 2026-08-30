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
      UNIQUE (workspace_id, user_id, id)
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
      UNIQUE (workspace_id, name),
      UNIQUE (workspace_id, id)
    ) STRICT;

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
      client_id TEXT NOT NULL,
      client_classification TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
      FOREIGN KEY (workspace_id, connection_id)
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
      project_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      selection_version TEXT NOT NULL,
      selected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, user_id, connection_id)
        REFERENCES integration_connections(workspace_id, user_id, id),
      FOREIGN KEY (workspace_id, project_id, context_id)
        REFERENCES work_contexts(workspace_id, project_id, id)
    ) STRICT;

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
  `);
}
