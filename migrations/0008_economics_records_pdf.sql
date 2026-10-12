PRAGMA foreign_keys = ON;

-- Clerk is identity only. D1 remains authoritative for merchant tenancy/roles via merchant_access.
-- Public customers continue to use opaque transaction access tokens and never require Clerk membership.

ALTER TABLE transactions ADD COLUMN fee_payer TEXT NOT NULL DEFAULT 'MERCHANT'
  CHECK (fee_payer = 'MERCHANT');
ALTER TABLE transactions ADD COLUMN record_access_token TEXT;
ALTER TABLE transactions ADD COLUMN record_access_expires_at TEXT;

-- Existing records receive an unguessable access token without requiring a customer identity-provider account.
UPDATE transactions
SET record_access_token = COALESCE(payment_access_token, lower(hex(randomblob(24))))
WHERE record_access_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_record_access_token
  ON transactions(record_access_token)
  WHERE record_access_token IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS transactions_assign_record_access_token
AFTER INSERT ON transactions
WHEN NEW.record_access_token IS NULL
BEGIN
  UPDATE transactions
     SET record_access_token = COALESCE(NEW.payment_access_token, lower(hex(randomblob(24))))
   WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS transaction_cost_models (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  core_infra_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (core_infra_cost_micros >= 0),
  email_cost_micros_per_message INTEGER NOT NULL DEFAULT 0 CHECK (email_cost_micros_per_message >= 0),
  assumed_email_messages INTEGER NOT NULL DEFAULT 0 CHECK (assumed_email_messages >= 0),
  lifetime_storage_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_storage_cost_micros >= 0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- $1.00 = 1,000,000 micros. This preserves sub-cent precision.
-- Conservative V1 technical COGS estimate: ~$0.000043 core infra + 2 x $0.0009 email + ~$0.000751 lifetime storage.
INSERT OR IGNORE INTO transaction_cost_models (
  id, status, core_infra_cost_micros, email_cost_micros_per_message,
  assumed_email_messages, lifetime_storage_cost_micros, notes
) VALUES (
  'COST-2026-10-V1', 'ACTIVE', 43, 900, 2, 751,
  'Initial conservative V1 technical COGS model. Estimated amounts must remain distinguishable from actual cost entries.'
);

CREATE TABLE IF NOT EXISTS transaction_economics_ledger (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('REVENUE','COST','ADJUSTMENT','PARTNER_SHARE')),
  category TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('ESTIMATED','ACTUAL')),
  quantity REAL,
  unit_cost_micros INTEGER,
  cost_model_id TEXT,
  source_ref TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (cost_model_id) REFERENCES transaction_cost_models(id)
);
CREATE INDEX IF NOT EXISTS idx_economics_transaction
  ON transaction_economics_ledger(transaction_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_economics_source_ref
  ON transaction_economics_ledger(transaction_id, entry_kind, category, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE VIEW IF NOT EXISTS transaction_economics_summary AS
SELECT
  t.id AS transaction_id,
  t.merchant_id,
  t.amount_cents,
  t.integrity_fee_earned_cents,
  t.integrity_fee_collected_cents,
  t.fee_payer,
  COALESCE(SUM(CASE WHEN e.basis = 'ESTIMATED' AND e.entry_kind = 'REVENUE' THEN e.amount_micros ELSE 0 END), 0) AS estimated_revenue_micros,
  COALESCE(SUM(CASE WHEN e.basis = 'ESTIMATED' AND e.entry_kind IN ('COST','PARTNER_SHARE') THEN e.amount_micros ELSE 0 END), 0) AS estimated_cost_micros,
  COALESCE(SUM(CASE WHEN e.basis = 'ESTIMATED' AND e.entry_kind = 'ADJUSTMENT' THEN e.amount_micros ELSE 0 END), 0) AS estimated_adjustment_micros,
  COALESCE(SUM(CASE WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'REVENUE' THEN e.amount_micros ELSE 0 END), 0) AS actual_revenue_micros,
  COALESCE(SUM(CASE WHEN e.basis = 'ACTUAL' AND e.entry_kind IN ('COST','PARTNER_SHARE') THEN e.amount_micros ELSE 0 END), 0) AS actual_cost_micros,
  COALESCE(SUM(CASE WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'ADJUSTMENT' THEN e.amount_micros ELSE 0 END), 0) AS actual_adjustment_micros,
  COALESCE(SUM(CASE
    WHEN e.basis = 'ESTIMATED' AND e.entry_kind = 'REVENUE' THEN e.amount_micros
    WHEN e.basis = 'ESTIMATED' AND e.entry_kind IN ('COST','PARTNER_SHARE') THEN -e.amount_micros
    WHEN e.basis = 'ESTIMATED' AND e.entry_kind = 'ADJUSTMENT' THEN e.amount_micros
    ELSE 0 END), 0) AS estimated_contribution_micros,
  COALESCE(SUM(CASE
    WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'REVENUE' THEN e.amount_micros
    WHEN e.basis = 'ACTUAL' AND e.entry_kind IN ('COST','PARTNER_SHARE') THEN -e.amount_micros
    WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'ADJUSTMENT' THEN e.amount_micros
    ELSE 0 END), 0) AS actual_contribution_micros
FROM transactions t
LEFT JOIN transaction_economics_ledger e ON e.transaction_id = t.id
GROUP BY t.id;

-- Every transaction gets a hidden unit-economics layer automatically. No application call is required.
CREATE TRIGGER IF NOT EXISTS transactions_initialize_economics
AFTER INSERT ON transactions
BEGIN
  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, source_ref, details_json)
  VALUES
    ('ECO_EST_REV_' || NEW.id, NEW.id, 'REVENUE', 'INTEGRITY_FEE', NEW.integrity_fee_earned_cents * 10000,
     'ESTIMATED', 'initial:integrity-fee', '{"fee_payer":"MERCHANT"}');

  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, quantity, unit_cost_micros, cost_model_id, source_ref)
  SELECT
    'ECO_EST_CORE_' || NEW.id, NEW.id, 'COST', 'CORE_INFRASTRUCTURE', core_infra_cost_micros,
    'ESTIMATED', 1, core_infra_cost_micros, id, 'initial:core-infrastructure'
  FROM transaction_cost_models WHERE status = 'ACTIVE' ORDER BY created_at DESC, id DESC LIMIT 1;

  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, quantity, unit_cost_micros, cost_model_id, source_ref)
  SELECT
    'ECO_EST_EMAIL_' || NEW.id, NEW.id, 'COST', 'TRANSACTION_EMAIL_BUDGET', email_cost_micros_per_message * assumed_email_messages,
    'ESTIMATED', assumed_email_messages, email_cost_micros_per_message, id, 'initial:transaction-email-budget'
  FROM transaction_cost_models WHERE status = 'ACTIVE' ORDER BY created_at DESC, id DESC LIMIT 1;

  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, quantity, unit_cost_micros, cost_model_id, source_ref)
  SELECT
    'ECO_EST_STORAGE_' || NEW.id, NEW.id, 'COST', 'LIFETIME_STORAGE', lifetime_storage_cost_micros,
    'ESTIMATED', 1, lifetime_storage_cost_micros, id, 'initial:lifetime-storage'
  FROM transaction_cost_models WHERE status = 'ACTIVE' ORDER BY created_at DESC, id DESC LIMIT 1;
