PRAGMA foreign_keys=ON;
-- Merchant-request intake is durable. Email is notification, not the source of truth.
CREATE TABLE IF NOT EXISTS merchant_help_requests (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  created_by TEXT NOT NULL,
  topic TEXT NOT NULL CHECK(topic IN ('CONNECT_SOURCE','CUSTOM_FIELDS','BANK_ACCESS','TRANSACTION','BILLING','OTHER')),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 5 AND 140),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 20 AND 4000),
  source_system TEXT NOT NULL DEFAULT '' CHECK(length(source_system)<=100),
  desired_outcome TEXT NOT NULL DEFAULT '' CHECK(length(desired_outcome)<=500),
  example_reference TEXT NOT NULL DEFAULT '' CHECK(length(example_reference)<=120),
  request_status TEXT NOT NULL DEFAULT 'OPEN' CHECK(request_status IN ('OPEN','IN_REVIEW','RESOLVED')),
  delivery_state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(delivery_state IN ('QUEUED','SENT','ERROR','DISABLED')),
  email_attempts INTEGER NOT NULL DEFAULT 0 CHECK(email_attempts>=0),
  last_email_error TEXT,
  last_attempt_at TEXT,
  emailed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_merchant_help_by_tenant ON merchant_help_requests(merchant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_help_email_queue ON merchant_help_requests(delivery_state,created_at)
 WHERE delivery_state IN ('QUEUED','ERROR');
-- A sender is expected to deliver updates on its declared cadence. Delays are shown
-- as a status, not confused with the independent processor's payment status.
ALTER TABLE merchant_custom_sync_sources ADD COLUMN expected_interval_minutes INTEGER
 CHECK(expected_interval_minutes IS NULL OR
       (expected_interval_minutes>=5 AND expected_interval_minutes<=10080));
