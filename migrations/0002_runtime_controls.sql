PRAGMA foreign_keys = ON;

ALTER TABLE transactions ADD COLUMN terms_snapshot_sha256 TEXT;
ALTER TABLE transactions ADD COLUMN last_reconciled_at TEXT;

CREATE TABLE IF NOT EXISTS id_counters (
  prefix TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value > 0)
);

INSERT OR IGNORE INTO id_counters (prefix, next_value) VALUES
  ('PARTNER', 2),
  ('MER', 2),
  ('CUST', 2),
  ('PUR', 2),
  ('TX', 2),
  ('EVT', 2),
  ('EXC', 1);

CREATE TABLE IF NOT EXISTS stripe_webhook_receipts (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PROCESSING','PROCESSED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_receipts_status ON stripe_webhook_receipts(status, updated_at);

CREATE TABLE IF NOT EXISTS merchant_access (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','VIEWER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (merchant_id, external_user_id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_access_user ON merchant_access(external_user_id, status);

CREATE TABLE IF NOT EXISTS partner_access (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','VIEWER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id) REFERENCES partners(id),
  UNIQUE (partner_id, external_user_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_access_user ON partner_access(external_user_id, status);
