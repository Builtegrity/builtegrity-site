PRAGMA foreign_keys = ON;

-- Transaction record classification and revenue-recognition invariant.
-- Merchant-facing final classes are PROTECTED, OBSERVED, and IMPORTED.
-- PENDING_PROTECTED and FEE_EXCEPTION are internal operational states.

ALTER TABLE transactions ADD COLUMN record_classification TEXT NOT NULL DEFAULT 'PENDING_PROTECTED'
  CHECK (record_classification IN ('PENDING_PROTECTED','PROTECTED','OBSERVED','IMPORTED','FEE_EXCEPTION'));
ALTER TABLE transactions ADD COLUMN bg_fee_earned_cents INTEGER NOT NULL DEFAULT 0
  CHECK (bg_fee_earned_cents >= 0);
ALTER TABLE transactions ADD COLUMN protection_confirmed_at TEXT;
ALTER TABLE transactions ADD COLUMN protection_failure_reason TEXT;

-- Backfill existing records without inventing protection.
UPDATE transactions
SET record_classification = CASE
      WHEN payment_status = 'succeeded'
       AND fee_collection_method = 'STRIPE_APPLICATION_FEE'
       AND stripe_application_fee_id IS NOT NULL
       AND integrity_fee_collected_cents > 0
       AND integrity_fee_collected_cents = integrity_fee_earned_cents
        THEN 'PROTECTED'
      WHEN payment_status = 'succeeded'
       AND fee_collection_method = 'STRIPE_APPLICATION_FEE'
       AND integrity_fee_earned_cents > 0
        THEN 'FEE_EXCEPTION'
      ELSE 'PENDING_PROTECTED'
    END,
    bg_fee_earned_cents = CASE
      WHEN payment_status = 'succeeded'
       AND fee_collection_method = 'STRIPE_APPLICATION_FEE'
       AND stripe_application_fee_id IS NOT NULL
       AND integrity_fee_collected_cents > 0
       AND integrity_fee_collected_cents = integrity_fee_earned_cents
        THEN integrity_fee_collected_cents
      ELSE 0
    END,
    protection_confirmed_at = CASE
      WHEN payment_status = 'succeeded'
       AND fee_collection_method = 'STRIPE_APPLICATION_FEE'
       AND stripe_application_fee_id IS NOT NULL
       AND integrity_fee_collected_cents > 0
       AND integrity_fee_collected_cents = integrity_fee_earned_cents
        THEN COALESCE(payment_at, CURRENT_TIMESTAMP)
      ELSE NULL
    END,
    protection_failure_reason = CASE
      WHEN payment_status = 'succeeded'
       AND fee_collection_method = 'STRIPE_APPLICATION_FEE'
       AND integrity_fee_earned_cents > 0
       AND stripe_application_fee_id IS NULL
        THEN 'Successful payment did not expose the required Builtegrity application fee.'
      WHEN payment_status = 'succeeded'
       AND fee_collection_method = 'STRIPE_APPLICATION_FEE'
       AND integrity_fee_collected_cents > 0
       AND integrity_fee_collected_cents <> integrity_fee_earned_cents
        THEN 'Collected Builtegrity application fee does not match the locked transaction fee.'
      ELSE NULL
    END;

CREATE INDEX IF NOT EXISTS idx_transactions_record_classification
  ON transactions(record_classification, created_at DESC);

-- A transaction may only be called PROTECTED after payment success and exact processor fee confirmation.
CREATE TRIGGER IF NOT EXISTS transactions_protected_requires_successful_fee_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification = 'PROTECTED'
AND (
  COALESCE(NEW.payment_status, '') <> 'succeeded'
  OR COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
  OR NEW.stripe_application_fee_id IS NULL
  OR COALESCE(NEW.integrity_fee_collected_cents, 0) <= 0
  OR COALESCE(NEW.integrity_fee_collected_cents, 0) <> COALESCE(NEW.integrity_fee_earned_cents, 0)
  OR COALESCE(NEW.bg_fee_earned_cents, 0) <> COALESCE(NEW.integrity_fee_collected_cents, 0)
)
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED requires succeeded payment and exact Builtegrity application-fee confirmation');
END;

CREATE TRIGGER IF NOT EXISTS transactions_protected_requires_successful_fee_update
BEFORE UPDATE OF record_classification, bg_fee_earned_cents, payment_status, stripe_application_fee_id, integrity_fee_collected_cents, integrity_fee_earned_cents ON transactions
WHEN NEW.record_classification = 'PROTECTED'
AND (
  COALESCE(NEW.payment_status, '') <> 'succeeded'
  OR COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
  OR NEW.stripe_application_fee_id IS NULL
  OR COALESCE(NEW.integrity_fee_collected_cents, 0) <= 0
  OR COALESCE(NEW.integrity_fee_collected_cents, 0) <> COALESCE(NEW.integrity_fee_earned_cents, 0)
  OR COALESCE(NEW.bg_fee_earned_cents, 0) <> COALESCE(NEW.integrity_fee_collected_cents, 0)
)
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED requires succeeded payment and exact Builtegrity application-fee confirmation');
END;

-- OBSERVED and IMPORTED records are documentation/reference records and can never earn Builtegrity fee revenue.
CREATE TRIGGER IF NOT EXISTS transactions_nonprotected_cannot_earn_fee_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification IN ('OBSERVED','IMPORTED','FEE_EXCEPTION','PENDING_PROTECTED')
AND COALESCE(NEW.bg_fee_earned_cents, 0) <> 0
BEGIN
  SELECT RAISE(ABORT, 'Only PROTECTED transactions may recognize Builtegrity fee revenue');
