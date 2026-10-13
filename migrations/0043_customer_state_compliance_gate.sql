PRAGMA foreign_keys = ON;

-- Merchant-state authorization and customer-state transaction law are separate questions.
-- A merchant being cleared in one state must not silently authorize Builtegrity to process
-- customer transactions from every other U.S. jurisdiction.
ALTER TABLE state_jurisdiction_support ADD COLUMN customer_transaction_status TEXT NOT NULL DEFAULT 'BLOCKED'
  CHECK (customer_transaction_status IN ('BLOCKED','COUNSEL_REVIEW','READY'));
ALTER TABLE state_jurisdiction_support ADD COLUMN consumer_protection_review_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (consumer_protection_review_status IN ('PENDING','CLEARED','BLOCKED'));
ALTER TABLE state_jurisdiction_support ADD COLUMN customer_transaction_notes TEXT;

UPDATE state_jurisdiction_support
   SET customer_transaction_status=CASE WHEN state_code='RI' THEN 'COUNSEL_REVIEW' ELSE 'BLOCKED' END,
       consumer_protection_review_status='PENDING',
       updated_at=CURRENT_TIMESTAMP;

-- The customer must attest a state whose customer-facing privacy/breach/e-contract/consumer
-- protection pack has been reviewed before the runtime can mark the legal checkout gate complete.
CREATE TRIGGER IF NOT EXISTS transactions_checkout_gate_requires_customer_state_pack
BEFORE UPDATE OF checkout_legal_gate_at ON transactions
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

-- Defense in depth if a future code path attempts to attach Stripe Checkout without first
-- writing checkout_legal_gate_at through the normal runtime.
CREATE TRIGGER IF NOT EXISTS transactions_checkout_session_requires_customer_state_pack
BEFORE UPDATE OF stripe_checkout_session_id ON transactions
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

INSERT OR IGNORE INTO compliance_obligations
(id,jurisdiction,category,obligation_type,title,requirement_summary,trigger_summary,source_name,source_url,status)
VALUES
('COMP-US-CUSTOMER-STATE-PACK','US-STATE','JURISDICTION','REQUIRED','Customer-state transaction jurisdiction matrix',
 'Maintain a separate state-by-state customer transaction matrix covering privacy, breach, electronic contracting and general consumer-protection requirements. Do not infer customer-state clearance from the merchant business state.',
 'Before accepting a protected payment from a customer resident/billed in a state.',
 'Builtegrity state-jurisdiction compliance control','https://www.ftc.gov/legal-library/browse/statutes/federal-trade-commission-act',
 'OPEN');
