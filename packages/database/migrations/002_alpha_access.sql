CREATE TABLE alpha_invitations (
  id text PRIMARY KEY,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL,
  accepted_by_user_id text UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK ((accepted_by_user_id IS NULL) = (accepted_at IS NULL))
);

CREATE INDEX alpha_invitations_email_status_lookup
  ON alpha_invitations (lower(email), expires_at, accepted_at, revoked_at);
