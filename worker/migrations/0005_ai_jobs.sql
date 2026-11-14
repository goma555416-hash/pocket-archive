PRAGMA foreign_keys = ON;

-- Bearer credentials for the Claude cloud routine (scope ai:agent).
CREATE TABLE ai_agent_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX ai_agent_credentials_user ON ai_agent_credentials(user_id, revoked_at, created_at DESC);

CREATE TABLE ai_agent_rate_limits (
  credential_id TEXT NOT NULL REFERENCES ai_agent_credentials(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (credential_id, window_start)
);

-- Cloud AI organize jobs. Holds routing IDs, hashes and status only:
-- never collection URLs, notes or attachment hashes.
CREATE TABLE ai_jobs (
  export_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inbox_file_id TEXT NOT NULL,
  result_file_id TEXT NOT NULL,
  inbox_folder_id TEXT NOT NULL,
  results_folder_id TEXT NOT NULL,
  item_ids TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  inbox_sha256 TEXT NOT NULL,
  pending_sha256 TEXT NOT NULL,
  inbox_md5 TEXT,
  inbox_version TEXT,
  result_md5 TEXT,
  result_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','ready','failed','applied')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  failure_message TEXT,
  session_url TEXT,
  created_by_device TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX ai_jobs_user_status ON ai_jobs(user_id, status, created_at);
