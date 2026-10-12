PRAGMA foreign_keys = ON;

-- Internal case engine: humans may operate the machine, but may not become the workflow.

ALTER TABLE system_alerts ADD COLUMN resolution_owner TEXT NOT NULL DEFAULT 'SYSTEM'
  CHECK (resolution_owner IN ('SYSTEM','MERCHANT','INTERNAL'));
ALTER TABLE system_alerts ADD COLUMN case_type_code TEXT;
ALTER TABLE system_alerts ADD COLUMN internal_case_id TEXT;
ALTER TABLE system_alerts ADD COLUMN merchant_action_code TEXT;

ALTER TABLE merchants ADD COLUMN stripe_charges_enabled INTEGER CHECK (stripe_charges_enabled IS NULL OR stripe_charges_enabled IN (0,1));
ALTER TABLE merchants ADD COLUMN stripe_payouts_enabled INTEGER CHECK (stripe_payouts_enabled IS NULL OR stripe_payouts_enabled IN (0,1));
ALTER TABLE merchants ADD COLUMN stripe_details_submitted INTEGER CHECK (stripe_details_submitted IS NULL OR stripe_details_submitted IN (0,1));
ALTER TABLE merchants ADD COLUMN stripe_payout_interval TEXT;
ALTER TABLE merchants ADD COLUMN stripe_requirements_due_json TEXT;
ALTER TABLE merchants ADD COLUMN stripe_last_account_update_at TEXT;

