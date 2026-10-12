PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_watchdog_runs (
  id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('FAST','DEEP','MANUAL')),
  trigger_source TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','OK','WARN','FAIL')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  checks_run INTEGER NOT NULL DEFAULT 0,
  repairs_made INTEGER NOT NULL DEFAULT 0,
  open_alerts INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchdog_runs_started ON system_watchdog_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  subject_type TEXT,
  subject_id TEXT,
  message TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_system_alerts_open ON system_alerts(status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_alerts_subject ON system_alerts(subject_type, subject_id, status);
