CREATE TABLE IF NOT EXISTS stripe_oauth_states (
  state_token TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);
CREATE INDEX IF NOT EXISTS idx_stripe_oauth_states_merchant ON stripe_oauth_states(merchant_id, created_at);
