PRAGMA foreign_keys = ON;

ALTER TABLE monthly_statement_deliveries ADD COLUMN provider_status TEXT;
ALTER TABLE monthly_statement_deliveries ADD COLUMN provider_last_event_at TEXT;
ALTER TABLE monthly_statement_deliveries ADD COLUMN provider_message_id_header TEXT;

CREATE INDEX IF NOT EXISTS idx_statement_delivery_provider_message
  ON monthly_statement_deliveries(provider_message_id);

CREATE TABLE IF NOT EXISTS monthly_statement_email_events (
  event_id TEXT PRIMARY KEY,
  provider_message_id TEXT,
  event_type TEXT NOT NULL,
  recipient_email TEXT,
  event_created_at TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_statement_email_events_message
  ON monthly_statement_email_events(provider_message_id, event_created_at);

CREATE TRIGGER IF NOT EXISTS monthly_statement_email_events_no_update
BEFORE UPDATE ON monthly_statement_email_events
BEGIN
  SELECT RAISE(ABORT, 'monthly_statement_email_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS monthly_statement_email_events_no_delete
BEFORE DELETE ON monthly_statement_email_events
BEGIN
  SELECT RAISE(ABORT, 'monthly_statement_email_events are append-only');
END;
