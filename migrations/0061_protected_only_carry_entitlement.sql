PRAGMA foreign_keys = ON;

-- 0061 closes the last gap between the PROTECTED revenue invariant and fractional carry.
-- Historical 0045 behavior accrued/settled carry on payment success. That was too early:
-- a payment can succeed while the required Builtegrity application fee is missing/mismatched.
-- Canonical rule after this migration:
--   AVAILABLE -> RESERVED at checkout -> SETTLED only when the transaction becomes PROTECTED.
-- The current transaction's residual is also entitled only on PROTECTED.

ALTER TABLE transactions ADD COLUMN pricing_residual_entitled_at TEXT;
ALTER TABLE transactions ADD COLUMN pricing_carry_settlement_confirmed_at TEXT;

CREATE TABLE IF NOT EXISTS transaction_fee_entitlements (
  transaction_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  pricing_version_id TEXT,
  entitlement_micros INTEGER NOT NULL CHECK (entitlement_micros >= 0),
  current_transaction_whole_cents INTEGER NOT NULL CHECK (current_transaction_whole_cents >= 0),
  residual_micros INTEGER NOT NULL CHECK (residual_micros >= 0 AND residual_micros < 10000),
  carry_collected_cents INTEGER NOT NULL DEFAULT 0 CHECK (carry_collected_cents >= 0),
  protection_confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);

CREATE TRIGGER IF NOT EXISTS transaction_fee_entitlements_no_update
BEFORE UPDATE ON transaction_fee_entitlements
BEGIN SELECT RAISE(ABORT, 'transaction fee entitlements are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transaction_fee_entitlements_no_delete
BEFORE DELETE ON transaction_fee_entitlements
BEGIN SELECT RAISE(ABORT, 'transaction fee entitlements are append-only'); END;

-- Corrections preserve the old append-only carry event history instead of deleting evidence.
CREATE TABLE IF NOT EXISTS merchant_fee_carry_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  correction_type TEXT NOT NULL CHECK (correction_type IN (
    'PRE_PROTECTION_ACCRUAL_REVERSED',
    'PRE_PROTECTION_SETTLEMENT_REVERSED',
    'RESIDUAL_REENTITLED_AFTER_CORRECTION',
    'SETTLEMENT_RECONFIRMED_AFTER_CORRECTION'
  )),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  UNIQUE (transaction_id, correction_type)
);
CREATE TRIGGER IF NOT EXISTS merchant_fee_carry_corrections_no_update
BEFORE UPDATE ON merchant_fee_carry_corrections
BEGIN SELECT RAISE(ABORT, 'merchant fee carry corrections are append-only'); END;
CREATE TRIGGER IF NOT EXISTS merchant_fee_carry_corrections_no_delete
BEFORE DELETE ON merchant_fee_carry_corrections
BEGIN SELECT RAISE(ABORT, 'merchant fee carry corrections are append-only'); END;

-- Preserve evidence of carry that 0045 accrued/settled before PROTECTED confirmation.
INSERT OR IGNORE INTO merchant_fee_carry_corrections (
  merchant_id, transaction_id, correction_type, amount_micros, reason
)
SELECT e.merchant_id, e.transaction_id, 'PRE_PROTECTION_ACCRUAL_REVERSED', e.amount_micros,
       'Historical carry accrual occurred on payment success before PROTECTED confirmation; 0061 reverses its economic effect while preserving the original append-only event.'
FROM merchant_fee_carry_events e
JOIN transactions t ON t.id=e.transaction_id
WHERE e.event_type='ACCRUED'
  AND t.record_classification<>'PROTECTED';

INSERT OR IGNORE INTO merchant_fee_carry_corrections (
  merchant_id, transaction_id, correction_type, amount_micros, reason
)
SELECT t.merchant_id, t.id, 'PRE_PROTECTION_SETTLEMENT_REVERSED', t.pricing_carry_settled_cents * 10000,
       'Historical reserved carry was marked settled on payment success before PROTECTED confirmation; 0061 returns it to RESERVED state pending protection or explicit release.'
FROM transactions t
WHERE t.record_classification<>'PROTECTED'
  AND t.pricing_carry_settled_cents>0;

