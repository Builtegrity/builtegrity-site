-- Merchant dashboard theme is a presentation-only choice per merchant.
-- No payment data, tenant permissions, or financial evidence are changed.
CREATE TABLE IF NOT EXISTS merchant_dashboard_appearance (
 merchant_id TEXT PRIMARY KEY NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
 template TEXT NOT NULL DEFAULT 'builtegrity'
   CHECK(template IN ('builtegrity','slate','ocean','forest','sand','plum')),
 updated_by TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
