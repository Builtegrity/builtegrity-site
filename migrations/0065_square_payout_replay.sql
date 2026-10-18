PRAGMA foreign_keys=ON;
-- Durable payout-entry facts tolerate webhooks arriving in either order.
-- Entry facts persist independently of whether a matching Builtegrity payment exists yet.
CREATE TABLE IF NOT EXISTS square_payout_entry_facts (
  payout_entry_id TEXT PRIMARY KEY,
  processor_merchant_id TEXT NOT NULL,
  processor_payment_id TEXT NOT NULL,
  payout_id TEXT NOT NULL,
  payout_status TEXT NOT NULL CHECK (payout_status IN ('PAID','FAILED')),
  net_cents INTEGER NOT NULL CHECK(net_cents>=0),
  currency TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_square_payout_entry_payment
  ON square_payout_entry_facts(processor_merchant_id,processor_payment_id);
