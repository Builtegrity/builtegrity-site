PRAGMA foreign_keys = ON;

-- Financial safety covenant:
-- Builtegrity may not silently scale through known unsafe unit economics,
-- stale financial telemetry, processor exposure, or inadequate reserve coverage.

ALTER TABLE merchants ADD COLUMN stripe_fee_payer TEXT
  CHECK (stripe_fee_payer IS NULL OR stripe_fee_payer IN ('stripe','application'));
ALTER TABLE merchants ADD COLUMN stripe_loss_liability TEXT
  CHECK (stripe_loss_liability IS NULL OR stripe_loss_liability IN ('stripe','application'));
ALTER TABLE merchants ADD COLUMN stripe_financial_responsibility_checked_at TEXT;

-- Existing ACTIVE Stripe Connect merchants must be re-verified before processing is treated as safe.
-- Never infer fee/loss responsibility from historical connection status.
UPDATE merchants
SET status = 'TEST'
WHERE status = 'ACTIVE'
  AND integration_mode = 'STRIPE_CONNECT'
  AND (stripe_fee_payer IS NULL OR stripe_loss_liability IS NULL);

CREATE TABLE IF NOT EXISTS financial_safety_policy (
  id TEXT PRIMARY KEY CHECK (id = 'GLOBAL'),
  enforcement_stage TEXT NOT NULL DEFAULT 'PILOT' CHECK (enforcement_stage IN ('TEST','PILOT','LIVE')),
  position_max_age_hours INTEGER NOT NULL DEFAULT 168 CHECK (position_max_age_hours > 0),
  processor_balance_max_age_minutes INTEGER NOT NULL DEFAULT 120 CHECK (processor_balance_max_age_minutes > 0),
  model_review_max_age_days INTEGER NOT NULL DEFAULT 90 CHECK (model_review_max_age_days > 0),
  target_reserve_months INTEGER NOT NULL DEFAULT 3 CHECK (target_reserve_months >= 1),
  warning_reserve_months INTEGER NOT NULL DEFAULT 2 CHECK (warning_reserve_months >= 1),
  red_reserve_months INTEGER NOT NULL DEFAULT 1 CHECK (red_reserve_months >= 0),
  minimum_floor_margin_ppm INTEGER NOT NULL DEFAULT 500000 CHECK (minimum_floor_margin_ppm >= 0 AND minimum_floor_margin_ppm <= 1000000),
  human_touch_orange_ppm INTEGER NOT NULL DEFAULT 1500 CHECK (human_touch_orange_ppm >= 0),
  human_touch_red_ppm INTEGER NOT NULL DEFAULT 2000 CHECK (human_touch_red_ppm >= human_touch_orange_ppm),
  forbid_interest_bearing_debt INTEGER NOT NULL DEFAULT 1 CHECK (forbid_interest_bearing_debt IN (0,1)),
  forbid_personal_guarantees INTEGER NOT NULL DEFAULT 1 CHECK (forbid_personal_guarantees IN (0,1)),
  require_stripe_fee_payer_stripe INTEGER NOT NULL DEFAULT 1 CHECK (require_stripe_fee_payer_stripe IN (0,1)),
  require_stripe_loss_liability_stripe INTEGER NOT NULL DEFAULT 1 CHECK (require_stripe_loss_liability_stripe IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO financial_safety_policy (id) VALUES ('GLOBAL');

-- Complete company-level financial position. This is append-only evidence, not a mutable dashboard number.
-- A MANUAL snapshot is an attestation until bank/accounting integrations replace the manual source.
CREATE TABLE IF NOT EXISTS financial_position_snapshots (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('MANUAL','BANK','ACCOUNTING','COMPOSITE','SYSTEM_TEST')),
  currency TEXT NOT NULL DEFAULT 'USD',
  unrestricted_cash_micros INTEGER NOT NULL,
  restricted_cash_micros INTEGER NOT NULL DEFAULT 0 CHECK (restricted_cash_micros >= 0),
  monthly_fixed_commitments_micros INTEGER NOT NULL DEFAULT 0 CHECK (monthly_fixed_commitments_micros >= 0),
  liabilities_due_30d_micros INTEGER NOT NULL DEFAULT 0 CHECK (liabilities_due_30d_micros >= 0),
  statutory_reserve_required_micros INTEGER NOT NULL DEFAULT 0 CHECK (statutory_reserve_required_micros >= 0),
  contingency_reserve_required_micros INTEGER NOT NULL DEFAULT 0 CHECK (contingency_reserve_required_micros >= 0),
  interest_bearing_debt_micros INTEGER NOT NULL DEFAULT 0 CHECK (interest_bearing_debt_micros >= 0),
  personal_guarantee_exposure_micros INTEGER NOT NULL DEFAULT 0 CHECK (personal_guarantee_exposure_micros >= 0),
  overdue_critical_obligations_micros INTEGER NOT NULL DEFAULT 0 CHECK (overdue_critical_obligations_micros >= 0),
  attested_complete INTEGER NOT NULL DEFAULT 0 CHECK (attested_complete IN (0,1)),
  actor_ref TEXT,
  notes TEXT,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_financial_position_captured
  ON financial_position_snapshots(captured_at DESC);
CREATE TRIGGER IF NOT EXISTS financial_position_no_update BEFORE UPDATE ON financial_position_snapshots
BEGIN SELECT RAISE(ABORT, 'financial position snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS financial_position_no_delete BEFORE DELETE ON financial_position_snapshots
BEGIN SELECT RAISE(ABORT, 'financial position snapshots are append-only'); END;

-- Processor balance is fetched directly from the Builtegrity platform account.
CREATE TABLE IF NOT EXISTS processor_platform_balance_snapshots (
  id TEXT PRIMARY KEY,
  processor TEXT NOT NULL CHECK (processor IN ('STRIPE')),
  currency TEXT NOT NULL,
  available_micros INTEGER NOT NULL,
  pending_micros INTEGER NOT NULL DEFAULT 0,
  connect_reserved_micros INTEGER NOT NULL DEFAULT 0,
  livemode INTEGER CHECK (livemode IS NULL OR livemode IN (0,1)),
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_processor_platform_balance_captured
  ON processor_platform_balance_snapshots(processor, currency, captured_at DESC);
CREATE TRIGGER IF NOT EXISTS processor_platform_balance_no_update BEFORE UPDATE ON processor_platform_balance_snapshots
BEGIN SELECT RAISE(ABORT, 'processor platform balance snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS processor_platform_balance_no_delete BEFORE DELETE ON processor_platform_balance_snapshots
BEGIN SELECT RAISE(ABORT, 'processor platform balance snapshots are append-only'); END;

-- Cost/pricing assumptions expire. Builtegrity must periodically prove its model still reflects reality.
CREATE TABLE IF NOT EXISTS financial_model_reviews (
  id TEXT PRIMARY KEY,
  pricing_version_id TEXT NOT NULL,
  cost_model_id TEXT NOT NULL,
  reviewed_provider_pricing INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_provider_pricing IN (0,1)),
  reviewed_processor_responsibility INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_processor_responsibility IN (0,1)),
  actor_ref TEXT,
  notes TEXT,
  reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pricing_version_id) REFERENCES pricing_versions(id),
  FOREIGN KEY (cost_model_id) REFERENCES transaction_cost_models(id)
);
CREATE INDEX IF NOT EXISTS idx_financial_model_reviews_reviewed
  ON financial_model_reviews(reviewed_at DESC);
CREATE TRIGGER IF NOT EXISTS financial_model_reviews_no_update BEFORE UPDATE ON financial_model_reviews
BEGIN SELECT RAISE(ABORT, 'financial model reviews are append-only'); END;
CREATE TRIGGER IF NOT EXISTS financial_model_reviews_no_delete BEFORE DELETE ON financial_model_reviews
BEGIN SELECT RAISE(ABORT, 'financial model reviews are append-only'); END;

-- The pricing/cost review performed while PRICE-V1 was pressure-tested is the initial review.
INSERT OR IGNORE INTO financial_model_reviews (
  id, pricing_version_id, cost_model_id,
  reviewed_provider_pricing, reviewed_processor_responsibility,
  actor_ref, notes, reviewed_at
)
SELECT
  'FMR-2026-10-12-V1', p.id, c.id,
  1, 1,
  'SYSTEM:PRICE-V1-PRESSURE-TEST',
  'Initial PRICE-V1 review. Provider pricing and Stripe responsibility assumptions must be re-attested before this review expires.',
  '2026-10-12T23:59:00Z'
FROM pricing_versions p
JOIN transaction_cost_models c
WHERE p.status = 'ACTIVE' AND c.status = 'ACTIVE'
ORDER BY p.effective_from DESC, c.created_at DESC
LIMIT 1;

-- Current machine decision. This row is mutable only because every evaluation is also copied into append-only history.
CREATE TABLE IF NOT EXISTS financial_safety_state (
  id TEXT PRIMARY KEY CHECK (id = 'GLOBAL'),
  state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (state IN ('GREEN','YELLOW','ORANGE','RED','UNKNOWN')),
  enforcement_active INTEGER NOT NULL DEFAULT 0 CHECK (enforcement_active IN (0,1)),
  merchant_onboarding_allowed INTEGER NOT NULL DEFAULT 0 CHECK (merchant_onboarding_allowed IN (0,1)),
  transaction_creation_allowed INTEGER NOT NULL DEFAULT 0 CHECK (transaction_creation_allowed IN (0,1)),
  payment_creation_allowed INTEGER NOT NULL DEFAULT 1 CHECK (payment_creation_allowed IN (0,1)),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  latest_position_at TEXT,
  latest_model_review_at TEXT,
  latest_processor_balance_at TEXT,
  unrestricted_cash_micros INTEGER,
  reserve_required_micros INTEGER,
  reserve_surplus_micros INTEGER,
  runway_months REAL,
  processor_available_micros INTEGER,
  processor_pending_micros INTEGER,
  processor_connect_reserved_micros INTEGER,
  floor_planning_contribution_micros INTEGER,
  floor_planning_margin_ppm INTEGER,
  observed_human_touch_ppm INTEGER,
  evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO financial_safety_state (id) VALUES ('GLOBAL');

CREATE TABLE IF NOT EXISTS financial_safety_evaluations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('GREEN','YELLOW','ORANGE','RED','UNKNOWN')),
  enforcement_active INTEGER NOT NULL CHECK (enforcement_active IN (0,1)),
  merchant_onboarding_allowed INTEGER NOT NULL CHECK (merchant_onboarding_allowed IN (0,1)),
  transaction_creation_allowed INTEGER NOT NULL CHECK (transaction_creation_allowed IN (0,1)),
  payment_creation_allowed INTEGER NOT NULL CHECK (payment_creation_allowed IN (0,1)),
  reason_codes_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_financial_safety_evaluated
  ON financial_safety_evaluations(evaluated_at DESC);
CREATE TRIGGER IF NOT EXISTS financial_safety_evaluations_no_update BEFORE UPDATE ON financial_safety_evaluations
BEGIN SELECT RAISE(ABORT, 'financial safety evaluations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS financial_safety_evaluations_no_delete BEFORE DELETE ON financial_safety_evaluations
BEGIN SELECT RAISE(ABORT, 'financial safety evaluations are append-only'); END;

-- An ACTIVE Stripe Connect merchant may never be activated while Builtegrity is the payer of
-- processing fees or bearer of connected-account payment losses.
CREATE TRIGGER IF NOT EXISTS merchants_financial_responsibility_safe_on_active_insert
BEFORE INSERT ON merchants
WHEN NEW.status = 'ACTIVE' AND NEW.integration_mode = 'STRIPE_CONNECT' AND (
  NEW.stripe_fee_payer IS NOT 'stripe' OR NEW.stripe_loss_liability IS NOT 'stripe'
)
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE Stripe Connect merchant requires Stripe-paid fees and Stripe-owned payment-loss liability');
END;

CREATE TRIGGER IF NOT EXISTS merchants_financial_responsibility_safe_on_active_update
BEFORE UPDATE OF status, integration_mode, stripe_fee_payer, stripe_loss_liability ON merchants
WHEN NEW.status = 'ACTIVE' AND NEW.integration_mode = 'STRIPE_CONNECT' AND (
  NEW.stripe_fee_payer IS NOT 'stripe' OR NEW.stripe_loss_liability IS NOT 'stripe'
)
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE Stripe Connect merchant requires Stripe-paid fees and Stripe-owned payment-loss liability');
END;

-- Defense in depth: even if application code regresses, an ACTIVE unsafe merchant cannot receive a new transaction.
CREATE TRIGGER IF NOT EXISTS transactions_reject_unsafe_active_stripe_merchant
BEFORE INSERT ON transactions
WHEN EXISTS (
  SELECT 1 FROM merchants m
  WHERE m.id = NEW.merchant_id
    AND m.status = 'ACTIVE'
    AND m.integration_mode = 'STRIPE_CONNECT'
    AND (m.stripe_fee_payer IS NOT 'stripe' OR m.stripe_loss_liability IS NOT 'stripe')
)
BEGIN
  SELECT RAISE(ABORT, 'transaction rejected: merchant financial responsibility is unsafe');
END;

-- Dedicated solvency case: machine brake first, bounded human action second.
INSERT OR IGNORE INTO internal_case_types
(code, category, default_severity, title, operator_summary, escalation_target, sla_minutes, auto_verify_rule) VALUES
('FINANCIAL_SOLVENCY_RISK','FINANCE','CRITICAL','Financial safety brake engaged',
 'The financial safety engine detected stale/unknown telemetry, unsafe processor exposure, insufficient reserve coverage, or unit economics approaching the loss boundary. Do not bypass the brake; correct the source data or economics and let the machine re-verify.',
 'FINANCE',60,'financial safety watchdog alert resolves');

INSERT OR IGNORE INTO internal_case_actions
(case_type_code, action_code, label, action_kind, action_handler, sequence) VALUES
('FINANCIAL_SOLVENCY_RISK','CONFIRM_FINANCIAL_INPUTS','Confirm financial inputs updated','FINANCE','EXTERNAL_CONFIRMATION',1),
('FINANCIAL_SOLVENCY_RISK','ESCALATE_FINANCE','Escalate financial safety review','FINANCE','ESCALATE_FINANCE',2),
('FINANCIAL_SOLVENCY_RISK','ACTIVATE_KILL_SWITCH','Stop all new platform activity','SECURITY','ACTIVATE_KILL_SWITCH',3);

CREATE VIEW IF NOT EXISTS financial_safety_dashboard AS
SELECT
  s.*,
  p.position_max_age_hours,
  p.processor_balance_max_age_minutes,
  p.model_review_max_age_days,
  p.target_reserve_months,
  p.warning_reserve_months,
  p.red_reserve_months,
  p.minimum_floor_margin_ppm,
  p.human_touch_orange_ppm,
  p.human_touch_red_ppm,
  p.forbid_interest_bearing_debt,
  p.forbid_personal_guarantees
FROM financial_safety_state s
JOIN financial_safety_policy p ON p.id = 'GLOBAL'
WHERE s.id = 'GLOBAL';
