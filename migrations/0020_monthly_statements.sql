PRAGMA foreign_keys = ON;

ALTER TABLE merchants ADD COLUMN statement_email TEXT;
ALTER TABLE partners ADD COLUMN statement_email TEXT;

UPDATE merchants
SET statement_email = email
WHERE statement_email IS NULL AND email IS NOT NULL;

CREATE TABLE IF NOT EXISTS monthly_statements (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('MERCHANT','PARTNER')),
  scope_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end_exclusive TEXT NOT NULL,
  period_label TEXT NOT NULL,
  statement_version INTEGER NOT NULL DEFAULT 1 CHECK (statement_version >= 1),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','GENERATING','GENERATED','DELIVERY_PENDING','DELIVERED','AWAITING_RECIPIENT','FAILED')),
  transaction_count INTEGER NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  merchant_count INTEGER NOT NULL DEFAULT 0 CHECK (merchant_count >= 0),
  protected_volume_cents INTEGER NOT NULL DEFAULT 0,
  builtegrity_fee_cents INTEGER NOT NULL DEFAULT 0,
  exception_count INTEGER NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  accounted_count INTEGER NOT NULL DEFAULT 0 CHECK (accounted_count >= 0),
  object_key TEXT,
  pdf_sha256 TEXT,
  pdf_byte_length INTEGER CHECK (pdf_byte_length IS NULL OR pdf_byte_length >= 0),
  generated_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scope_type, scope_id, period_start, statement_version)
);
CREATE INDEX IF NOT EXISTS idx_monthly_statements_due
  ON monthly_statements(status, period_start, created_at);
CREATE INDEX IF NOT EXISTS idx_monthly_statements_scope
  ON monthly_statements(scope_type, scope_id, period_start DESC);

CREATE TABLE IF NOT EXISTS monthly_statement_items (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  customer_reference TEXT,
  purchase_reference TEXT,
  transaction_description TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  integrity_fee_cents INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT,
  payout_status TEXT,
  integrity_status TEXT NOT NULL,
  exception_status TEXT NOT NULL,
  payment_at TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (statement_id) REFERENCES monthly_statements(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE(statement_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_monthly_statement_items_statement
  ON monthly_statement_items(statement_id, merchant_id, transaction_id);

CREATE TABLE IF NOT EXISTS monthly_statement_deliveries (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','DELIVERED','RETRY','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  provider_message_id TEXT,
  delivered_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (statement_id) REFERENCES monthly_statements(id),
  UNIQUE(statement_id, recipient_email)
);
CREATE INDEX IF NOT EXISTS idx_monthly_statement_deliveries_due
  ON monthly_statement_deliveries(status, next_attempt_at, created_at);

CREATE TRIGGER IF NOT EXISTS monthly_statement_items_no_update
BEFORE UPDATE ON monthly_statement_items
BEGIN
  SELECT RAISE(ABORT, 'monthly_statement_items are immutable snapshots');
END;

CREATE TRIGGER IF NOT EXISTS monthly_statement_items_no_delete
BEFORE DELETE ON monthly_statement_items
BEGIN
  SELECT RAISE(ABORT, 'monthly_statement_items are immutable snapshots');
END;

CREATE TRIGGER IF NOT EXISTS monthly_statements_no_delete
BEFORE DELETE ON monthly_statements
BEGIN
  SELECT RAISE(ABORT, 'monthly_statements are permanent records');
END;

CREATE TRIGGER IF NOT EXISTS monthly_statements_snapshot_immutable
BEFORE UPDATE ON monthly_statements
WHEN OLD.generated_at IS NOT NULL AND (
  NEW.scope_type <> OLD.scope_type OR
  NEW.scope_id <> OLD.scope_id OR
  NEW.period_start <> OLD.period_start OR
  NEW.period_end_exclusive <> OLD.period_end_exclusive OR
  NEW.period_label <> OLD.period_label OR
  NEW.statement_version <> OLD.statement_version OR
  NEW.transaction_count <> OLD.transaction_count OR
  NEW.merchant_count <> OLD.merchant_count OR
  NEW.protected_volume_cents <> OLD.protected_volume_cents OR
  NEW.builtegrity_fee_cents <> OLD.builtegrity_fee_cents OR
  NEW.exception_count <> OLD.exception_count OR
  NEW.accounted_count <> OLD.accounted_count OR
  COALESCE(NEW.object_key, '') <> COALESCE(OLD.object_key, '') OR
  COALESCE(NEW.pdf_sha256, '') <> COALESCE(OLD.pdf_sha256, '') OR
  COALESCE(NEW.pdf_byte_length, -1) <> COALESCE(OLD.pdf_byte_length, -1) OR
  COALESCE(NEW.generated_at, '') <> COALESCE(OLD.generated_at, '')
)
BEGIN
  SELECT RAISE(ABORT, 'generated monthly statement snapshot is immutable');
END;
