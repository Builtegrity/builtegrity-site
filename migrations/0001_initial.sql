PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN ('HOUSE','REFERRAL','PLATFORM_INTEGRATION','OTHER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  processor TEXT NOT NULL DEFAULT 'STRIPE',
  processor_account_id TEXT,
  integration_mode TEXT NOT NULL DEFAULT 'STRIPE_CONNECT' CHECK (integration_mode IN ('STRIPE_CONNECT','STRIPE_APP','PARTNER_API','OTHER')),
  automatic_payouts_required INTEGER NOT NULL DEFAULT 1 CHECK (automatic_payouts_required IN (0,1)),
  status TEXT NOT NULL DEFAULT 'TEST' CHECK (status IN ('TEST','ACTIVE','PAUSED','DISCONNECTED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);
CREATE INDEX IF NOT EXISTS idx_merchants_partner ON merchants(partner_id);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  merchant_customer_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (id, merchant_id)
);
CREATE INDEX IF NOT EXISTS idx_customers_merchant ON customers(merchant_id);
CREATE INDEX IF NOT EXISTS idx_customers_merchant_email ON customers(merchant_id, email);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  merchant_reference TEXT,
  purchase_type TEXT,
  description TEXT NOT NULL,
  total_value_cents INTEGER CHECK (total_value_cents IS NULL OR total_value_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETE','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (customer_id, merchant_id) REFERENCES customers(id, merchant_id),
  UNIQUE (id, merchant_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_purchases_merchant ON purchases(merchant_id);
CREATE INDEX IF NOT EXISTS idx_purchases_customer ON purchases(customer_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  terms_version TEXT,
  terms_snapshot TEXT,
  refund_policy_snapshot TEXT,
  cancellation_policy_snapshot TEXT,
  consent_accepted INTEGER NOT NULL DEFAULT 0 CHECK (consent_accepted IN (0,1)),
  consent_accepted_at TEXT,
  consent_method TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'CREATED' CHECK (lifecycle_status IN ('CREATED','CONSENTED','PAYMENT_PENDING','PAID','PAYOUT_PENDING','COMPLETE')),
  integrity_status TEXT NOT NULL DEFAULT 'INCOMPLETE' CHECK (integrity_status IN ('INCOMPLETE','ACCOUNTED','NEEDS_ATTENTION')),
  exception_status TEXT NOT NULL DEFAULT 'NONE' CHECK (exception_status IN ('NONE','NEEDS_ATTENTION')),
  processor TEXT NOT NULL DEFAULT 'STRIPE',
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  stripe_balance_transaction_id TEXT,
  stripe_application_fee_id TEXT,
  stripe_payout_id TEXT,
  payment_status TEXT,
  payment_at TEXT,
  processor_payout_status TEXT,
  expected_payout_arrival TEXT,
  payout_accounted INTEGER NOT NULL DEFAULT 0 CHECK (payout_accounted IN (0,1)),
  customer_paid_cents INTEGER,
  processor_fee_cents INTEGER,
  integrity_fee_earned_cents INTEGER NOT NULL DEFAULT 0 CHECK (integrity_fee_earned_cents >= 0),
  fee_collection_method TEXT CHECK (fee_collection_method IS NULL OR fee_collection_method IN ('STRIPE_APPLICATION_FEE','AUTOMATIC_USAGE','PARTNER_SETTLEMENT','OTHER')),
  integrity_fee_collected_cents INTEGER NOT NULL DEFAULT 0 CHECK (integrity_fee_collected_cents >= 0),
  expected_merchant_net_cents INTEGER,
  actual_merchant_net_cents INTEGER,
  payout_batch_total_cents INTEGER,
  transaction_payout_contribution_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (customer_id, merchant_id) REFERENCES customers(id, merchant_id),
  FOREIGN KEY (purchase_id, merchant_id, customer_id) REFERENCES purchases(id, merchant_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_created ON transactions(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_purchase ON transactions(purchase_id);
CREATE INDEX IF NOT EXISTS idx_transactions_lifecycle ON transactions(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_transactions_integrity ON transactions(integrity_status);
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_payment_intent ON transactions(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_charge ON transactions(stripe_charge_id);
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_balance_transaction ON transactions(stripe_balance_transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_payout ON transactions(stripe_payout_id);

CREATE TABLE IF NOT EXISTS transaction_events (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('BUILTEGRITY','CUSTOMER','MERCHANT','STRIPE','PARTNER','SYSTEM')),
  source_event_id TEXT,
  event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_data_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_events_transaction_time ON transaction_events(transaction_id, event_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_event_id ON transaction_events(source, source_event_id) WHERE source_event_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS transaction_events_no_update
BEFORE UPDATE ON transaction_events
BEGIN
  SELECT RAISE(ABORT, 'transaction_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS transaction_events_no_delete
BEFORE DELETE ON transaction_events
BEGIN
  SELECT RAISE(ABORT, 'transaction_events are append-only');
END;

CREATE TABLE IF NOT EXISTS transaction_exceptions (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  exception_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  summary TEXT,
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_exceptions_transaction ON transaction_exceptions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_open ON transaction_exceptions(status, opened_at);

CREATE VIEW IF NOT EXISTS transaction_console AS
SELECT
  t.id AS transaction_id,
  t.created_at,
  ptn.id AS partner_id,
  ptn.name AS partner_name,
  m.id AS merchant_id,
  m.name AS merchant_name,
  c.id AS customer_id,
  c.name AS customer_name,
  p.id AS purchase_id,
  p.merchant_reference,
  t.transaction_type,
  t.description,
  t.amount_cents,
  t.currency,
  t.lifecycle_status,
  t.integrity_status,
  t.exception_status,
  t.processor,
  t.payment_status,
  t.processor_payout_status,
  t.integrity_fee_earned_cents,
  t.fee_collection_method
FROM transactions t
JOIN purchases p ON p.id = t.purchase_id
JOIN customers c ON c.id = t.customer_id
JOIN merchants m ON m.id = t.merchant_id
JOIN partners ptn ON ptn.id = m.partner_id;
