PRAGMA foreign_keys = ON;

CREATE TABLE owner_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  google_sub TEXT NOT NULL UNIQUE,
  bound_at INTEGER NOT NULL,
  binding_method TEXT NOT NULL CHECK (binding_method IN ('bootstrap'))
);

CREATE TABLE owner_bootstrap_grants (
  grant_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX owner_bootstrap_expiry ON owner_bootstrap_grants(expires_at);

CREATE TABLE security_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX security_rate_limits_updated ON security_rate_limits(updated_at);

ALTER TABLE oauth_attempts ADD COLUMN owner_grant_hash TEXT;
ALTER TABLE sessions ADD COLUMN rotation_token_cipher TEXT;