CREATE TABLE IF NOT EXISTS platform_controls (
  id TEXT PRIMARY KEY CHECK (id = 'GLOBAL'),
  transaction_creation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (transaction_creation_enabled IN (0,1)),
  payment_creation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (payment_creation_enabled IN (0,1)),
  merchant_onboarding_enabled INTEGER NOT NULL DEFAULT 1 CHECK (merchant_onboarding_enabled IN (0,1)),
  reason TEXT,
  source_case_id TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO platform_controls (id) VALUES ('GLOBAL');

CREATE TABLE IF NOT EXISTS platform_control_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  control_id TEXT NOT NULL DEFAULT 'GLOBAL',
  transaction_creation_enabled INTEGER NOT NULL,
  payment_creation_enabled INTEGER NOT NULL,
  merchant_onboarding_enabled INTEGER NOT NULL,
  reason TEXT,
  source_case_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','OPERATOR')),
  actor_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (control_id) REFERENCES platform_controls(id)
);
CREATE TRIGGER IF NOT EXISTS platform_control_events_no_update BEFORE UPDATE ON platform_control_events
BEGIN SELECT RAISE(ABORT, 'platform_control_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS platform_control_events_no_delete BEFORE DELETE ON platform_control_events
BEGIN SELECT RAISE(ABORT, 'platform_control_events are append-only'); END;

CREATE TABLE IF NOT EXISTS internal_case_types (
  code TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  default_severity TEXT NOT NULL CHECK (default_severity IN ('WARN','ERROR','CRITICAL')),
  runbook_version TEXT NOT NULL DEFAULT 'V1',
  title TEXT NOT NULL,
  operator_summary TEXT NOT NULL,
  escalation_target TEXT NOT NULL,
  sla_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (sla_minutes > 0),
  auto_verify_rule TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS internal_cases (
  id TEXT PRIMARY KEY,
  case_type_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_PROVIDER','ESCALATED','QUARANTINED','RESOLVED')),
  severity TEXT NOT NULL CHECK (severity IN ('WARN','ERROR','CRITICAL')),
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  transaction_id TEXT,
  merchant_id TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  machine_context_json TEXT,
  automation_attempts_json TEXT,
  recommended_action TEXT,
  runbook_version TEXT NOT NULL,
  escalation_target TEXT NOT NULL,
  first_human_at TEXT,
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution TEXT,
  FOREIGN KEY (case_type_code) REFERENCES internal_case_types(code),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);
CREATE INDEX IF NOT EXISTS idx_internal_cases_queue ON internal_cases(status, severity, opened_at);
CREATE INDEX IF NOT EXISTS idx_internal_cases_subject ON internal_cases(subject_type, subject_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_cases_open_source
  ON internal_cases(case_type_code, source_type, source_ref)
  WHERE status <> 'RESOLVED';

CREATE TABLE IF NOT EXISTS internal_case_actions (
  case_type_code TEXT NOT NULL,
  action_code TEXT NOT NULL,
  label TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind IN ('AUTO','OPERATOR','PROVIDER','ENGINEERING','SECURITY','LEGAL','FINANCE')),
  action_handler TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 1,
  requires_human INTEGER NOT NULL DEFAULT 1 CHECK (requires_human IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY (case_type_code, action_code),
  FOREIGN KEY (case_type_code) REFERENCES internal_case_types(code)
);

-- Runbooks must stay stupid-simple: never expose more than three enabled human actions for a case type.
CREATE TRIGGER IF NOT EXISTS internal_case_actions_max_three_human_insert
BEFORE INSERT ON internal_case_actions
WHEN NEW.requires_human = 1 AND NEW.enabled = 1 AND
     (SELECT COUNT(*) FROM internal_case_actions WHERE case_type_code = NEW.case_type_code AND requires_human = 1 AND enabled = 1) >= 3
BEGIN
  SELECT RAISE(ABORT, 'internal case types may expose at most three enabled human actions');
END;
CREATE TRIGGER IF NOT EXISTS internal_case_actions_max_three_human_update
BEFORE UPDATE OF requires_human, enabled, case_type_code ON internal_case_actions
WHEN NEW.requires_human = 1 AND NEW.enabled = 1 AND
     (SELECT COUNT(*) FROM internal_case_actions WHERE case_type_code = NEW.case_type_code AND requires_human = 1 AND enabled = 1 AND action_code <> OLD.action_code) >= 3
BEGIN
  SELECT RAISE(ABORT, 'internal case types may expose at most three enabled human actions');
END;

CREATE TABLE IF NOT EXISTS internal_case_action_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  action_code TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','OPERATOR')),
  actor_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  input_json TEXT,
  output_json TEXT,
  error_text TEXT,
  human_seconds INTEGER NOT NULL DEFAULT 0 CHECK (human_seconds >= 0),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY (case_id) REFERENCES internal_cases(id)
);
CREATE INDEX IF NOT EXISTS idx_case_action_runs_case ON internal_case_action_runs(case_id, started_at);
CREATE TRIGGER IF NOT EXISTS internal_case_action_runs_no_update_after_finish
BEFORE UPDATE ON internal_case_action_runs
WHEN OLD.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished internal case action runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS internal_case_action_runs_no_delete
BEFORE DELETE ON internal_case_action_runs
BEGIN SELECT RAISE(ABORT, 'internal case action runs are append-only'); END;

CREATE TABLE IF NOT EXISTS record_holds (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  FOREIGN KEY (case_id) REFERENCES internal_cases(id)
);
CREATE INDEX IF NOT EXISTS idx_record_holds_subject ON record_holds(subject_type, subject_id, status);

INSERT OR IGNORE INTO id_counters (prefix, next_value) VALUES ('CASE', 1), ('CAR', 1), ('HOLD', 1);

INSERT OR IGNORE INTO internal_case_types
(code, category, default_severity, title, operator_summary, escalation_target, sla_minutes, auto_verify_rule) VALUES
('WEBHOOK_IRRECOVERABLE','WEBHOOK','CRITICAL','Webhook could not self-recover','Stripe event processing remained failed after automatic recovery attempts.','ENGINEERING',60,'source alert resolves'),
('PROCESSOR_RECORD_MISMATCH','TRANSACTION','CRITICAL','Processor record mismatch','Builtegrity and Stripe do not agree on required processor records.','ENGINEERING',60,'processor IDs reconcile'),
('FEE_RECONCILIATION_FAILURE','ECONOMICS','ERROR','Integrity fee mismatch','Expected Builtegrity application-fee state cannot be reconciled automatically.','FINANCE',240,'fee collected is reconciled'),
('PLATFORM_FINANCIAL_MISMATCH','FINANCE','CRITICAL','Platform financial mismatch','Platform-level money totals disagree after automated reconciliation.','FINANCE',60,'financial control reconciles'),
('SECURITY_INCIDENT','SECURITY','CRITICAL','Security incident','Possible unauthorized access or credential exposure requires containment judgment.','SECURITY',15,'security owner clears incident'),
('DATA_INTEGRITY_FAILURE','DATA','CRITICAL','Data integrity failure','A required relationship or derived state cannot be repaired deterministically.','ENGINEERING',60,'integrity invariant passes'),
('EVIDENCE_RECOVERY_FAILURE','RECORDS','ERROR','Evidence recovery failure','Required retained evidence cannot be regenerated or recovered automatically.','ENGINEERING',240,'record/evidence integrity passes'),
('PLATFORM_PROVIDER_ACTION_REQUIRED','PROVIDER','ERROR','Platform provider action required','A Builtegrity-owned provider account requires an action the merchant cannot perform.','ENGINEERING',240,'provider health check passes'),
('LEGAL_REGULATORY_REQUEST','LEGAL','CRITICAL','Legal or regulatory request','A formal legal, regulatory, privacy, or retention matter requires authorized review.','LEGAL',60,'authorized legal resolution recorded'),
('MERCHANT_OWNERSHIP_DISPUTE','ACCESS','CRITICAL','Merchant ownership dispute','Conflicting humans claim control of a merchant account.','SECURITY',240,'ownership decision recorded'),
('FRAUD_ABUSE_REVIEW','RISK','CRITICAL','Fraud or abuse review','Evidence suggests intentional platform abuse requiring suspension/termination judgment.','SECURITY',60,'risk decision recorded'),
('UNKNOWN_EXCEPTION','ENGINEERING','ERROR','Unknown exception','The machine reached a state with no permanent rule. Fix once, then create the permanent rule.','ENGINEERING',60,'new permanent rule and regression test exist'),
('CATASTROPHIC_INCIDENT','INCIDENT','CRITICAL','Catastrophic platform incident','Cross-tenant, mass-financial, or mass-state risk requires an immediate platform stop.','ENGINEERING',15,'incident owner verifies safe resume');

INSERT OR IGNORE INTO internal_case_actions
(case_type_code, action_code, label, action_kind, action_handler, sequence) VALUES
('WEBHOOK_IRRECOVERABLE','REFRESH_PROCESSOR_STATE','Reconcile from Stripe','OPERATOR','REFRESH_STRIPE_TRANSACTION',1),
('WEBHOOK_IRRECOVERABLE','CONFIRM_PROVIDER_ACTION','Confirm provider action completed','PROVIDER','EXTERNAL_CONFIRMATION',2),
('WEBHOOK_IRRECOVERABLE','ESCALATE_ENGINEERING','Escalate to engineering','ENGINEERING','ESCALATE_ENGINEERING',3),

('PROCESSOR_RECORD_MISMATCH','REFRESH_PROCESSOR_STATE','Reconcile from Stripe','OPERATOR','REFRESH_STRIPE_TRANSACTION',1),
('PROCESSOR_RECORD_MISMATCH','REBUILD_DERIVED_STATE','Rebuild derived state','OPERATOR','REBUILD_DERIVED_STATE',2),
('PROCESSOR_RECORD_MISMATCH','ESCALATE_ENGINEERING','Escalate to engineering','ENGINEERING','ESCALATE_ENGINEERING',3),

('FEE_RECONCILIATION_FAILURE','REFRESH_PROCESSOR_STATE','Reconcile fee from Stripe','OPERATOR','REFRESH_STRIPE_TRANSACTION',1),
('FEE_RECONCILIATION_FAILURE','CONFIRM_REVENUE_LOSS','Record unrecoverable fee loss','FINANCE','EXTERNAL_CONFIRMATION',2),
('FEE_RECONCILIATION_FAILURE','ESCALATE_FINANCE','Escalate to finance','FINANCE','ESCALATE_FINANCE',3),

('PLATFORM_FINANCIAL_MISMATCH','REBUILD_DERIVED_STATE','Rebuild financial summary','OPERATOR','REBUILD_DERIVED_STATE',1),
('PLATFORM_FINANCIAL_MISMATCH','CONFIRM_EXTERNAL_RECONCILIATION','Confirm external reconciliation','FINANCE','EXTERNAL_CONFIRMATION',2),
('PLATFORM_FINANCIAL_MISMATCH','ESCALATE_FINANCE','Escalate to finance','FINANCE','ESCALATE_FINANCE',3),

('SECURITY_INCIDENT','QUARANTINE_SUBJECT','Quarantine affected subject','SECURITY','QUARANTINE_SUBJECT',1),
('SECURITY_INCIDENT','MARK_FALSE_POSITIVE','Mark false positive','SECURITY','MARK_FALSE_POSITIVE',2),
('SECURITY_INCIDENT','ESCALATE_SECURITY','Escalate security incident','SECURITY','ESCALATE_SECURITY',3),

('DATA_INTEGRITY_FAILURE','REBUILD_DERIVED_STATE','Rebuild derived state','OPERATOR','REBUILD_DERIVED_STATE',1),
('DATA_INTEGRITY_FAILURE','QUARANTINE_SUBJECT','Quarantine affected subject','OPERATOR','QUARANTINE_SUBJECT',2),
('DATA_INTEGRITY_FAILURE','ESCALATE_ENGINEERING','Escalate to engineering','ENGINEERING','ESCALATE_ENGINEERING',3),

('EVIDENCE_RECOVERY_FAILURE','CONFIRM_RECOVERY','Confirm evidence recovery','OPERATOR','EXTERNAL_CONFIRMATION',1),
('EVIDENCE_RECOVERY_FAILURE','PRESERVE_RECORDS','Place preservation hold','LEGAL','PRESERVE_RECORDS',2),
('EVIDENCE_RECOVERY_FAILURE','ESCALATE_ENGINEERING','Escalate to engineering','ENGINEERING','ESCALATE_ENGINEERING',3),

('PLATFORM_PROVIDER_ACTION_REQUIRED','CONFIRM_PROVIDER_ACTION','Confirm provider action completed','PROVIDER','EXTERNAL_CONFIRMATION',1),
('PLATFORM_PROVIDER_ACTION_REQUIRED','MARK_FALSE_POSITIVE','Mark false positive','OPERATOR','MARK_FALSE_POSITIVE',2),
('PLATFORM_PROVIDER_ACTION_REQUIRED','ESCALATE_ENGINEERING','Escalate to engineering','ENGINEERING','ESCALATE_ENGINEERING',3),

('LEGAL_REGULATORY_REQUEST','PRESERVE_RECORDS','Place preservation hold','LEGAL','PRESERVE_RECORDS',1),
('LEGAL_REGULATORY_REQUEST','ESCALATE_LEGAL','Send to authorized legal review','LEGAL','ESCALATE_LEGAL',2),
('LEGAL_REGULATORY_REQUEST','MARK_RESOLVED','Record authorized resolution','LEGAL','MARK_RESOLVED',3),

('MERCHANT_OWNERSHIP_DISPUTE','PAUSE_MERCHANT','Pause merchant access/processing','SECURITY','PAUSE_MERCHANT',1),
('MERCHANT_OWNERSHIP_DISPUTE','CONFIRM_OWNERSHIP_DECISION','Record ownership decision','SECURITY','EXTERNAL_CONFIRMATION',2),
('MERCHANT_OWNERSHIP_DISPUTE','ESCALATE_SECURITY','Escalate ownership review','SECURITY','ESCALATE_SECURITY',3),

('FRAUD_ABUSE_REVIEW','PAUSE_MERCHANT','Pause merchant','SECURITY','PAUSE_MERCHANT',1),
('FRAUD_ABUSE_REVIEW','RESTORE_MERCHANT','Restore verified merchant','SECURITY','RESTORE_MERCHANT',2),
('FRAUD_ABUSE_REVIEW','ESCALATE_SECURITY','Escalate risk review','SECURITY','ESCALATE_SECURITY',3),

('UNKNOWN_EXCEPTION','QUARANTINE_SUBJECT','Quarantine affected subject','OPERATOR','QUARANTINE_SUBJECT',1),
('UNKNOWN_EXCEPTION','CONFIRM_PERMANENT_RULE','Confirm permanent rule added','ENGINEERING','EXTERNAL_CONFIRMATION',2),
('UNKNOWN_EXCEPTION','ESCALATE_ENGINEERING','Escalate to engineering','ENGINEERING','ESCALATE_ENGINEERING',3),

('CATASTROPHIC_INCIDENT','ACTIVATE_KILL_SWITCH','Stop new transactions and payments','SECURITY','ACTIVATE_KILL_SWITCH',1),
('CATASTROPHIC_INCIDENT','RESUME_AFTER_VERIFY','Resume only after verification','SECURITY','RESUME_AFTER_VERIFY',2),
('CATASTROPHIC_INCIDENT','ESCALATE_ENGINEERING','Escalate incident','ENGINEERING','ESCALATE_ENGINEERING',3);

CREATE VIEW IF NOT EXISTS internal_case_queue AS
SELECT
  c.id, c.case_type_code, t.title, t.category, c.status, c.severity,
  c.subject_type, c.subject_id, c.transaction_id, c.merchant_id,
  c.summary, c.recommended_action, c.escalation_target,
  c.first_human_at, c.opened_at, c.updated_at,
  CAST((julianday('now') - julianday(c.opened_at)) * 24 * 60 AS INTEGER) AS age_minutes,
  t.sla_minutes
FROM internal_cases c
JOIN internal_case_types t ON t.code = c.case_type_code
WHERE c.status <> 'RESOLVED';

CREATE VIEW IF NOT EXISTS internal_operations_metrics AS
SELECT
  (SELECT COUNT(*) FROM transactions) AS total_transactions,
  (SELECT COUNT(DISTINCT transaction_id) FROM internal_cases WHERE first_human_at IS NOT NULL AND transaction_id IS NOT NULL) AS human_touched_transactions,
  (SELECT COUNT(*) FROM internal_cases WHERE case_type_code = 'UNKNOWN_EXCEPTION') AS unknown_exception_cases,
  (SELECT COALESCE(SUM(human_seconds),0) FROM internal_case_action_runs WHERE status = 'SUCCEEDED') AS human_seconds_total,
  CASE WHEN (SELECT COUNT(*) FROM transactions) = 0 THEN 0.0 ELSE
    (SELECT COUNT(DISTINCT transaction_id) * 1.0 FROM internal_cases WHERE first_human_at IS NOT NULL AND transaction_id IS NOT NULL) /
    (SELECT COUNT(*) FROM transactions) END AS human_touch_rate,
  CASE WHEN (SELECT COUNT(*) FROM transactions) = 0 THEN 0.0 ELSE
    ((SELECT COALESCE(SUM(human_seconds),0) FROM internal_case_action_runs WHERE status = 'SUCCEEDED') / 60.0) * 1000.0 /
    (SELECT COUNT(*) FROM transactions) END AS human_minutes_per_1000_transactions;
