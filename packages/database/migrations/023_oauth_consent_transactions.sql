CREATE TABLE oauth_consent_transactions (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  oauth_state text,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  resource text NOT NULL,
  mcp_origin text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL,
  approved_user_id text REFERENCES users(id) ON DELETE CASCADE,
  approved_at timestamptz,
  CHECK ((approved_user_id IS NULL) = (approved_at IS NULL))
);

CREATE INDEX oauth_consent_transactions_expiry
  ON oauth_consent_transactions (expires_at);