-- Fail closed if historical invalid carry was already consumed beyond the amount of valid
-- PROTECTED residual entitlement. A pre-production database with this condition needs explicit
-- reconciliation rather than a silent negative/forgiven balance.
CREATE TABLE migration_0061_carry_guard (
  id INTEGER PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok=1)
);
INSERT INTO migration_0061_carry_guard (id, ok)
SELECT 1, 0
WHERE EXISTS (
  SELECT 1
  FROM (
    SELECT
      merchant_id,
      currency,
      SUM(CASE WHEN record_classification='PROTECTED' THEN COALESCE(pricing_fee_residual_micros,0) ELSE 0 END)
        - SUM(COALESCE(pricing_carry_reserved_cents,0) * 10000) AS expected_available_micros
    FROM transactions
    GROUP BY merchant_id, currency
  ) x
  WHERE x.expected_available_micros < 0
);
DROP TABLE migration_0061_carry_guard;

-- Reconcile the derived carry balance from canonical transaction truth. Reservations stay held;
-- only residuals from PROTECTED transactions fund the carry pool.
INSERT INTO merchant_fee_carry (
  merchant_id, currency, available_micros, lifetime_accrued_micros, updated_at
)
SELECT
  merchant_id,
  currency,
  SUM(CASE WHEN record_classification='PROTECTED' THEN COALESCE(pricing_fee_residual_micros,0) ELSE 0 END)
    - SUM(COALESCE(pricing_carry_reserved_cents,0) * 10000) AS available_micros,
  SUM(CASE WHEN record_classification='PROTECTED' THEN COALESCE(pricing_fee_residual_micros,0) ELSE 0 END) AS lifetime_accrued_micros,
  CURRENT_TIMESTAMP
FROM transactions
GROUP BY merchant_id, currency
ON CONFLICT(merchant_id, currency) DO UPDATE SET
  available_micros=excluded.available_micros,
  lifetime_accrued_micros=excluded.lifetime_accrued_micros,
  updated_at=CURRENT_TIMESTAMP;

-- Existing PROTECTED history already earned its residual/carry under the corrected semantic rule.
UPDATE transactions
SET pricing_residual_entitled_at=COALESCE(pricing_residual_entitled_at, protection_confirmed_at, payment_at, CURRENT_TIMESTAMP)
WHERE record_classification='PROTECTED'
  AND COALESCE(pricing_fee_residual_micros,0)>0;

UPDATE transactions
SET pricing_carry_settled_cents=pricing_carry_reserved_cents,
    pricing_carry_settlement_confirmed_at=COALESCE(pricing_carry_settlement_confirmed_at, protection_confirmed_at, payment_at, CURRENT_TIMESTAMP)
WHERE record_classification='PROTECTED'
  AND pricing_carry_reserved_cents>0;

-- Non-PROTECTED history may have been marked SETTLED by the old payment-success trigger.
-- Return it to RESERVED state; the reservation remains deducted from available carry.
UPDATE transactions
SET pricing_carry_settled_cents=0,
    pricing_carry_settlement_confirmed_at=NULL
WHERE record_classification<>'PROTECTED'
  AND pricing_carry_settled_cents>0;

-- Backfill exact entitlement evidence for historical PROTECTED records.
INSERT OR IGNORE INTO transaction_fee_entitlements (
  transaction_id, merchant_id, currency, pricing_version_id,
  entitlement_micros, current_transaction_whole_cents, residual_micros,
  carry_collected_cents, protection_confirmed_at
)
SELECT
  id, merchant_id, currency, pricing_version_id,
  COALESCE(integrity_fee_earned_micros, integrity_fee_earned_cents * 10000),
  integrity_fee_earned_cents,
  COALESCE(pricing_fee_residual_micros,0),
  COALESCE(pricing_carry_settled_cents,0),
  COALESCE(protection_confirmed_at, payment_at, CURRENT_TIMESTAMP)
FROM transactions
WHERE record_classification='PROTECTED';

-- Old payment-success carry transitions are no longer authoritative.
DROP TRIGGER IF EXISTS transactions_accrue_fractional_fee_on_success;
DROP TRIGGER IF EXISTS transactions_settle_reserved_carry;

