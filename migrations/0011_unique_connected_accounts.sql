PRAGMA foreign_keys = ON;

-- A Stripe connected account is one external merchant identity. It must never be
-- attached to two Builtegrity merchant records, even if OAuth callbacks race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_unique_processor_account
ON merchants(processor, processor_account_id)
WHERE processor_account_id IS NOT NULL;
