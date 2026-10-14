PRAGMA foreign_keys = ON;

-- 0026 introduced a second set of historical-protection promotion/exception triggers before
-- fractional fee carry existed. 0050 introduced the carry-aware classifier, so keeping both
-- would let two different fee equations compete on the same processor event. Retire only the
-- legacy decision triggers; keep transactions_protected_history_no_rewrite as the immutable
-- historical-evidence guard.
DROP TRIGGER IF EXISTS transactions_protected_requires_confirmed_history_insert;
DROP TRIGGER IF EXISTS transactions_protected_requires_confirmed_history_update;
DROP TRIGGER IF EXISTS transactions_confirm_protected_after_historical_truth;
DROP TRIGGER IF EXISTS transactions_flag_fee_exception_after_historical_truth;

-- For an already-PROTECTED transaction, the older history-no-rewrite trigger is authoritative.
-- This validator therefore governs only the transition into PROTECTED. Later refunds/credits may
-- change current cash fields but cannot rewrite the original gross protection evidence.
DROP TRIGGER IF EXISTS transactions_protected_requires_successful_fee_update;
CREATE TRIGGER transactions_protected_requires_successful_fee_update
BEFORE UPDATE OF record_classification,bg_fee_earned_cents,payment_at,stripe_application_fee_id,
                 application_fee_gross_confirmed_cents,integrity_fee_earned_cents,pricing_carry_reserved_cents
ON transactions
WHEN NEW.record_classification='PROTECTED'
 AND OLD.record_classification<>'PROTECTED'
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
  SELECT RAISE(ABORT, 'PROTECTED transition requires payment-success evidence and exact gross Builtegrity application-fee confirmation including earned carry');
END;

-- Explicit invariant check for schema/CI introspection: exactly one active promotion trigger and
-- one active fee-exception trigger should make the classification decision after this migration.
CREATE VIEW IF NOT EXISTS protection_classifier_inventory AS
SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='transactions_confirm_protected_after_processor_truth') AS promotion_triggers,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='transactions_flag_fee_exception_after_processor_truth') AS exception_triggers,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='transactions_protected_history_no_rewrite') AS history_guards;
