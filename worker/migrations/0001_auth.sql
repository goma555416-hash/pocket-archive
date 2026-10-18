PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  picture_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_cipher TEXT NOT NULL,
  access_token_cipher TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT NOT NULL,
  reauth_required INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  cookie_hash TEXT NOT NULL,
  verifier_cipher TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  previous_id_hash TEXT,
  previous_valid_until INTEGER,
  public_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  rotate_after INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX sessions_user_active ON sessions(user_id, revoked_at, last_seen_at DESC);
CREATE INDEX sessions_previous ON sessions(previous_id_hash);
CREATE INDEX oauth_attempts_expiry ON oauth_attempts(expires_at);
