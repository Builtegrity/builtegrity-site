
PRAGMA foreign_keys = ON;

-- Square and Stripe share historical protection semantics, while retaining independent
-- processor proofs and fee receipt IDs. This replaces only post-0062 classifier guards;
-- frozen migrations are never rewritten.
CREATE TABLE IF NOT EXISTS square_refund_facts (
 refund_id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL REFERENCES transactions(id),
 processor_payment_id TEXT NOT NULL,
 status TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
 app_fee_refunded_cents INTEGER NOT NULL CHECK(app_fee_refunded_cents>=0),
 currency TEXT NOT NULL DEFAULT 'USD',
 observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_square_refund_tx ON square_refund_facts(transaction_id,status);
ALTER TABLE transactions ADD COLUMN square_refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK(square_refunded_cents>=0);
ALTER TABLE transactions ADD COLUMN square_app_fee_refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK(square_app_fee_refunded_cents>=0);

-- For Square, fee_collection_method='OTHER' is a legacy schema constraint: processor='SQUARE'
-- explicitly disambiguates this from other fee methods without rebuilding the D1 table.
DROP TRIGGER IF EXISTS transactions_protected_requires_successful_fee_insert;
CREATE TRIGGER transactions_protected_requires_successful_fee_insert
BEFORE INSERT ON transactions WHEN NEW.record_classification='PROTECTED'
AND (NEW.payment_at IS NULL OR COALESCE(NEW.bg_fee_earned_cents,0) <= 0
  OR NEW.bg_fee_earned_cents <> NEW.integrity_fee_earned_cents + COALESCE(NEW.pricing_carry_reserved_cents,0)
  OR NOT (
    (NEW.processor='STRIPE' AND NEW.fee_collection_method='STRIPE_APPLICATION_FEE'
     AND NEW.stripe_application_fee_id IS NOT NULL
     AND NEW.application_fee_gross_confirmed_cents=NEW.bg_fee_earned_cents)
    OR
    (NEW.processor='SQUARE' AND NEW.fee_collection_method='OTHER'
     AND NEW.processor_checkout_id IS NOT NULL
     AND NEW.processor_order_id IS NOT NULL
     AND NEW.processor_payment_id IS NOT NULL
     AND NEW.processor_app_fee_confirmed_cents=NEW.bg_fee_earned_cents
     AND NEW.application_fee_gross_confirmed_cents=NEW.bg_fee_earned_cents)
  ))
BEGIN SELECT RAISE(ABORT,'PROTECTED requires exact verified processor fee evidence'); END;

DROP TRIGGER IF EXISTS transactions_protected_requires_successful_fee_update;
CREATE TRIGGER transactions_protected_requires_successful_fee_update
BEFORE UPDATE OF record_classification,bg_fee_earned_cents,payment_at,stripe_application_fee_id,
 application_fee_gross_confirmed_cents,integrity_fee_earned_cents,pricing_carry_reserved_cents,
 processor_app_fee_confirmed_cents,processor_payment_id,processor_order_id,processor_checkout_id
ON transactions WHEN NEW.record_classification='PROTECTED'
AND OLD.record_classification<>'PROTECTED'
AND (NEW.payment_at IS NULL OR COALESCE(NEW.bg_fee_earned_cents,0) <= 0
 OR NEW.bg_fee_earned_cents <> NEW.integrity_fee_earned_cents + COALESCE(NEW.pricing_carry_reserved_cents,0)
 OR NOT (
   (NEW.processor='STRIPE' AND NEW.fee_collection_method='STRIPE_APPLICATION_FEE'
    AND NEW.stripe_application_fee_id IS NOT NULL
    AND NEW.application_fee_gross_confirmed_cents=NEW.bg_fee_earned_cents)
   OR
   (NEW.processor='SQUARE' AND NEW.fee_collection_method='OTHER'
    AND NEW.processor_checkout_id IS NOT NULL
    AND NEW.processor_order_id IS NOT NULL
    AND NEW.processor_payment_id IS NOT NULL
    AND NEW.processor_app_fee_confirmed_cents=NEW.bg_fee_earned_cents
    AND NEW.application_fee_gross_confirmed_cents=NEW.bg_fee_earned_cents)
 ))
BEGIN SELECT RAISE(ABORT,'PROTECTED transition requires exact verified processor fee evidence'); END;

DROP TRIGGER IF EXISTS transactions_protected_history_no_rewrite;
CREATE TRIGGER transactions_protected_history_no_rewrite
BEFORE UPDATE OF record_classification,bg_fee_earned_cents,protection_confirmed_at,
 stripe_application_fee_id,application_fee_gross_confirmed_cents,
 processor_app_fee_confirmed_cents,processor_payment_id,processor_order_id,processor_checkout_id,
 processor,fee_collection_method
ON transactions WHEN OLD.record_classification='PROTECTED'
AND (NEW.record_classification<>'PROTECTED'
 OR NEW.bg_fee_earned_cents<>OLD.bg_fee_earned_cents
 OR COALESCE(NEW.protection_confirmed_at,'')<>COALESCE(OLD.protection_confirmed_at,'')
 OR COALESCE(NEW.stripe_application_fee_id,'')<>COALESCE(OLD.stripe_application_fee_id,'')
 OR NEW.application_fee_gross_confirmed_cents<>OLD.application_fee_gross_confirmed_cents
 OR NEW.processor_app_fee_confirmed_cents<>OLD.processor_app_fee_confirmed_cents
 OR COALESCE(NEW.processor_payment_id,'')<>COALESCE(OLD.processor_payment_id,'')
 OR COALESCE(NEW.processor_order_id,'')<>COALESCE(OLD.processor_order_id,'')
 OR COALESCE(NEW.processor_checkout_id,'')<>COALESCE(OLD.processor_checkout_id,'')
 OR NEW.processor<>OLD.processor OR COALESCE(NEW.fee_collection_method,'')<>COALESCE(OLD.fee_collection_method,''))
BEGIN SELECT RAISE(ABORT,'confirmed protection history is immutable; processor evidence cannot be rewritten'); END;

-- One canonical classifier (the existing inventory keeps this name).
DROP TRIGGER IF EXISTS transactions_confirm_protected_after_processor_truth;
CREATE TRIGGER transactions_confirm_protected_after_processor_truth
AFTER UPDATE OF payment_at,stripe_application_fee_id,application_fee_gross_confirmed_cents,
 integrity_fee_earned_cents,pricing_carry_reserved_cents,
 customer_attested_country_code,customer_attested_state_code,customer_attested_at,checkout_legal_gate_at,
 processor_payment_id,processor_order_id,processor_app_fee_confirmed_cents
ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED','PROTECTED')
 AND NEW.payment_at IS NOT NULL
 AND (NEW.integrity_fee_earned_cents + COALESCE(NEW.pricing_carry_reserved_cents,0))>0
 AND NEW.application_fee_gross_confirmed_cents =
   NEW.integrity_fee_earned_cents+COALESCE(NEW.pricing_carry_reserved_cents,0)
 AND upper(COALESCE(NEW.customer_attested_country_code,''))='US'
 AND length(COALESCE(NEW.customer_attested_state_code,''))=2
 AND NEW.customer_attested_at IS NOT NULL AND NEW.checkout_legal_gate_at IS NOT NULL
 AND (
   (NEW.processor='STRIPE' AND NEW.fee_collection_method='STRIPE_APPLICATION_FEE'
    AND NEW.stripe_application_fee_id IS NOT NULL)
   OR
   (NEW.processor='SQUARE' AND NEW.fee_collection_method='OTHER'
    AND NEW.processor_checkout_id IS NOT NULL AND NEW.processor_order_id IS NOT NULL
    AND NEW.processor_payment_id IS NOT NULL
    AND NEW.processor_app_fee_confirmed_cents=NEW.application_fee_gross_confirmed_cents)
 )
BEGIN
 UPDATE transactions SET record_classification='PROTECTED',
    bg_fee_earned_cents=NEW.application_fee_gross_confirmed_cents,
    protection_confirmed_at=COALESCE(protection_confirmed_at,CURRENT_TIMESTAMP),
    protection_failure_reason=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=NEW.id;
 INSERT OR IGNORE INTO transaction_carry_finalization_requests(transaction_id,source)
 VALUES(NEW.id,'PROCESSOR_CLASSIFIER');
END;

-- Do not count a successful Square payment with a missing/incorrect fee as earned revenue.
-- A later exact confirmation can promote from FEE_EXCEPTION using the same classifier.
CREATE TRIGGER IF NOT EXISTS transactions_square_fee_exception_after_processor_truth
AFTER UPDATE OF payment_at,processor_payment_id,processor_app_fee_confirmed_cents,
 application_fee_gross_confirmed_cents
ON transactions
WHEN NEW.processor='SQUARE'
 AND NEW.record_classification NOT IN ('PROTECTED','OBSERVED','IMPORTED')
 AND NEW.payment_at IS NOT NULL
 AND NEW.fee_collection_method='OTHER'
 AND (NEW.processor_app_fee_confirmed_cents=0
      OR NEW.processor_app_fee_confirmed_cents <>
          NEW.integrity_fee_earned_cents+COALESCE(NEW.pricing_carry_reserved_cents,0))
BEGIN
 UPDATE transactions SET record_classification='FEE_EXCEPTION',bg_fee_earned_cents=0,
   protection_confirmed_at=NULL,
   protection_failure_reason='Square payment succeeded without the exact Builtegrity application fee.',
   updated_at=CURRENT_TIMESTAMP WHERE id=NEW.id;
END;

-- No cross-provider races: the transaction processor is selected before payment creation.
CREATE TRIGGER IF NOT EXISTS transactions_processor_immutable_after_checkout
BEFORE UPDATE OF processor ON transactions
WHEN OLD.processor_checkout_id IS NOT NULL OR OLD.stripe_checkout_session_id IS NOT NULL
 OR OLD.payment_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'transaction processor cannot change after checkout'); END;

-- A Square checkout cannot be imported directly without the same legal clearance.
CREATE TRIGGER IF NOT EXISTS square_checkout_insert_requires_legal_gate
BEFORE INSERT ON transactions WHEN NEW.processor='SQUARE' AND NEW.processor_checkout_id IS NOT NULL
AND (NEW.consent_accepted<>1 OR NEW.customer_attested_country_code<>'US'
 OR NEW.customer_attested_at IS NULL OR NEW.checkout_legal_gate_at IS NULL
 OR NEW.fee_refund_rule_locked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Square checkout requires prepayment legal clearance'); END;
