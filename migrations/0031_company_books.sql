PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounting_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'QUICKBOOKS_ONLINE'),
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED','CONNECTING','ACTIVE','REAUTH_REQUIRED','ERROR','DISCONNECTED')),
  realm_id TEXT,
  company_name TEXT,
  scope TEXT,
  access_token_ciphertext TEXT,
  refresh_token_ciphertext TEXT,
  token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  last_sync_started_at TEXT,
  last_sync_succeeded_at TEXT,
  last_error TEXT,
  disconnected_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, realm_id)
);
INSERT OR IGNORE INTO accounting_connections (id, provider, status)
VALUES ('BOOKS-PRIMARY','QUICKBOOKS_ONLINE','NOT_CONFIGURED');

CREATE TABLE IF NOT EXISTS accounting_oauth_states (
  state_token TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider='QUICKBOOKS_ONLINE'),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounting_oauth_states_expiry ON accounting_oauth_states(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS company_books_settings (
  id TEXT PRIMARY KEY CHECK (id='GLOBAL'),
  source_provider TEXT NOT NULL DEFAULT 'QUICKBOOKS_ONLINE' CHECK (source_provider='QUICKBOOKS_ONLINE'),
  accounting_method TEXT NOT NULL DEFAULT 'CASH' CHECK (accounting_method IN ('CASH','ACCRUAL')),
  sync_freshness_hours INTEGER NOT NULL DEFAULT 26 CHECK (sync_freshness_hours BETWEEN 1 AND 168),
  reconciliation_tolerance_micros INTEGER NOT NULL DEFAULT 10000 CHECK (reconciliation_tolerance_micros >= 0),
  fee_income_account_ref TEXT,
  fee_income_account_name TEXT,
  all_business_financial_accounts_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (all_business_financial_accounts_status IN ('UNKNOWN','CONFIRMED')),
  confirmed_by TEXT,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO company_books_settings (id) VALUES ('GLOBAL');

CREATE TABLE IF NOT EXISTS accounting_provider_accounts (
  connection_id TEXT NOT NULL,
  provider_account_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  fully_qualified_name TEXT,
  account_type TEXT,
  account_subtype TEXT,
  classification TEXT,
  active INTEGER CHECK (active IS NULL OR active IN (0,1)),
  current_balance_micros INTEGER,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(connection_id, provider_account_ref),
  FOREIGN KEY(connection_id) REFERENCES accounting_connections(id)
);
CREATE INDEX IF NOT EXISTS idx_accounting_provider_accounts_type ON accounting_provider_accounts(connection_id, account_type, active);

CREATE TABLE IF NOT EXISTS accounting_report_snapshots (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider='QUICKBOOKS_ONLINE'),
  report_type TEXT NOT NULL CHECK (report_type IN ('PROFIT_AND_LOSS','BALANCE_SHEET')),
  period_kind TEXT NOT NULL CHECK (period_kind IN ('MONTH','QUARTER','YEAR','YTD')),
  period_start TEXT NOT NULL,
  period_end_exclusive TEXT NOT NULL,
  accounting_method TEXT NOT NULL CHECK (accounting_method IN ('CASH','ACCRUAL')),
  status TEXT NOT NULL CHECK (status IN ('COMPLETE','NEEDS_REVIEW')),
  currency TEXT NOT NULL DEFAULT 'USD',
  total_income_micros INTEGER,
  cost_of_goods_sold_micros INTEGER,
  total_expenses_micros INTEGER,
  other_income_micros INTEGER,
  other_expenses_micros INTEGER,
  net_income_micros INTEGER,
  total_assets_micros INTEGER,
  total_liabilities_micros INTEGER,
  total_equity_micros INTEGER,
  cash_micros INTEGER,
  accounts_receivable_micros INTEGER,
  accounts_payable_micros INTEGER,
  mapped_fee_income_micros INTEGER,
  raw_object_key TEXT,
  raw_sha256 TEXT NOT NULL,
  provider_report_time TEXT,
  snapshot_json TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(connection_id) REFERENCES accounting_connections(id)
);
CREATE INDEX IF NOT EXISTS idx_accounting_report_snapshots_period ON accounting_report_snapshots(report_type,period_start,period_end_exclusive,generated_at DESC);
CREATE TRIGGER IF NOT EXISTS accounting_report_snapshots_no_update BEFORE UPDATE ON accounting_report_snapshots BEGIN SELECT RAISE(ABORT,'accounting report snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS accounting_report_snapshots_no_delete BEFORE DELETE ON accounting_report_snapshots BEGIN SELECT RAISE(ABORT,'accounting report snapshots are immutable'); END;

CREATE TABLE IF NOT EXISTS accounting_reconciliation_runs (
  id TEXT PRIMARY KEY,
  period_kind TEXT NOT NULL CHECK (period_kind IN ('MONTH','QUARTER','YEAR','YTD')),
  period_start TEXT NOT NULL,
  period_end_exclusive TEXT NOT NULL,
  accounting_method TEXT NOT NULL CHECK (accounting_method IN ('CASH','ACCRUAL')),
  profit_and_loss_snapshot_id TEXT,
  balance_sheet_snapshot_id TEXT,
  internal_fee_revenue_micros INTEGER NOT NULL DEFAULT 0,
  books_mapped_fee_income_micros INTEGER,
  revenue_difference_micros INTEGER,
  tolerance_micros INTEGER NOT NULL,
  bank_account_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('PASS','MAPPING_REQUIRED','MISMATCH','INCOMPLETE_REPORTS','NO_BANK_ACCOUNT','ERROR')),
  reason_codes_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(profit_and_loss_snapshot_id) REFERENCES accounting_report_snapshots(id),
  FOREIGN KEY(balance_sheet_snapshot_id) REFERENCES accounting_report_snapshots(id)
);
CREATE INDEX IF NOT EXISTS idx_accounting_reconciliation_period ON accounting_reconciliation_runs(period_start,period_end_exclusive,created_at DESC);
CREATE TRIGGER IF NOT EXISTS accounting_reconciliation_runs_no_update BEFORE UPDATE ON accounting_reconciliation_runs BEGIN SELECT RAISE(ABORT,'accounting reconciliation runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS accounting_reconciliation_runs_no_delete BEFORE DELETE ON accounting_reconciliation_runs BEGIN SELECT RAISE(ABORT,'accounting reconciliation runs are append-only'); END;

CREATE TABLE IF NOT EXISTS company_books_state (
  id TEXT PRIMARY KEY CHECK (id='GLOBAL'),
  state TEXT NOT NULL DEFAULT 'NOT_CONNECTED' CHECK (state IN ('NOT_CONNECTED','REAUTH_REQUIRED','STALE','INCOMPLETE','MAPPING_REQUIRED','MISMATCH','COMPLETE_VERIFIED')),
  connection_status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  latest_reconciliation_id TEXT,
  reason_codes_json TEXT NOT NULL DEFAULT '["ACCOUNTING_NOT_CONNECTED"]',
  evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(latest_reconciliation_id) REFERENCES accounting_reconciliation_runs(id)
);
INSERT OR IGNORE INTO company_books_state(id) VALUES('GLOBAL');

CREATE TABLE IF NOT EXISTS company_books_state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  connection_status TEXT NOT NULL,
  reconciliation_id TEXT,
  reason_codes_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS company_books_state_events_no_update BEFORE UPDATE ON company_books_state_events BEGIN SELECT RAISE(ABORT,'company books state events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS company_books_state_events_no_delete BEFORE DELETE ON company_books_state_events BEGIN SELECT RAISE(ABORT,'company books state events are append-only'); END;
