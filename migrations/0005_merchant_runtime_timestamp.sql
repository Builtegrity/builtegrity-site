ALTER TABLE merchants ADD COLUMN updated_at TEXT;
UPDATE merchants SET updated_at = created_at WHERE updated_at IS NULL;
