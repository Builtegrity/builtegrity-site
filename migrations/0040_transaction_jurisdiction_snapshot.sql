PRAGMA foreign_keys = ON;

ALTER TABLE transactions ADD COLUMN stripe_billing_country_code TEXT;
ALTER TABLE transactions ADD COLUMN stripe_billing_state_code TEXT;
ALTER TABLE transactions ADD COLUMN stripe_billing_postal_code TEXT;
ALTER TABLE transactions ADD COLUMN jurisdiction_reconciled_at TEXT;

DROP TRIGGER IF EXISTS customer_stripe_jurisdiction_mismatch;
DROP TRIGGER IF EXISTS customer_stripe_jurisdiction_match;

-- Reconcile the actual processor billing jurisdiction against the pre-payment customer record.
-- A mismatch is a legal/compliance exception; it does not rewrite the historical PROTECTED fee state.
CREATE TRIGGER IF NOT EXISTS transaction_stripe_jurisdiction_mismatch
AFTER UPDATE OF stripe_billing_country_code,stripe_billing_state_code ON transactions
WHEN NEW.stripe_billing_country_code IS NOT NULL
AND EXISTS (
  SELECT 1 FROM customers c
   WHERE c.id=NEW.customer_id
     AND (
       upper(NEW.stripe_billing_country_code)<>'US'
       OR (c.state_code IS NOT NULL AND NEW.stripe_billing_state_code IS NOT NULL
           AND upper(c.state_code)<>upper(NEW.stripe_billing_state_code))
     )
)
BEGIN
  UPDATE transactions
     SET legal_compliance_state='VIOLATION',
         legal_compliance_reason='Stripe billing jurisdiction did not match the pre-verified U.S. customer jurisdiction.',
         jurisdiction_reconciled_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP
   WHERE id=NEW.id;
  UPDATE customers
     SET stripe_billing_country_code=NEW.stripe_billing_country_code,
         stripe_billing_state_code=NEW.stripe_billing_state_code,
         stripe_billing_postal_code=NEW.stripe_billing_postal_code,
         jurisdiction_match_status='MISMATCH'
   WHERE id=NEW.customer_id;
END;

CREATE TRIGGER IF NOT EXISTS transaction_stripe_jurisdiction_match
AFTER UPDATE OF stripe_billing_country_code,stripe_billing_state_code ON transactions
WHEN upper(COALESCE(NEW.stripe_billing_country_code,''))='US'
AND EXISTS (
  SELECT 1 FROM customers c
   WHERE c.id=NEW.customer_id
     AND (c.state_code IS NULL OR NEW.stripe_billing_state_code IS NULL OR upper(c.state_code)=upper(NEW.stripe_billing_state_code))
)
BEGIN
  UPDATE transactions
     SET legal_compliance_state=CASE WHEN legal_compliance_state='PENDING' THEN 'CLEARED' ELSE legal_compliance_state END,
         legal_compliance_reason=CASE WHEN legal_compliance_state='PENDING' THEN NULL ELSE legal_compliance_reason END,
         jurisdiction_reconciled_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP
   WHERE id=NEW.id;
  UPDATE customers
     SET stripe_billing_country_code=NEW.stripe_billing_country_code,
         stripe_billing_state_code=NEW.stripe_billing_state_code,
         stripe_billing_postal_code=NEW.stripe_billing_postal_code,
         jurisdiction_match_status='MATCH',
         jurisdiction_verified_at=COALESCE(jurisdiction_verified_at,CURRENT_TIMESTAMP)
   WHERE id=NEW.customer_id;
END;

CREATE INDEX IF NOT EXISTS idx_transactions_stripe_jurisdiction
  ON transactions(stripe_billing_country_code,stripe_billing_state_code,legal_compliance_state);
