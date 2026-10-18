PRAGMA foreign_keys=ON;
-- Measures provider event timestamp vs receipt/processing, not guaranteed publication time.
CREATE TABLE IF NOT EXISTS processor_event_delivery_audit (
  processor TEXT NOT NULL CHECK(processor IN ('STRIPE','SQUARE')),
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_account_id TEXT,
  provider_event_created_at TEXT,
  received_at TEXT NOT NULL,
  last_delivery_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(outcome IN('RECEIVED','PROCESSED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts>0),
  last_error TEXT,
  PRIMARY KEY (processor,provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_event_delivery_audit_time
  ON processor_event_delivery_audit(processor,received_at,outcome);
