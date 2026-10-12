PRAGMA foreign_keys = ON;

ALTER TABLE transactions ADD COLUMN stripe_checkout_expires_at TEXT;

-- A single Stripe payment object must never be attached to two Builtegrity
-- transactions. Payout IDs are intentionally excluded because one automatic
-- payout can contain many transaction contributions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_unique_checkout_session
ON transactions(stripe_checkout_session_id)
WHERE stripe_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_unique_payment_intent
ON transactions(stripe_payment_intent_id)
WHERE stripe_payment_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_unique_charge
ON transactions(stripe_charge_id)
WHERE stripe_charge_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_unique_balance_transaction
ON transactions(stripe_balance_transaction_id)
WHERE stripe_balance_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_unique_application_fee
ON transactions(stripe_application_fee_id)
WHERE stripe_application_fee_id IS NOT NULL;
