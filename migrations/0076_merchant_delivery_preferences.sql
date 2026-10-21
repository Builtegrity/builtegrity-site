-- Merchant-facing presentation settings, separate from canonical transaction evidence.
-- All options default OFF; dashboard preference never changes verified transaction facts.
CREATE TABLE IF NOT EXISTS merchant_transaction_delivery_preferences (
 merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
 pdf_theme_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(pdf_theme_opt_in IN(0,1)),
 customer_email_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(customer_email_opt_in IN(0,1)),
 customer_email_enabled_at TEXT,
 email_theme_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(email_theme_opt_in IN(0,1)),
 receipt_mode TEXT NOT NULL DEFAULT 'SUPPLEMENT' CHECK(receipt_mode IN ('SUPPLEMENT','PRIMARY')),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customer_transaction_email_deliveries (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 transaction_id TEXT NOT NULL REFERENCES transactions(id),
 event_kind TEXT NOT NULL CHECK(event_kind IN ('PAYMENT_SUCCEEDED','REFUND_SUCCEEDED','REFUND_PARTIAL')),
 event_reference TEXT NOT NULL,
 recipient_email TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CLAIMED','SENT','RETRY','FAILED','SKIPPED')),
 attempts INTEGER NOT NULL DEFAULT 0,
 provider_message_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 claimed_at TEXT,
 next_attempt_at TEXT,
 sent_at TEXT,
 last_error TEXT,
 UNIQUE(merchant_id,transaction_id,event_kind,event_reference)
);
CREATE INDEX IF NOT EXISTS idx_customer_transaction_email_queue ON customer_transaction_email_deliveries(state,next_attempt_at);
