PRAGMA foreign_keys = ON;

ALTER TABLE transactions ADD COLUMN customer_attested_country_code TEXT;
ALTER TABLE transactions ADD COLUMN customer_attested_state_code TEXT;
ALTER TABLE transactions ADD COLUMN customer_attested_postal_code TEXT;
ALTER TABLE transactions ADD COLUMN customer_attested_at TEXT;
ALTER TABLE transactions ADD COLUMN checkout_legal_gate_at TEXT;

DROP TRIGGER IF EXISTS transactions_require_verified_us_customer_insert;
DROP TRIGGER IF EXISTS transactions_require_verified_us_customer_update;

-- Transaction records may be prepared before customer attestation, but Checkout cannot be attached
-- until the customer has affirmatively attested a U.S. billing jurisdiction and the runtime legal gate passed.
CREATE TRIGGER IF NOT EXISTS transactions_checkout_requires_customer_attestation
BEFORE UPDATE OF stripe_checkout_session_id ON transactions
WHEN NEW.stripe_checkout_session_id IS NOT NULL
AND (
  upper(COALESCE(NEW.customer_attested_country_code,''))<>'US'
  OR NEW.customer_attested_state_code IS NULL
  OR length(NEW.customer_attested_state_code)<>2
  OR NEW.customer_attested_at IS NULL
  OR NEW.checkout_legal_gate_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'Stripe Checkout requires U.S. customer jurisdiction attestation and a completed legal checkout gate');
END;

-- Defense in depth: a transaction cannot become PROTECTED if it was never legally gated before Checkout.
CREATE TRIGGER IF NOT EXISTS transactions_protected_requires_checkout_legal_gate
BEFORE UPDATE OF record_classification ON transactions
WHEN NEW.record_classification='PROTECTED'
AND (
  upper(COALESCE(NEW.customer_attested_country_code,''))<>'US'
  OR NEW.customer_attested_state_code IS NULL
  OR NEW.customer_attested_at IS NULL
  OR NEW.checkout_legal_gate_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'PROTECTED requires customer U.S. jurisdiction attestation and pre-checkout legal clearance');
END;

CREATE INDEX IF NOT EXISTS idx_transactions_customer_attestation
  ON transactions(customer_attested_country_code,customer_attested_state_code,customer_attested_at,checkout_legal_gate_at);
