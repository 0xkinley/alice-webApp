import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(filename) {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }

  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret_hash TEXT,
      client_name TEXT NOT NULL,
      redirect_uris_json TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brief TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, name)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS evidence_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      exact_payload_json TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_classification TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (client_id, project_id, idempotency_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS candidate_claims (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      evidence_id TEXT NOT NULL REFERENCES evidence_events(id),
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS accepted_project_state (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      candidate_id TEXT NOT NULL UNIQUE REFERENCES candidate_claims(id),
      evidence_id TEXT NOT NULL REFERENCES evidence_events(id),
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      accepted_at TEXT NOT NULL,
      UNIQUE (project_id, state_key, version)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      safe_metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS evidence_events_no_update
    BEFORE UPDATE ON evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'evidence events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS evidence_events_no_delete
    BEFORE DELETE ON evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'evidence events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_events_no_update
    BEFORE UPDATE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
    BEFORE DELETE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are append-only');
    END;
  `);

  database
    .prepare(
      `INSERT OR IGNORE INTO projects (id, workspace_id, name, brief, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "project_switchboard_launch",
      "workspace_spike-user",
      "Switchboard Launch",
      "Define the launch position and first onboarding experiment for alice., the independent project intelligence layer for people who use more than one AI on the same project.",
      new Date().toISOString(),
    );

  return database;
}