END;

CREATE TRIGGER IF NOT EXISTS transactions_nonprotected_cannot_earn_fee_update
BEFORE UPDATE OF record_classification, bg_fee_earned_cents ON transactions
WHEN NEW.record_classification IN ('OBSERVED','IMPORTED','FEE_EXCEPTION','PENDING_PROTECTED')
AND COALESCE(NEW.bg_fee_earned_cents, 0) <> 0
BEGIN
  SELECT RAISE(ABORT, 'Only PROTECTED transactions may recognize Builtegrity fee revenue');
END;

-- Builtegrity protected transactions are transaction-funded. Separate usage/partner billing is prohibited.
CREATE TRIGGER IF NOT EXISTS transactions_protected_flow_forbids_separate_billing_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification IN ('PENDING_PROTECTED','PROTECTED','FEE_EXCEPTION')
AND COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
BEGIN
  SELECT RAISE(ABORT, 'Protected transactions must collect Builtegrity revenue inside the processor transaction; separate billing is prohibited');
END;

CREATE TRIGGER IF NOT EXISTS transactions_protected_flow_forbids_separate_billing_update
BEFORE UPDATE OF record_classification, fee_collection_method ON transactions
WHEN NEW.record_classification IN ('PENDING_PROTECTED','PROTECTED','FEE_EXCEPTION')
AND COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
BEGIN
  SELECT RAISE(ABORT, 'Protected transactions must collect Builtegrity revenue inside the processor transaction; separate billing is prohibited');
END;

-- Processor truth promotes a pending transaction to PROTECTED only when all fee facts agree.
CREATE TRIGGER IF NOT EXISTS transactions_confirm_protected_after_processor_truth
AFTER UPDATE OF payment_status, stripe_application_fee_id, integrity_fee_collected_cents, integrity_fee_earned_cents ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED')
AND NEW.payment_status = 'succeeded'
AND NEW.fee_collection_method = 'STRIPE_APPLICATION_FEE'
AND NEW.stripe_application_fee_id IS NOT NULL
AND NEW.integrity_fee_collected_cents > 0
AND NEW.integrity_fee_collected_cents = NEW.integrity_fee_earned_cents
BEGIN
  UPDATE transactions
     SET record_classification = 'PROTECTED',
         bg_fee_earned_cents = NEW.integrity_fee_collected_cents,
         protection_confirmed_at = COALESCE(protection_confirmed_at, CURRENT_TIMESTAMP),
         protection_failure_reason = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.id;
END;

-- Successful payment without the required fee, or with a mismatched fee, is never silently called protected.
CREATE TRIGGER IF NOT EXISTS transactions_flag_fee_exception_after_processor_truth
AFTER UPDATE OF payment_status, stripe_application_fee_id, integrity_fee_collected_cents, integrity_fee_earned_cents ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED','PROTECTED')
AND NEW.payment_status = 'succeeded'
AND NEW.fee_collection_method = 'STRIPE_APPLICATION_FEE'
AND NEW.integrity_fee_earned_cents > 0
AND (
  NEW.stripe_application_fee_id IS NULL
  OR (NEW.integrity_fee_collected_cents > 0 AND NEW.integrity_fee_collected_cents <> NEW.integrity_fee_earned_cents)
)
BEGIN
  UPDATE transactions
     SET record_classification = 'FEE_EXCEPTION',
         bg_fee_earned_cents = 0,
         protection_confirmed_at = NULL,
         protection_failure_reason = CASE
           WHEN NEW.stripe_application_fee_id IS NULL
             THEN 'Successful payment did not expose the required Builtegrity application fee.'
           ELSE 'Collected Builtegrity application fee does not match the locked transaction fee.'
         END,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.id;
END;

-- Replace the old cash-collected trigger: actual revenue is recognized only after PROTECTED is confirmed.
DROP TRIGGER IF EXISTS transactions_record_actual_fee_increase;

CREATE TRIGGER IF NOT EXISTS transactions_record_actual_protected_fee
AFTER UPDATE OF record_classification, bg_fee_earned_cents ON transactions
WHEN NEW.record_classification = 'PROTECTED'
AND NEW.bg_fee_earned_cents > 0
AND (OLD.record_classification <> 'PROTECTED' OR OLD.bg_fee_earned_cents <> NEW.bg_fee_earned_cents)
BEGIN
  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, source_ref, details_json)
  VALUES (
    'ECO_ACT_REV_' || NEW.id || '_' || NEW.bg_fee_earned_cents,
    NEW.id,
    'REVENUE',
    'INTEGRITY_FEE',
    NEW.bg_fee_earned_cents * 10000,
    'ACTUAL',
    'fee-collected:' || NEW.bg_fee_earned_cents,
    '{"fee_payer":"MERCHANT","source":"processor_application_fee","classification":"PROTECTED"}'
  );
END;

-- Keep negative processor adjustments as adjustments to cash truth, not as new revenue.
DROP TRIGGER IF EXISTS transactions_record_actual_fee_decrease;
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

-- Surface the classification and recognized fee in the internal console view.
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
  t.integrity_fee_earned_cents AS planned_builtegrity_fee_cents,
  t.integrity_fee_collected_cents,
  t.bg_fee_earned_cents,
  t.fee_collection_method,
  t.protection_confirmed_at,
  t.protection_failure_reason
FROM transactions t
JOIN purchases p ON p.id = t.purchase_id
JOIN customers c ON c.id = t.customer_id
JOIN merchants m ON m.id = t.merchant_id
JOIN partners ptn ON ptn.id = m.partner_id;
