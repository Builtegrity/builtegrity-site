PRAGMA foreign_keys=ON;
-- Each custom field has an explicit update mode and optional merchant-owned sending source.
-- An AUTO field is only updated by its designated source, never by arbitrary files.
ALTER TABLE merchant_custom_field_definitions ADD COLUMN update_mode TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK(update_mode IN ('MANUAL','AUTO'));
ALTER TABLE merchant_custom_field_definitions ADD COLUMN preferred_source_id TEXT;
CREATE INDEX IF NOT EXISTS idx_custom_field_sync_preference
 ON merchant_custom_field_definitions(merchant_id,update_mode,preferred_source_id);

-- Source health means successful contact, not a guarantee that a third party has new data.
ALTER TABLE merchant_custom_sync_sources ADD COLUMN last_heartbeat_at TEXT;

CREATE TABLE IF NOT EXISTS merchant_help_requests (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  created_by TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN ('INTEGRATION','FIELD_MAPPING','IMPORT_ISSUE','BANK_ACCESS','OTHER')),
  service_name TEXT NOT NULL CHECK(length(service_name) BETWEEN 1 AND 100),
  details TEXT NOT NULL CHECK(length(details) BETWEEN 15 AND 3000),
  desired_fields TEXT CHECK(desired_fields IS NULL OR length(desired_fields)<=500),
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK(status IN ('RECEIVED','IN_REVIEW','WAITING_ON_MERCHANT','CLOSED')),
  email_status TEXT NOT NULL DEFAULT 'NOT_SENT'
    CHECK(email_status IN ('NOT_SENT','SENT','ERROR')),
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  last_notification_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_help_merchant_recent
 ON merchant_help_requests(merchant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_help_email_retry
 ON merchant_help_requests(email_status,notification_attempts,created_at);
