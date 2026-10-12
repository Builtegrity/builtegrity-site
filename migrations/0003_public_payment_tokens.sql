ALTER TABLE transactions ADD COLUMN payment_access_token TEXT;
ALTER TABLE transactions ADD COLUMN payment_access_expires_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_payment_access_token
ON transactions(payment_access_token)
WHERE payment_access_token IS NOT NULL;

-- Test-only token for the seeded fake transaction. Real transactions receive a random token in the API.
UPDATE transactions
SET payment_access_token = 'test-tx-0001-token'
WHERE id = 'TX-0001' AND payment_access_token IS NULL;
