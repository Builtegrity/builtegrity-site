PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS transaction_integrity_verifications (
 transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
 verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 integrity_status TEXT NOT NULL CHECK(integrity_status IN ('INCOMPLETE','ACCOUNTED','NEEDS_ATTENTION')),
 exception_status TEXT NOT NULL,
 checks INTEGER NOT NULL DEFAULT 1,
 last_change_at TEXT,
 last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_integrity_verifications_due ON transaction_integrity_verifications(verified_at,transaction_id);