END;

-- Backfill hidden economics for transactions that predate this migration.
INSERT OR IGNORE INTO transaction_economics_ledger
  (id, transaction_id, entry_kind, category, amount_micros, basis, source_ref, details_json)
SELECT 'ECO_EST_REV_' || id, id, 'REVENUE', 'INTEGRITY_FEE', integrity_fee_earned_cents * 10000,
       'ESTIMATED', 'initial:integrity-fee', '{"fee_payer":"MERCHANT"}'
FROM transactions;

INSERT OR IGNORE INTO transaction_economics_ledger
  (id, transaction_id, entry_kind, category, amount_micros, basis, quantity, unit_cost_micros, cost_model_id, source_ref)
SELECT 'ECO_EST_CORE_' || t.id, t.id, 'COST', 'CORE_INFRASTRUCTURE', m.core_infra_cost_micros,
       'ESTIMATED', 1, m.core_infra_cost_micros, m.id, 'initial:core-infrastructure'
FROM transactions t JOIN transaction_cost_models m ON m.status = 'ACTIVE';

INSERT OR IGNORE INTO transaction_economics_ledger
  (id, transaction_id, entry_kind, category, amount_micros, basis, quantity, unit_cost_micros, cost_model_id, source_ref)
SELECT 'ECO_EST_EMAIL_' || t.id, t.id, 'COST', 'TRANSACTION_EMAIL_BUDGET', m.email_cost_micros_per_message * m.assumed_email_messages,
       'ESTIMATED', m.assumed_email_messages, m.email_cost_micros_per_message, m.id, 'initial:transaction-email-budget'
