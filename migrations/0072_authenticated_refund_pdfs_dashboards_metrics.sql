PRAGMA foreign_keys=ON;
-- Vanity paths are presentation only. A session's merchant_access membership remains
-- the sole authorization for dashboard data and PDF downloads.
CREATE TABLE IF NOT EXISTS merchant_dashboard_routes (
 merchant_id TEXT PRIMARY KEY REFERENCES merchants(id),
 slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 5 AND 75),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Email-link analytics record only access counts/first open; never log browser IP
-- or store the unhashed emailed capability token.
ALTER TABLE merchant_transaction_email_links ADD COLUMN opened_at TEXT;
ALTER TABLE merchant_transaction_email_links ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0 CHECK(open_count>=0);
-- Explicitly auditable refund-PDF access; no contents or recipient identity captured.
CREATE TABLE IF NOT EXISTS merchant_pdf_access_events (
 id TEXT PRIMARY KEY,
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 transaction_id TEXT NOT NULL REFERENCES transactions(id),
 refund_id TEXT,
 event_type TEXT NOT NULL CHECK(event_type IN ('TRANSACTION_PDF','REFUND_PDF')),
 actor_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_merchant_pdf_access ON merchant_pdf_access_events(merchant_id,event_type,occurred_at);