-- Harden reservations: carry can only be reserved before payment/Checkout and can never be
-- re-reserved after an explicit release on the same transaction.
DROP TRIGGER IF EXISTS transactions_reserve_fee_carry;
CREATE TRIGGER transactions_reserve_fee_carry
BEFORE UPDATE OF pricing_carry_reserved_cents ON transactions
WHEN NEW.pricing_carry_reserved_cents > OLD.pricing_carry_reserved_cents
BEGIN
  SELECT CASE WHEN NEW.payment_at IS NOT NULL OR NEW.stripe_checkout_session_id IS NOT NULL
    THEN RAISE(ABORT, 'carry must be reserved before checkout/payment') END;
  SELECT CASE WHEN OLD.pricing_carry_settled_cents > 0 OR OLD.pricing_carry_settlement_confirmed_at IS NOT NULL
    THEN RAISE(ABORT, 'settled carry cannot be increased') END;
  SELECT CASE WHEN OLD.pricing_carry_released_at IS NOT NULL
    THEN RAISE(ABORT, 'released carry cannot be re-reserved on the same transaction') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM merchant_fee_carry c
    WHERE c.merchant_id=NEW.merchant_id AND c.currency=NEW.currency
      AND c.available_micros >= ((NEW.pricing_carry_reserved_cents - OLD.pricing_carry_reserved_cents) * 10000)
  ) THEN RAISE(ABORT, 'insufficient merchant fee carry') END;

  UPDATE merchant_fee_carry
     SET available_micros=available_micros - ((NEW.pricing_carry_reserved_cents - OLD.pricing_carry_reserved_cents) * 10000),
         lifetime_reserved_micros=lifetime_reserved_micros + ((NEW.pricing_carry_reserved_cents - OLD.pricing_carry_reserved_cents) * 10000),
         updated_at=CURRENT_TIMESTAMP
   WHERE merchant_id=NEW.merchant_id AND currency=NEW.currency;
END;

-- Release is still automatic before payment. After payment, only an explicit FEE_EXCEPTION
-- may release an uncollected reservation. PROTECTED/settled carry can never be released.
DROP TRIGGER IF EXISTS transactions_release_fee_carry;
CREATE TRIGGER transactions_release_fee_carry
BEFORE UPDATE OF pricing_carry_reserved_cents ON transactions
WHEN NEW.pricing_carry_reserved_cents < OLD.pricing_carry_reserved_cents
BEGIN
  SELECT CASE WHEN OLD.record_classification='PROTECTED'
                 OR OLD.pricing_carry_settled_cents>0
                 OR OLD.pricing_carry_settlement_confirmed_at IS NOT NULL
    THEN RAISE(ABORT, 'protected/settled carry cannot be released') END;
  SELECT CASE WHEN OLD.payment_at IS NOT NULL AND OLD.record_classification<>'FEE_EXCEPTION'
    THEN RAISE(ABORT, 'post-payment carry release requires an explicit fee exception') END;
  SELECT CASE WHEN NEW.pricing_carry_reserved_cents<>0
    THEN RAISE(ABORT, 'carry release must release the full reservation') END;
  SELECT CASE WHEN NEW.pricing_carry_released_at IS NULL
    THEN RAISE(ABORT, 'carry release requires a release timestamp') END;

  INSERT INTO merchant_fee_carry (merchant_id,currency,available_micros,lifetime_released_micros,updated_at)
  VALUES (
    NEW.merchant_id, NEW.currency,
    OLD.pricing_carry_reserved_cents * 10000,
    OLD.pricing_carry_reserved_cents * 10000,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(merchant_id,currency) DO UPDATE SET
    available_micros=merchant_fee_carry.available_micros + excluded.available_micros,
    lifetime_released_micros=merchant_fee_carry.lifetime_released_micros + excluded.lifetime_released_micros,
    updated_at=CURRENT_TIMESTAMP;
END;

-- One request row is the idempotency claim for all carry finalization on a transaction.
-- The classifier and a direct valid PROTECTED transition can both request finalization safely.
CREATE TABLE IF NOT EXISTS transaction_carry_finalization_requests (
  transaction_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('PROCESSOR_CLASSIFIER','PROTECTED_TRANSITION','BACKFILL')),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);
