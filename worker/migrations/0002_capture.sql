PRAGMA foreign_keys = ON;

CREATE TABLE shortcut_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX shortcut_credentials_user ON shortcut_credentials(user_id, revoked_at, created_at DESC);

CREATE TABLE capture_rate_limits (
  credential_id TEXT NOT NULL REFERENCES shortcut_credentials(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (credential_id, window_start)
);

CREATE TABLE capture_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES shortcut_credentials(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  original_url TEXT NOT NULL,
  shared_text TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ios-shortcut',
  status TEXT NOT NULL CHECK (status IN ('pending','leased','completed','failed','expired')),
  result TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT,
  UNIQUE (credential_id, idempotency_key)
);

CREATE INDEX capture_jobs_claim ON capture_jobs(user_id, status, lease_expires_at, created_at);
CREATE INDEX capture_jobs_url ON capture_jobs(user_id, canonical_url, created_at DESC);