FROM transactions t JOIN transaction_cost_models m ON m.status = 'ACTIVE';

INSERT OR IGNORE INTO transaction_economics_ledger
  (id, transaction_id, entry_kind, category, amount_micros, basis, quantity, unit_cost_micros, cost_model_id, source_ref)
SELECT 'ECO_EST_STORAGE_' || t.id, t.id, 'COST', 'LIFETIME_STORAGE', m.lifetime_storage_cost_micros,
       'ESTIMATED', 1, m.lifetime_storage_cost_micros, m.id, 'initial:lifetime-storage'
FROM transactions t JOIN transaction_cost_models m ON m.status = 'ACTIVE';

-- Stripe's recorded application fee automatically becomes actual Builtegrity revenue.
CREATE TRIGGER IF NOT EXISTS transactions_record_actual_fee_increase
AFTER UPDATE OF integrity_fee_collected_cents ON transactions
WHEN NEW.integrity_fee_collected_cents > OLD.integrity_fee_collected_cents
BEGIN
  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, source_ref, details_json)
  VALUES (
    'ECO_ACT_REV_' || NEW.id || '_' || NEW.integrity_fee_collected_cents,
    NEW.id,
    'REVENUE',
    'INTEGRITY_FEE',
    (NEW.integrity_fee_collected_cents - OLD.integrity_fee_collected_cents) * 10000,
    'ACTUAL',
    'fee-collected:' || NEW.integrity_fee_collected_cents,
    '{"fee_payer":"MERCHANT","source":"processor_application_fee"}'
  );
END;

CREATE TRIGGER IF NOT EXISTS transactions_record_actual_fee_decrease
AFTER UPDATE OF integrity_fee_collected_cents ON transactions
WHEN NEW.integrity_fee_collected_cents < OLD.integrity_fee_collected_cents
BEGIN
  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, source_ref, details_json)
  VALUES (
    'ECO_ACT_ADJ_' || NEW.id || '_' || NEW.integrity_fee_collected_cents,
    NEW.id,
    'ADJUSTMENT',
    'INTEGRITY_FEE_ADJUSTMENT',
    -((OLD.integrity_fee_collected_cents - NEW.integrity_fee_collected_cents) * 10000),
    'ACTUAL',
    'fee-adjusted:' || NEW.integrity_fee_collected_cents,
    '{"fee_payer":"MERCHANT","source":"processor_adjustment"}'
  );
END;

CREATE TABLE IF NOT EXISTS transaction_pdf_requests (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('CUSTOMER_TOKEN','MERCHANT','OPERATOR','SYSTEM')),
  requested_by_ref TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','GENERATED','FAILED')),
  cache_hit INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0,1)),
  object_key TEXT,
  byte_length INTEGER,
  error_message TEXT,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  generated_at TEXT,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_pdf_requests_transaction
  ON transaction_pdf_requests(transaction_id, requested_at DESC);

INSERT OR IGNORE INTO id_counters (prefix, next_value) VALUES
  ('ECO', 1),
  ('PDF', 1);