CREATE TRIGGER IF NOT EXISTS transaction_carry_finalization_requests_no_update
BEFORE UPDATE ON transaction_carry_finalization_requests
BEGIN SELECT RAISE(ABORT, 'carry finalization requests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS transaction_carry_finalization_requests_no_delete
BEFORE DELETE ON transaction_carry_finalization_requests
BEGIN SELECT RAISE(ABORT, 'carry finalization requests are immutable'); END;

CREATE TRIGGER transactions_finalize_carry_after_protection_request
AFTER INSERT ON transaction_carry_finalization_requests
BEGIN
  -- Current-transaction exact entitlement is immutable evidence, separate from processor cash.
  INSERT OR IGNORE INTO transaction_fee_entitlements (
    transaction_id, merchant_id, currency, pricing_version_id,
    entitlement_micros, current_transaction_whole_cents, residual_micros,
    carry_collected_cents, protection_confirmed_at
  )
  SELECT
    t.id, t.merchant_id, t.currency, t.pricing_version_id,
    COALESCE(t.integrity_fee_earned_micros, t.integrity_fee_earned_cents * 10000),
    t.integrity_fee_earned_cents,
    COALESCE(t.pricing_fee_residual_micros,0),
    COALESCE(t.pricing_carry_reserved_cents,0),
    COALESCE(t.protection_confirmed_at, t.payment_at, CURRENT_TIMESTAMP)
  FROM transactions t
  WHERE t.id=NEW.transaction_id
    AND t.record_classification='PROTECTED';

  -- Credit this transaction's residual exactly once, and only after PROTECTED.
  INSERT INTO merchant_fee_carry (
    merchant_id,currency,available_micros,lifetime_accrued_micros,updated_at
  )
  SELECT
    t.merchant_id,t.currency,t.pricing_fee_residual_micros,t.pricing_fee_residual_micros,CURRENT_TIMESTAMP
  FROM transactions t
  WHERE t.id=NEW.transaction_id
    AND t.record_classification='PROTECTED'
    AND t.pricing_fee_residual_micros>0
    AND t.pricing_residual_entitled_at IS NULL
  ON CONFLICT(merchant_id,currency) DO UPDATE SET
    available_micros=merchant_fee_carry.available_micros + excluded.available_micros,
    lifetime_accrued_micros=merchant_fee_carry.lifetime_accrued_micros + excluded.lifetime_accrued_micros,
    updated_at=CURRENT_TIMESTAMP;

  -- New transactions use the original ACCRUED event family.
  INSERT OR IGNORE INTO merchant_fee_carry_events (
    merchant_id,transaction_id,event_type,amount_micros,balance_after_micros
  )
  SELECT t.merchant_id,t.id,'ACCRUED',t.pricing_fee_residual_micros,c.available_micros
  FROM transactions t
  JOIN merchant_fee_carry c ON c.merchant_id=t.merchant_id AND c.currency=t.currency
  WHERE t.id=NEW.transaction_id
    AND t.record_classification='PROTECTED'
    AND t.pricing_fee_residual_micros>0
    AND t.pricing_residual_entitled_at IS NULL;

  -- If an old pre-PROTECTED ACCRUED event was reversed by this migration, preserve both facts
  -- and record that the residual later became legitimately entitled.
  INSERT OR IGNORE INTO merchant_fee_carry_corrections (
    merchant_id,transaction_id,correction_type,amount_micros,reason
  )
  SELECT t.merchant_id,t.id,'RESIDUAL_REENTITLED_AFTER_CORRECTION',t.pricing_fee_residual_micros,
         'Transaction later satisfied PROTECTED after its historical pre-protection accrual had been reversed.'
  FROM transactions t
  WHERE t.id=NEW.transaction_id
    AND t.record_classification='PROTECTED'
    AND t.pricing_fee_residual_micros>0
    AND t.pricing_residual_entitled_at IS NULL
    AND EXISTS (
      SELECT 1 FROM merchant_fee_carry_corrections c
      WHERE c.transaction_id=t.id AND c.correction_type='PRE_PROTECTION_ACCRUAL_REVERSED'
    );

  UPDATE transactions
     SET pricing_residual_entitled_at=COALESCE(pricing_residual_entitled_at,CURRENT_TIMESTAMP)
   WHERE id=NEW.transaction_id
     AND record_classification='PROTECTED'
     AND pricing_fee_residual_micros>0
     AND pricing_residual_entitled_at IS NULL;

  -- Prior carry becomes SETTLED only after processor truth has produced PROTECTED.
  UPDATE transactions
     SET pricing_carry_settled_cents=pricing_carry_reserved_cents,
         pricing_carry_settlement_confirmed_at=COALESCE(pricing_carry_settlement_confirmed_at,CURRENT_TIMESTAMP)
   WHERE id=NEW.transaction_id
     AND record_classification='PROTECTED'
     AND pricing_carry_reserved_cents>0
     AND pricing_carry_settlement_confirmed_at IS NULL;

  INSERT OR IGNORE INTO merchant_fee_carry_events (
    merchant_id,transaction_id,event_type,amount_micros,balance_after_micros
  )
  SELECT t.merchant_id,t.id,'SETTLED',t.pricing_carry_reserved_cents * 10000,
         COALESCE(c.available_micros,0)
  FROM transactions t
  LEFT JOIN merchant_fee_carry c ON c.merchant_id=t.merchant_id AND c.currency=t.currency
  WHERE t.id=NEW.transaction_id
    AND t.record_classification='PROTECTED'
    AND t.pricing_carry_reserved_cents>0;

  INSERT OR IGNORE INTO merchant_fee_carry_corrections (
    merchant_id,transaction_id,correction_type,amount_micros,reason
  )
  SELECT t.merchant_id,t.id,'SETTLEMENT_RECONFIRMED_AFTER_CORRECTION',t.pricing_carry_reserved_cents * 10000,
         'Transaction later satisfied PROTECTED after its historical pre-protection settlement marker had been reversed.'
  FROM transactions t
  WHERE t.id=NEW.transaction_id
    AND t.record_classification='PROTECTED'
    AND t.pricing_carry_reserved_cents>0
    AND EXISTS (
      SELECT 1 FROM merchant_fee_carry_corrections c
      WHERE c.transaction_id=t.id AND c.correction_type='PRE_PROTECTION_SETTLEMENT_REVERSED'
    );
END;

-- Any valid direct transition into PROTECTED requests the same idempotent finalization.
CREATE TRIGGER transactions_request_carry_finalization_on_protected
AFTER UPDATE OF record_classification ON transactions
WHEN OLD.record_classification<>'PROTECTED' AND NEW.record_classification='PROTECTED'
BEGIN
  INSERT OR IGNORE INTO transaction_carry_finalization_requests (transaction_id,source)
  VALUES (NEW.id,'PROTECTED_TRANSITION');
END;

-- Recreate the single processor classifier with an explicit finalization request. This does not
-- depend on SQLite recursive-trigger configuration: if the transition trigger already requested
-- finalization, INSERT OR IGNORE makes this second request a no-op.
DROP TRIGGER IF EXISTS transactions_confirm_protected_after_processor_truth;
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

  INSERT OR IGNORE INTO transaction_carry_finalization_requests (transaction_id,source)
  VALUES (NEW.id,'PROCESSOR_CLASSIFIER');
END;

-- Make actual economics explicitly a cash-basis processor receipt. The amount intentionally
-- includes prior carry when Stripe collects it on this payment; exact originating entitlement
-- lives in transaction_fee_entitlements and is not double-counted as cash revenue here.
DROP TRIGGER IF EXISTS transactions_record_actual_protected_fee;
CREATE TRIGGER transactions_record_actual_protected_fee
AFTER UPDATE OF record_classification,bg_fee_earned_cents ON transactions
WHEN NEW.record_classification='PROTECTED'
AND NEW.bg_fee_earned_cents>0
AND (OLD.record_classification<>'PROTECTED' OR OLD.bg_fee_earned_cents<>NEW.bg_fee_earned_cents)
BEGIN
  INSERT OR IGNORE INTO transaction_economics_ledger
    (id,transaction_id,entry_kind,category,amount_micros,basis,source_ref,details_json)
  VALUES (
    'ECO_ACT_REV_' || NEW.id || '_' || NEW.bg_fee_earned_cents,
    NEW.id,
    'REVENUE',
    'INTEGRITY_FEE',
    NEW.bg_fee_earned_cents * 10000,
    'ACTUAL',
    'application-fee-cash:' || NEW.bg_fee_earned_cents,
    '{"fee_payer":"MERCHANT","source":"processor_application_fee","accounting_fact":"CASH_RECEIPT","classification":"PROTECTED"}'
  );
END;

-- Protected pricing summary must be classification-driven, not merely payment-driven.
DROP VIEW IF EXISTS merchant_pricing_monthly_summary;
CREATE VIEW merchant_pricing_monthly_summary AS
SELECT
  merchant_id,
  strftime('%Y-%m',payment_at) AS month,
  COUNT(*) AS successful_protected_transactions,
  SUM(COALESCE(customer_paid_cents,amount_cents)) AS protected_volume_cents,
  SUM(COALESCE(integrity_fee_earned_micros,integrity_fee_earned_cents * 10000)) AS earned_fee_micros,
  ROUND(SUM(COALESCE(integrity_fee_earned_micros,integrity_fee_earned_cents * 10000)) / 10000.0,2) AS earned_fee_cents,
  SUM(integrity_fee_collected_cents) AS collected_fee_cents,
  SUM(integrity_fee_collected_cents) AS application_fee_cash_cents,
  SUM(COALESCE(pricing_carry_settled_cents,0)) AS carry_settled_cents,
  ROUND(1.0 * SUM(COALESCE(customer_paid_cents,amount_cents)) / COUNT(*),2) AS average_ticket_cents,
  ROUND(
    10000.0 * (SUM(COALESCE(integrity_fee_earned_micros,integrity_fee_earned_cents * 10000)) / 10000.0) /
    NULLIF(SUM(COALESCE(customer_paid_cents,amount_cents)),0),
    2
  ) AS effective_fee_bps
FROM transactions
WHERE record_classification='PROTECTED'
  AND payment_at IS NOT NULL
GROUP BY merchant_id,strftime('%Y-%m',payment_at);
