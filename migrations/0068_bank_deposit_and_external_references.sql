PRAGMA foreign_keys=ON;
-- Bank evidence is voluntary and independent of Stripe/Square payout reporting.
-- Never store bank login credentials or unencrypted provider tokens.
CREATE TABLE IF NOT EXISTS merchant_bank_connections (
 id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
 provider TEXT NOT NULL DEFAULT 'PLAID' CHECK(provider='PLAID'),
 item_id TEXT NOT NULL UNIQUE, access_token_ciphertext TEXT NOT NULL,
 access_token_iv TEXT NOT NULL, cursor TEXT,
 status TEXT NOT NULL DEFAULT 'CONNECTED'
   CHECK(status IN('CONNECTED','REAUTH_REQUIRED','REPLACED','DISCONNECTED','ERROR')),
 linked_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_sync_at TEXT, last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bank_conn_merchant ON merchant_bank_connections(merchant_id,status);
CREATE TABLE IF NOT EXISTS merchant_bank_accounts (
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 connection_id TEXT NOT NULL REFERENCES merchant_bank_connections(id),
 provider_account_id TEXT NOT NULL,
 account_name TEXT NOT NULL, institution_name TEXT, mask TEXT,
 account_type TEXT,account_subtype TEXT,
 is_payout_target INTEGER NOT NULL DEFAULT 0 CHECK(is_payout_target IN(0,1)),
 status TEXT NOT NULL DEFAULT 'AVAILABLE'
   CHECK(status IN('AVAILABLE','REVOKED')),
 linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(connection_id,provider_account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_bank_payout_target
 ON merchant_bank_accounts(merchant_id) WHERE is_payout_target=1 AND status='AVAILABLE';
CREATE TABLE IF NOT EXISTS merchant_bank_deposit_observations (
 provider_transaction_id TEXT PRIMARY KEY,
 connection_id TEXT NOT NULL REFERENCES merchant_bank_connections(id),
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 provider_account_id TEXT NOT NULL,
 credit_cents INTEGER NOT NULL CHECK(credit_cents>0),
 currency TEXT NOT NULL DEFAULT 'USD',
 display_name TEXT, pending INTEGER NOT NULL CHECK(pending IN(0,1)),
 bank_transaction_date TEXT,
 bank_posted_at TEXT,
 removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN(0,1)),
 first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bank_deposit_match
 ON merchant_bank_deposit_observations(merchant_id,provider_account_id,credit_cents,removed,pending);
-- A match is to a whole processor payout batch, never an individual card charge.
CREATE TABLE IF NOT EXISTS processor_bank_payout_matches (
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 processor TEXT NOT NULL CHECK(processor IN('STRIPE','SQUARE')),
 payout_id TEXT NOT NULL,
 bank_transaction_id TEXT NOT NULL REFERENCES merchant_bank_deposit_observations(provider_transaction_id),
 matched_amount_cents INTEGER NOT NULL CHECK(matched_amount_cents>0),
 status TEXT NOT NULL CHECK(status IN('BANK_PENDING','BANK_POSTED','REVOKED')),
 observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 bank_posted_at TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(merchant_id,processor,payout_id),
 UNIQUE(bank_transaction_id)
);
CREATE TABLE IF NOT EXISTS merchant_external_record_links (
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 external_system TEXT NOT NULL,
 record_kind TEXT NOT NULL CHECK(record_kind IN('CUSTOMER','PURCHASE','TRANSACTION')),
 external_record_id TEXT NOT NULL,
 internal_record_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(merchant_id,external_system,record_kind,external_record_id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_external_internal
 ON merchant_external_record_links(merchant_id,record_kind,internal_record_id);

-- Merchant-owned external payment/receipt ID, separate from Builtegrity TX ID and
-- reusable invoice/customer references. Unique within a merchant to prevent mislinks.
ALTER TABLE transactions ADD COLUMN merchant_payment_reference TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_payment_reference
  ON transactions(merchant_id,merchant_payment_reference)
  WHERE merchant_payment_reference IS NOT NULL;
