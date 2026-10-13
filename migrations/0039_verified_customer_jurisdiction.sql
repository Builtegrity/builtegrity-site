PRAGMA foreign_keys = ON;

-- A default country must never be mistaken for verified jurisdiction evidence.
-- customers.state_code is introduced by the preceding jurisdiction-catalog migration.
ALTER TABLE customers ADD COLUMN postal_code TEXT;
ALTER TABLE customers ADD COLUMN jurisdiction_source TEXT NOT NULL DEFAULT 'UNVERIFIED'
  CHECK (jurisdiction_source IN ('UNVERIFIED','MERCHANT_INPUT','CUSTOMER_ATTESTATION','STRIPE_BILLING','MANUAL_REVIEW'));
ALTER TABLE customers ADD COLUMN jurisdiction_verified_at TEXT;
ALTER TABLE customers ADD COLUMN stripe_billing_country_code TEXT;
ALTER TABLE customers ADD COLUMN stripe_billing_state_code TEXT;
ALTER TABLE customers ADD COLUMN stripe_billing_postal_code TEXT;
ALTER TABLE customers ADD COLUMN jurisdiction_match_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
  CHECK (jurisdiction_match_status IN ('UNVERIFIED','MATCH','MISMATCH','REVIEW_REQUIRED'));

ALTER TABLE transactions ADD COLUMN legal_compliance_state TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (legal_compliance_state IN ('PENDING','CLEARED','VIOLATION','REVIEW_REQUIRED'));
ALTER TABLE transactions ADD COLUMN legal_compliance_reason TEXT;

-- A new protected-flow transaction cannot even be created for an unverified/non-US customer.
CREATE TRIGGER IF NOT EXISTS transactions_require_verified_us_customer_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification IN ('PENDING_PROTECTED','PROTECTED','FEE_EXCEPTION')
AND NOT EXISTS (
  SELECT 1 FROM customers c
   WHERE c.id=NEW.customer_id
     AND c.merchant_id=NEW.merchant_id
     AND c.country_code='US'
     AND c.jurisdiction_verified_at IS NOT NULL
     AND c.jurisdiction_source<>'UNVERIFIED'
     AND c.jurisdiction_match_status IN ('UNVERIFIED','MATCH')
)
BEGIN
  SELECT RAISE(ABORT,'Protected transaction requires affirmatively verified U.S. customer jurisdiction');
END;

CREATE TRIGGER IF NOT EXISTS transactions_require_verified_us_customer_update
BEFORE UPDATE OF customer_id,merchant_id,record_classification ON transactions
WHEN NEW.record_classification IN ('PENDING_PROTECTED','PROTECTED','FEE_EXCEPTION')
AND NOT EXISTS (
  SELECT 1 FROM customers c
   WHERE c.id=NEW.customer_id
     AND c.merchant_id=NEW.merchant_id
     AND c.country_code='US'
     AND c.jurisdiction_verified_at IS NOT NULL
     AND c.jurisdiction_source<>'UNVERIFIED'
     AND c.jurisdiction_match_status IN ('UNVERIFIED','MATCH')
)
BEGIN
  SELECT RAISE(ABORT,'Protected transaction requires affirmatively verified U.S. customer jurisdiction');
END;

-- Stripe billing evidence that contradicts the pre-check does not rewrite historical PROTECTED status.
-- Instead it creates a distinct legal-compliance violation requiring review.
CREATE TRIGGER IF NOT EXISTS customer_stripe_jurisdiction_mismatch
AFTER UPDATE OF stripe_billing_country_code,stripe_billing_state_code ON customers
WHEN NEW.stripe_billing_country_code IS NOT NULL
AND (
  upper(NEW.stripe_billing_country_code)<>'US'
  OR (NEW.state_code IS NOT NULL AND NEW.stripe_billing_state_code IS NOT NULL AND upper(NEW.state_code)<>upper(NEW.stripe_billing_state_code))
)
BEGIN
  UPDATE customers
     SET jurisdiction_match_status='MISMATCH'
   WHERE id=NEW.id;
  UPDATE transactions
     SET legal_compliance_state='VIOLATION',
         legal_compliance_reason='Stripe billing jurisdiction did not match the pre-verified U.S. customer jurisdiction.',
         updated_at=CURRENT_TIMESTAMP
   WHERE customer_id=NEW.id
     AND legal_compliance_state<>'VIOLATION';
END;

CREATE TRIGGER IF NOT EXISTS customer_stripe_jurisdiction_match
AFTER UPDATE OF stripe_billing_country_code,stripe_billing_state_code ON customers
WHEN upper(COALESCE(NEW.stripe_billing_country_code,''))='US'
AND (NEW.state_code IS NULL OR NEW.stripe_billing_state_code IS NULL OR upper(NEW.state_code)=upper(NEW.stripe_billing_state_code))
BEGIN
  UPDATE customers
     SET jurisdiction_match_status='MATCH',
         jurisdiction_source=CASE WHEN jurisdiction_source='UNVERIFIED' THEN 'STRIPE_BILLING' ELSE jurisdiction_source END,
         jurisdiction_verified_at=COALESCE(jurisdiction_verified_at,CURRENT_TIMESTAMP)
   WHERE id=NEW.id;
  UPDATE transactions
     SET legal_compliance_state=CASE WHEN legal_compliance_state='PENDING' THEN 'CLEARED' ELSE legal_compliance_state END,
         legal_compliance_reason=CASE WHEN legal_compliance_state='PENDING' THEN NULL ELSE legal_compliance_reason END,
         updated_at=CURRENT_TIMESTAMP
   WHERE customer_id=NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_customers_jurisdiction
  ON customers(country_code,state_code,jurisdiction_match_status,jurisdiction_verified_at);
CREATE INDEX IF NOT EXISTS idx_transactions_legal_compliance
  ON transactions(legal_compliance_state,created_at DESC);
