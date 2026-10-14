PRAGMA foreign_keys = ON;

-- Protection eligibility must not depend on Stripe webhook ordering or whether equivalent
-- facts arrive on INSERT vs UPDATE. Processor truth is always recordable; PROTECTED promotion
-- requires the legal Checkout evidence to have existed first.

-- Replace the older update-only legal guard with symmetric INSERT + UPDATE guards.
DROP TRIGGER IF EXISTS transactions_protected_requires_checkout_legal_gate;
DROP TRIGGER IF EXISTS transactions_protected_requires_checkout_legal_gate_insert;
DROP TRIGGER IF EXISTS transactions_protected_requires_checkout_legal_gate_update;

CREATE TRIGGER transactions_protected_requires_checkout_legal_gate_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification='PROTECTED'
AND (
  upper(COALESCE(NEW.customer_attested_country_code,''))<>'US'
  OR NEW.customer_attested_state_code IS NULL
  OR length(NEW.customer_attested_state_code)<>2
  OR NEW.customer_attested_at IS NULL
  OR NEW.checkout_legal_gate_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'PROTECTED requires customer U.S. jurisdiction attestation and pre-checkout legal clearance');
END;

CREATE TRIGGER transactions_protected_requires_checkout_legal_gate_update
BEFORE UPDATE OF record_classification ON transactions
WHEN NEW.record_classification='PROTECTED'
AND OLD.record_classification<>'PROTECTED'
AND (
  upper(COALESCE(NEW.customer_attested_country_code,''))<>'US'
  OR NEW.customer_attested_state_code IS NULL
  OR length(NEW.customer_attested_state_code)<>2
  OR NEW.customer_attested_at IS NULL
  OR NEW.checkout_legal_gate_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'PROTECTED requires customer U.S. jurisdiction attestation and pre-checkout legal clearance');
END;

-- Harden direct INSERT paths too. Normal runtime creates the transaction before Checkout and
-- therefore normally reaches these states by UPDATE, but imported/manual SQL must not be able
-- to bypass the same legal evidence requirements.
CREATE TRIGGER IF NOT EXISTS transactions_checkout_insert_requires_customer_attestation
BEFORE INSERT ON transactions
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

CREATE TRIGGER IF NOT EXISTS transactions_checkout_gate_insert_requires_customer_state_pack
BEFORE INSERT ON transactions
WHEN NEW.checkout_legal_gate_at IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM state_jurisdiction_support s
   WHERE s.state_code=upper(NEW.customer_attested_state_code)
     AND s.customer_transaction_status='READY'
     AND s.privacy_review_status='CLEARED'
     AND s.breach_review_status='CLEARED'
     AND s.electronic_transactions_review_status='CLEARED'
     AND s.consumer_protection_review_status='CLEARED'
     AND s.counsel_reference IS NOT NULL
     AND s.reviewed_at IS NOT NULL
     AND (s.next_review_due_at IS NULL OR datetime(s.next_review_due_at)>CURRENT_TIMESTAMP)
)
BEGIN
  SELECT RAISE(ABORT,'customer state transaction pack is not legally cleared');
END;

CREATE TRIGGER IF NOT EXISTS transactions_checkout_insert_requires_customer_state_pack
BEFORE INSERT ON transactions
WHEN NEW.stripe_checkout_session_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM state_jurisdiction_support s
   WHERE s.state_code=upper(NEW.customer_attested_state_code)
     AND s.customer_transaction_status='READY'
     AND s.privacy_review_status='CLEARED'
     AND s.breach_review_status='CLEARED'
     AND s.electronic_transactions_review_status='CLEARED'
     AND s.consumer_protection_review_status='CLEARED'
     AND s.counsel_reference IS NOT NULL
     AND s.reviewed_at IS NOT NULL
     AND (s.next_review_due_at IS NULL OR datetime(s.next_review_due_at)>CURRENT_TIMESTAMP)
)
BEGIN
  SELECT RAISE(ABORT,'Stripe Checkout requires a cleared customer-state jurisdiction pack');
END;

-- If processor truth is complete but legal preconditions are absent, record the truth and leave
-- the transaction non-PROTECTED. Do not throw from the processor update: losing/retrying real
-- Stripe facts would be worse than preserving them with an explicit compliance exception.
CREATE TRIGGER IF NOT EXISTS transactions_note_missing_legal_gate_after_processor_truth
AFTER UPDATE OF payment_at,stripe_application_fee_id,application_fee_gross_confirmed_cents,
                integrity_fee_earned_cents,pricing_carry_reserved_cents
ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED','PROTECTED')
AND NEW.payment_at IS NOT NULL
AND NEW.fee_collection_method='STRIPE_APPLICATION_FEE'
AND NEW.stripe_application_fee_id IS NOT NULL
AND NEW.application_fee_gross_confirmed_cents>0
AND NEW.application_fee_gross_confirmed_cents =
    (NEW.integrity_fee_earned_cents+COALESCE(NEW.pricing_carry_reserved_cents,0))
AND (
  upper(COALESCE(NEW.customer_attested_country_code,''))<>'US'
  OR NEW.customer_attested_state_code IS NULL
  OR length(NEW.customer_attested_state_code)<>2
  OR NEW.customer_attested_at IS NULL
  OR NEW.checkout_legal_gate_at IS NULL
)
BEGIN
  UPDATE transactions
     SET legal_compliance_state='REVIEW_REQUIRED',
         legal_compliance_reason='Processor payment/fee truth is complete, but pre-checkout legal-gate evidence is missing; PROTECTED promotion is blocked.',
         protection_failure_reason='Protection confirmation blocked because pre-checkout legal-gate evidence is missing.',
         bg_fee_earned_cents=0,
         protection_confirmed_at=NULL,
         updated_at=CURRENT_TIMESTAMP
   WHERE id=NEW.id;
END;

-- Recreate the processor classifier with the legal gate in the promotion predicate itself.
-- This makes the outcome independent of nested-trigger/recursive-trigger ordering.
DROP TRIGGER IF EXISTS transactions_confirm_protected_after_processor_truth;
CREATE TRIGGER transactions_confirm_protected_after_processor_truth
AFTER UPDATE OF payment_at,stripe_application_fee_id,application_fee_gross_confirmed_cents,
                integrity_fee_earned_cents,pricing_carry_reserved_cents,
                customer_attested_country_code,customer_attested_state_code,customer_attested_at,checkout_legal_gate_at
ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED')
AND NEW.payment_at IS NOT NULL
AND NEW.fee_collection_method='STRIPE_APPLICATION_FEE'
AND NEW.stripe_application_fee_id IS NOT NULL
AND NEW.application_fee_gross_confirmed_cents>0
AND NEW.application_fee_gross_confirmed_cents =
    (NEW.integrity_fee_earned_cents+COALESCE(NEW.pricing_carry_reserved_cents,0))
AND upper(COALESCE(NEW.customer_attested_country_code,''))='US'
AND NEW.customer_attested_state_code IS NOT NULL
AND length(NEW.customer_attested_state_code)=2
AND NEW.customer_attested_at IS NOT NULL
AND NEW.checkout_legal_gate_at IS NOT NULL
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
