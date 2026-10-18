
-- Additional, independent processor connections. Stripe legacy columns remain valid during migration.
-- A merchant can have exactly one active connection per processor in V1.
CREATE TABLE IF NOT EXISTS merchant_processor_connections (
 id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
 processor TEXT NOT NULL CHECK (processor IN ('STRIPE','SQUARE')),
 external_account_id TEXT NOT NULL, location_id TEXT,
 status TEXT NOT NULL DEFAULT 'TEST' CHECK (status IN ('TEST','ACTIVE','PAUSED','DISCONNECTED')),
 scopes TEXT, encrypted_access_token TEXT, encrypted_refresh_token TEXT,
 access_expires_at TEXT, connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(merchant_id, processor), UNIQUE(processor,external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_processor_connections_merchant ON merchant_processor_connections(merchant_id);

CREATE TABLE IF NOT EXISTS square_oauth_states (
 state_token TEXT PRIMARY KEY,
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 expires_at TEXT NOT NULL, consumed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_square_oauth_expiry ON square_oauth_states(expires_at);

-- Retain processor-neutral identifiers alongside legacy Stripe columns.
ALTER TABLE transactions ADD COLUMN processor_checkout_id TEXT;
ALTER TABLE transactions ADD COLUMN processor_checkout_url TEXT;
ALTER TABLE transactions ADD COLUMN processor_order_id TEXT;
ALTER TABLE transactions ADD COLUMN processor_payment_id TEXT;
ALTER TABLE transactions ADD COLUMN processor_payout_id TEXT;
ALTER TABLE transactions ADD COLUMN processor_app_fee_requested_cents INTEGER NOT NULL DEFAULT 0 CHECK(processor_app_fee_requested_cents>=0);
ALTER TABLE transactions ADD COLUMN processor_app_fee_confirmed_cents INTEGER NOT NULL DEFAULT 0 CHECK(processor_app_fee_confirmed_cents>=0);
ALTER TABLE transactions ADD COLUMN processor_checkout_claimed_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_processor_checkout ON transactions(processor,processor_checkout_id) WHERE processor_checkout_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_processor_order ON transactions(processor,processor_order_id) WHERE processor_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_processor_payment ON transactions(processor,processor_payment_id) WHERE processor_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_processor_payout ON transactions(processor,processor_payout_id);

CREATE TABLE IF NOT EXISTS processor_webhook_deliveries (
 processor TEXT NOT NULL CHECK (processor IN ('STRIPE','SQUARE')),
 event_id TEXT NOT NULL, event_type TEXT NOT NULL,
 first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 processed_at TEXT, last_error TEXT,
 attempt_count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (processor,event_id)
);

-- Square checkout is subject to the *same* recorded customer, legal and fee-policy
-- clearances as Stripe, even if called by another future runtime path.
CREATE TRIGGER IF NOT EXISTS square_checkout_requires_legal_gate
BEFORE UPDATE OF processor_checkout_id ON transactions
WHEN NEW.processor='SQUARE' AND NEW.processor_checkout_id IS NOT NULL AND (
 NEW.consent_accepted<>1 OR NEW.customer_attested_country_code<>'US'
 OR NEW.customer_attested_state_code IS NULL OR NEW.customer_attested_at IS NULL
 OR NEW.checkout_legal_gate_at IS NULL OR NEW.fee_refund_rule_locked_at IS NULL
 OR NEW.merchant_fee_policy_acceptance_id IS NULL
)
BEGIN SELECT RAISE(ABORT,'Square Checkout requires pre-checkout legal and fee-policy clearance'); END;
