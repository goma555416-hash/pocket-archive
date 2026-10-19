PRAGMA foreign_keys = ON;

-- Additive, D1 migration runner applies once; no original bytes or OAuth tokens.
CREATE TABLE IF NOT EXISTS capture_image_storage (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_images (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES shortcut_credentials(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('receiving','ready','completed','failed','expired')),
  file_id TEXT,
  job_id TEXT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  cleaned_at INTEGER,
  UNIQUE(credential_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS capture_image_one_upload ON capture_images(user_id) WHERE status='receiving';
CREATE INDEX IF NOT EXISTS capture_image_quota ON capture_images(user_id,created_at,status);
CREATE INDEX IF NOT EXISTS capture_image_cleanup ON capture_images(status,expires_at,cleaned_at);
