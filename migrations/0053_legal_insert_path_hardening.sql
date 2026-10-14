PRAGMA foreign_keys = ON;

-- Earlier legal gates correctly protected the normal UPDATE-based checkout flow, but an equivalent
-- direct INSERT containing checkout/protection fields could bypass those UPDATE triggers. Production
-- code does not use that path, yet the database must remain fail-closed against future code changes.

CREATE TRIGGER IF NOT EXISTS transactions_checkout_gate_requires_customer_state_pack_insert
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

CREATE TRIGGER IF NOT EXISTS transactions_checkout_requires_customer_attestation_insert
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

CREATE TRIGGER IF NOT EXISTS transactions_checkout_session_requires_customer_state_pack_insert
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

CREATE TRIGGER IF NOT EXISTS transactions_protected_requires_checkout_legal_gate_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification='PROTECTED'
AND (
  upper(COALESCE(NEW.customer_attested_country_code,''))<>'US'
  OR NEW.customer_attested_state_code IS NULL
  OR length(NEW.customer_attested_state_code)<>2
  OR NEW.customer_attested_at IS NULL
  OR NEW.checkout_legal_gate_at IS NULL
  OR NOT EXISTS (
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
)
BEGIN
  SELECT RAISE(ABORT,'PROTECTED insert requires cleared U.S. customer jurisdiction evidence and pre-checkout legal clearance');
END;
