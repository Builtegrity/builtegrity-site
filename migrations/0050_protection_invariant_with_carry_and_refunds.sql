PRAGMA foreign_keys = ON;

-- PROTECTED is historical proof that the payment succeeded through the controlled route with
-- the correct application fee. The processor's current net fee cash may later fall because of
-- an authorized platform-fault credit; merchant/customer refunds must not erase protection.
-- Fractional carry is previously earned revenue, so the correct application fee for a later
-- checkout is current transaction whole cents + reserved prior carry cents.

DROP TRIGGER IF EXISTS transactions_protected_requires_successful_fee_insert;
DROP TRIGGER IF EXISTS transactions_protected_requires_successful_fee_update;
DROP TRIGGER IF EXISTS transactions_confirm_protected_after_processor_truth;
DROP TRIGGER IF EXISTS transactions_flag_fee_exception_after_processor_truth;

CREATE TRIGGER transactions_protected_requires_successful_fee_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification='PROTECTED'
AND (
  NEW.payment_at IS NULL
  OR COALESCE(NEW.fee_collection_method,'')<>'STRIPE_APPLICATION_FEE'
  OR NEW.stripe_application_fee_id IS NULL
  OR COALESCE(NEW.application_fee_gross_confirmed_cents,0)<=0
  OR COALESCE(NEW.application_fee_gross_confirmed_cents,0) <>
     (COALESCE(NEW.integrity_fee_earned_cents,0)+COALESCE(NEW.pricing_carry_reserved_cents,0))
  OR COALESCE(NEW.bg_fee_earned_cents,0) <> COALESCE(NEW.application_fee_gross_confirmed_cents,0)
)
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED requires payment-success evidence and exact gross Builtegrity application-fee confirmation including earned carry');
END;

CREATE TRIGGER transactions_protected_requires_successful_fee_update
BEFORE UPDATE OF record_classification,bg_fee_earned_cents,payment_at,stripe_application_fee_id,
                 application_fee_gross_confirmed_cents,integrity_fee_earned_cents,pricing_carry_reserved_cents
ON transactions
WHEN NEW.record_classification='PROTECTED'
AND (
  NEW.payment_at IS NULL
  OR COALESCE(NEW.fee_collection_method,'')<>'STRIPE_APPLICATION_FEE'
  OR NEW.stripe_application_fee_id IS NULL
  OR COALESCE(NEW.application_fee_gross_confirmed_cents,0)<=0
  OR COALESCE(NEW.application_fee_gross_confirmed_cents,0) <>
     (COALESCE(NEW.integrity_fee_earned_cents,0)+COALESCE(NEW.pricing_carry_reserved_cents,0))
  OR COALESCE(NEW.bg_fee_earned_cents,0) <> COALESCE(NEW.application_fee_gross_confirmed_cents,0)
)
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED requires payment-success evidence and exact gross Builtegrity application-fee confirmation including earned carry');
END;

-- Gross processor fee truth, rather than mutable current net cash, establishes protection.
-- This lets later merchant refunds/disputes and authorized platform credits be recorded without
-- rewriting the historical fact that the transaction originally met the protection contract.
CREATE TRIGGER transactions_confirm_protected_after_processor_truth
AFTER UPDATE OF payment_at,stripe_application_fee_id,application_fee_gross_confirmed_cents,
                integrity_fee_earned_cents,pricing_carry_reserved_cents
ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED')
AND NEW.payment_at IS NOT NULL
AND NEW.fee_collection_method='STRIPE_APPLICATION_FEE'
AND NEW.stripe_application_fee_id IS NOT NULL
AND NEW.application_fee_gross_confirmed_cents>0
AND NEW.application_fee_gross_confirmed_cents =
    (NEW.integrity_fee_earned_cents+COALESCE(NEW.pricing_carry_reserved_cents,0))
BEGIN
  UPDATE transactions
     SET record_classification='PROTECTED',
         bg_fee_earned_cents=NEW.application_fee_gross_confirmed_cents,
         protection_confirmed_at=COALESCE(protection_confirmed_at,CURRENT_TIMESTAMP),
         protection_failure_reason=NULL,
         updated_at=CURRENT_TIMESTAMP
   WHERE id=NEW.id;
END;

CREATE TRIGGER transactions_flag_fee_exception_after_processor_truth
AFTER UPDATE OF payment_at,stripe_application_fee_id,application_fee_gross_confirmed_cents,
                integrity_fee_earned_cents,pricing_carry_reserved_cents
ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED','PROTECTED')
AND NEW.payment_at IS NOT NULL
AND NEW.fee_collection_method='STRIPE_APPLICATION_FEE'
AND NEW.integrity_fee_earned_cents>0
AND (
  NEW.stripe_application_fee_id IS NULL
  OR (
    NEW.application_fee_gross_confirmed_cents>0
    AND NEW.application_fee_gross_confirmed_cents <>
        (NEW.integrity_fee_earned_cents+COALESCE(NEW.pricing_carry_reserved_cents,0))
  )
)
BEGIN
  UPDATE transactions
     SET record_classification='FEE_EXCEPTION',
         bg_fee_earned_cents=0,
         protection_confirmed_at=NULL,
         protection_failure_reason=CASE
           WHEN NEW.stripe_application_fee_id IS NULL
             THEN 'Successful payment did not expose the required Builtegrity application fee.'
           ELSE 'Gross Builtegrity application fee does not match the locked transaction fee plus previously earned carry.'
         END,
         updated_at=CURRENT_TIMESTAMP
   WHERE id=NEW.id;
END;

-- A fee refund changes current cash, not the locked fee calculation or historical gross fee.
-- It therefore cannot demote a valid PROTECTED record merely by reducing net fee cash.
DROP TRIGGER IF EXISTS transactions_nonprotected_cannot_earn_fee_update;
CREATE TRIGGER transactions_nonprotected_cannot_earn_fee_update
BEFORE UPDATE OF record_classification,bg_fee_earned_cents ON transactions
WHEN NEW.record_classification IN ('OBSERVED','IMPORTED','FEE_EXCEPTION','PENDING_PROTECTED')
AND COALESCE(NEW.bg_fee_earned_cents,0)<>0
BEGIN
  SELECT RAISE(ABORT, 'Only PROTECTED transactions may recognize Builtegrity fee revenue');
END;

DROP VIEW IF EXISTS transaction_console;
CREATE VIEW transaction_console AS
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
  t.record_classification,
  t.processor,
  t.payment_status,
  t.processor_payout_status,
  t.pricing_version_id,
  t.pricing_base_cents,
  t.pricing_percentage_bps,
  t.pricing_calculated_cents AS current_transaction_whole_fee_cents,
  t.pricing_fee_micros AS current_transaction_exact_fee_micros,
  t.pricing_carry_reserved_cents,
  (t.pricing_calculated_cents+COALESCE(t.pricing_carry_reserved_cents,0)) AS expected_application_fee_cents,
  t.application_fee_gross_confirmed_cents,
  t.integrity_fee_collected_cents AS current_application_fee_cash_cents,
  t.application_fee_refunded_cents,
  t.bg_fee_earned_cents,
  t.fee_collection_method,
  t.protection_confirmed_at,
  t.protection_failure_reason
FROM transactions t
JOIN purchases p ON p.id=t.purchase_id
JOIN customers c ON c.id=t.customer_id
JOIN merchants m ON m.id=t.merchant_id
JOIN partners ptn ON ptn.id=m.partner_id;
