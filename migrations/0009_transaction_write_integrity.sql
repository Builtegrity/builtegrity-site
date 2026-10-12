PRAGMA foreign_keys = ON;

ALTER TABLE transactions ADD COLUMN creation_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_creation_idempotency
ON transactions(merchant_id, creation_idempotency_key)
WHERE creation_idempotency_key IS NOT NULL;

-- Once a customer has accepted the transaction terms, the agreement itself must
-- become immutable. Processor reconciliation fields remain writable.
CREATE TRIGGER IF NOT EXISTS transactions_agreement_immutable_after_consent
BEFORE UPDATE OF
  purchase_id,
  merchant_id,
  customer_id,
  transaction_type,
  description,
  amount_cents,
  currency,
  terms_version,
  terms_snapshot,
  terms_snapshot_sha256,
  refund_policy_snapshot,
  cancellation_policy_snapshot,
  consent_accepted,
  consent_accepted_at,
  consent_method
ON transactions
WHEN OLD.consent_accepted = 1 AND (
  NEW.purchase_id IS NOT OLD.purchase_id OR
  NEW.merchant_id IS NOT OLD.merchant_id OR
  NEW.customer_id IS NOT OLD.customer_id OR
  NEW.transaction_type IS NOT OLD.transaction_type OR
  NEW.description IS NOT OLD.description OR
  NEW.amount_cents IS NOT OLD.amount_cents OR
  NEW.currency IS NOT OLD.currency OR
  NEW.terms_version IS NOT OLD.terms_version OR
  NEW.terms_snapshot IS NOT OLD.terms_snapshot OR
  NEW.terms_snapshot_sha256 IS NOT OLD.terms_snapshot_sha256 OR
  NEW.refund_policy_snapshot IS NOT OLD.refund_policy_snapshot OR
  NEW.cancellation_policy_snapshot IS NOT OLD.cancellation_policy_snapshot OR
  NEW.consent_accepted IS NOT OLD.consent_accepted OR
  NEW.consent_accepted_at IS NOT OLD.consent_accepted_at OR
  NEW.consent_method IS NOT OLD.consent_method
)
BEGIN
  SELECT RAISE(ABORT, 'accepted transaction agreement is immutable');
END;
