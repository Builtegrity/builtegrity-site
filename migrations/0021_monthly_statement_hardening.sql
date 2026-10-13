PRAGMA foreign_keys = ON;

ALTER TABLE monthly_statements ADD COLUMN snapshot_json TEXT;
ALTER TABLE monthly_statements ADD COLUMN snapshot_sha256 TEXT;
ALTER TABLE monthly_statements ADD COLUMN source_as_of TEXT;
ALTER TABLE monthly_statements ADD COLUMN generation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monthly_statements ADD COLUMN next_generation_attempt_at TEXT;

CREATE INDEX IF NOT EXISTS idx_monthly_statements_generation_retry
  ON monthly_statements(status, next_generation_attempt_at, updated_at);

CREATE TRIGGER IF NOT EXISTS monthly_statements_payload_immutable
BEFORE UPDATE ON monthly_statements
WHEN OLD.snapshot_json IS NOT NULL AND (
  COALESCE(NEW.snapshot_json, '') <> COALESCE(OLD.snapshot_json, '') OR
  COALESCE(NEW.snapshot_sha256, '') <> COALESCE(OLD.snapshot_sha256, '') OR
  COALESCE(NEW.source_as_of, '') <> COALESCE(OLD.source_as_of, '')
)
BEGIN
  SELECT RAISE(ABORT, 'monthly statement source snapshot is immutable');
END;
