-- Enforce one unresolved exception of each type per transaction.
-- Preflight duplicates before migration: SELECT transaction_id,exception_type,COUNT(*) FROM transaction_exceptions WHERE status='OPEN' GROUP BY transaction_id,exception_type HAVING COUNT(*)>1;
-- Resolve any preexisting duplicates with evidence before applying; never silently delete incident records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exception_unique_open_v2
ON transaction_exceptions(transaction_id,exception_type)
WHERE status='OPEN';
