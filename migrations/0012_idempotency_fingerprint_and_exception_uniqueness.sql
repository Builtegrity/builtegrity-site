PRAGMA foreign_keys = ON;

-- Preserve the normalized request fingerprint used to create an idempotent
-- transaction. Reusing the same merchant-scoped idempotency key with a different
-- request must be rejected rather than silently returning the wrong transaction.
ALTER TABLE transactions ADD COLUMN creation_request_sha256 TEXT;

-- Only one unresolved exception of a given type may exist per transaction.
-- This closes the race where two concurrent Stripe events both observe no open
-- exception and insert duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exceptions_unique_open
ON transaction_exceptions(transaction_id, exception_type)
WHERE status = 'OPEN';
