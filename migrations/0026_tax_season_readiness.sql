PRAGMA foreign_keys = ON;

-- Tax-season readiness is reconciliation-first, not tax-filing automation.
-- Builtegrity preserves processor truth and produces year-end payment activity records,
-- while Stripe remains the expected 1099-K filer for V1 Standard Connect merchants.
-- Do not store raw SSNs/EINs/TINs in Builtegrity's transaction database for this feature.

-- Merchant processor/tax-responsibility classification.
ALTER TABLE merchants ADD COLUMN stripe_account_type TEXT
  CHECK (stripe_account_type IS NULL OR stripe_account_type IN ('standard','express','custom','none'));
ALTER TABLE merchants ADD COLUMN stripe_requirement_collection TEXT
  CHECK (stripe_requirement_collection IS NULL OR stripe_requirement_collection IN ('stripe','application'));
ALTER TABLE merchants ADD COLUMN stripe_dashboard_type TEXT;
ALTER TABLE merchants ADD COLUMN tax_form_responsibility TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (tax_form_responsibility IN ('STRIPE_EXPECTED','PLATFORM_REVIEW_REQUIRED','UNKNOWN'));
ALTER TABLE merchants ADD COLUMN tax_form_responsibility_checked_at TEXT;

-- V1 protected-payment merchants must stay in the Stripe-filed Standard-account lane.
-- Observed-only Stripe App merchants may exist outside this rule; the gate applies to ACTIVE STRIPE_CONNECT merchants.
UPDATE merchants
SET status = 'TEST'
WHERE status = 'ACTIVE'
  AND integration_mode = 'STRIPE_CONNECT'
  AND (
    stripe_account_type IS NOT 'standard'
    OR tax_form_responsibility IS NOT 'STRIPE_EXPECTED'
  );

CREATE TRIGGER IF NOT EXISTS merchants_v1_tax_responsibility_safe_on_active_insert
BEFORE INSERT ON merchants
WHEN NEW.status = 'ACTIVE'
 AND NEW.integration_mode = 'STRIPE_CONNECT'
 AND (
   NEW.stripe_account_type IS NOT 'standard'
   OR NEW.tax_form_responsibility IS NOT 'STRIPE_EXPECTED'
 )
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE Stripe Connect merchant must use the V1 Standard-account tax-reporting lane');
END;

CREATE TRIGGER IF NOT EXISTS merchants_v1_tax_responsibility_safe_on_active_update
BEFORE UPDATE OF status, integration_mode, stripe_account_type, tax_form_responsibility ON merchants
WHEN NEW.status = 'ACTIVE'
 AND NEW.integration_mode = 'STRIPE_CONNECT'
 AND (
   NEW.stripe_account_type IS NOT 'standard'
   OR NEW.tax_form_responsibility IS NOT 'STRIPE_EXPECTED'
 )
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE Stripe Connect merchant must use the V1 Standard-account tax-reporting lane');
END;

-- Preserve the processor's tax-year/reconciliation facts separately from mutable current status.
ALTER TABLE transactions ADD COLUMN stripe_available_on TEXT;
ALTER TABLE transactions ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0
  CHECK (refunded_cents >= 0);
ALTER TABLE transactions ADD COLUMN processor_fee_breakdown_json TEXT;
ALTER TABLE transactions ADD COLUMN processor_fee_source TEXT
  CHECK (processor_fee_source IS NULL OR processor_fee_source IN ('FEE_DETAILS','BALANCE_TOTAL_UNVERIFIED'));
ALTER TABLE transactions ADD COLUMN tax_data_reconciled_at TEXT;

-- Gross application-fee truth is immutable evidence that the fee existed at the protected-payment moment.
-- integrity_fee_collected_cents is current retained cash and may fall after an application-fee refund.
ALTER TABLE transactions ADD COLUMN application_fee_gross_confirmed_cents INTEGER NOT NULL DEFAULT 0
  CHECK (application_fee_gross_confirmed_cents >= 0);

UPDATE transactions
SET application_fee_gross_confirmed_cents = CASE
  WHEN record_classification = 'PROTECTED' THEN bg_fee_earned_cents
  ELSE 0
END;

CREATE INDEX IF NOT EXISTS idx_transactions_merchant_available_on
  ON transactions(merchant_id, stripe_available_on);

CREATE TRIGGER IF NOT EXISTS transactions_application_fee_gross_no_rewrite
BEFORE UPDATE OF application_fee_gross_confirmed_cents ON transactions
WHEN OLD.application_fee_gross_confirmed_cents > 0
 AND NEW.application_fee_gross_confirmed_cents <> OLD.application_fee_gross_confirmed_cents
BEGIN
  SELECT RAISE(ABORT, 'gross application-fee confirmation is immutable');
END;

-- PROTECTED is historical truth: the transaction was validly protected when payment succeeded.
-- A later refund or fee refund must not erase that fact. payment_at is the durable success evidence;
-- payment_status is intentionally allowed to become refunded/partially_refunded later.
DROP TRIGGER IF EXISTS transactions_protected_requires_successful_fee_insert;
DROP TRIGGER IF EXISTS transactions_protected_requires_successful_fee_update;
DROP TRIGGER IF EXISTS transactions_confirm_protected_after_processor_truth;
DROP TRIGGER IF EXISTS transactions_flag_fee_exception_after_processor_truth;

CREATE TRIGGER IF NOT EXISTS transactions_protected_requires_confirmed_history_insert
BEFORE INSERT ON transactions
WHEN NEW.record_classification = 'PROTECTED'
AND (
  NEW.payment_at IS NULL
  OR COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
  OR NEW.stripe_application_fee_id IS NULL
  OR COALESCE(NEW.application_fee_gross_confirmed_cents, 0) <= 0
  OR COALESCE(NEW.application_fee_gross_confirmed_cents, 0) <> COALESCE(NEW.integrity_fee_earned_cents, 0)
  OR COALESCE(NEW.bg_fee_earned_cents, 0) <> COALESCE(NEW.application_fee_gross_confirmed_cents, 0)
)
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED requires successful-payment history and exact gross application-fee confirmation');
END;

CREATE TRIGGER IF NOT EXISTS transactions_protected_requires_confirmed_history_update
BEFORE UPDATE OF record_classification, bg_fee_earned_cents, payment_at,
                 stripe_application_fee_id, application_fee_gross_confirmed_cents,
                 integrity_fee_earned_cents, protection_confirmed_at ON transactions
WHEN NEW.record_classification = 'PROTECTED'
 AND OLD.record_classification <> 'PROTECTED'
 AND (
   NEW.payment_at IS NULL
   OR COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
   OR NEW.stripe_application_fee_id IS NULL
   OR COALESCE(NEW.application_fee_gross_confirmed_cents, 0) <= 0
   OR COALESCE(NEW.application_fee_gross_confirmed_cents, 0) <> COALESCE(NEW.integrity_fee_earned_cents, 0)
   OR COALESCE(NEW.bg_fee_earned_cents, 0) <> COALESCE(NEW.application_fee_gross_confirmed_cents, 0)
 )
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED transition requires successful-payment history and exact gross application-fee confirmation');
END;

-- Once protection has been confirmed, preserve its gross historical evidence.
-- Current payment status and retained fee cash may change later because refunds are lifecycle events.
CREATE TRIGGER IF NOT EXISTS transactions_protected_history_no_rewrite
BEFORE UPDATE OF record_classification, bg_fee_earned_cents, protection_confirmed_at,
                 stripe_application_fee_id, application_fee_gross_confirmed_cents ON transactions
WHEN OLD.record_classification = 'PROTECTED'
 AND (
   NEW.record_classification <> 'PROTECTED'
   OR NEW.bg_fee_earned_cents <> OLD.bg_fee_earned_cents
   OR COALESCE(NEW.protection_confirmed_at, '') <> COALESCE(OLD.protection_confirmed_at, '')
   OR COALESCE(NEW.stripe_application_fee_id, '') <> COALESCE(OLD.stripe_application_fee_id, '')
   OR NEW.application_fee_gross_confirmed_cents <> OLD.application_fee_gross_confirmed_cents
 )
BEGIN
  SELECT RAISE(ABORT, 'confirmed protection history is immutable; later cash changes must be adjustments');
END;

-- Webhook order is not authoritative. Protection can be confirmed once both durable truths exist,
-- regardless of whether the payment event or application-fee event arrived first.
CREATE TRIGGER IF NOT EXISTS transactions_confirm_protected_after_historical_truth
AFTER UPDATE OF payment_at, stripe_application_fee_id, application_fee_gross_confirmed_cents,
                integrity_fee_earned_cents ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED','PROTECTED')
 AND NEW.payment_at IS NOT NULL
 AND NEW.fee_collection_method = 'STRIPE_APPLICATION_FEE'
 AND NEW.stripe_application_fee_id IS NOT NULL
 AND NEW.application_fee_gross_confirmed_cents > 0
 AND NEW.application_fee_gross_confirmed_cents = NEW.integrity_fee_earned_cents
BEGIN
  UPDATE transactions
     SET record_classification = 'PROTECTED',
         bg_fee_earned_cents = NEW.application_fee_gross_confirmed_cents,
         protection_confirmed_at = COALESCE(protection_confirmed_at, CURRENT_TIMESTAMP),
         protection_failure_reason = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.id;
END;

-- If payment success is known but gross fee evidence is absent/mismatched, fail visibly.
-- A later matching processor event can still promote FEE_EXCEPTION to PROTECTED.
CREATE TRIGGER IF NOT EXISTS transactions_flag_fee_exception_after_historical_truth
AFTER UPDATE OF payment_at, stripe_application_fee_id, application_fee_gross_confirmed_cents,
                integrity_fee_earned_cents ON transactions
WHEN NEW.record_classification NOT IN ('OBSERVED','IMPORTED','PROTECTED')
 AND NEW.payment_at IS NOT NULL
 AND NEW.fee_collection_method = 'STRIPE_APPLICATION_FEE'
 AND NEW.integrity_fee_earned_cents > 0
 AND (
   NEW.stripe_application_fee_id IS NULL
   OR NEW.application_fee_gross_confirmed_cents <= 0
   OR NEW.application_fee_gross_confirmed_cents <> NEW.integrity_fee_earned_cents
 )
BEGIN
  UPDATE transactions
     SET record_classification = 'FEE_EXCEPTION',
         bg_fee_earned_cents = 0,
         protection_confirmed_at = NULL,
         protection_failure_reason = CASE
           WHEN NEW.stripe_application_fee_id IS NULL
             THEN 'Successful payment has not yet exposed the required Builtegrity application fee.'
           WHEN NEW.application_fee_gross_confirmed_cents <= 0
             THEN 'Successful payment has an application fee reference but no confirmed gross fee amount.'
           ELSE 'Confirmed gross Builtegrity application fee does not match the locked transaction fee.'
         END,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.id;
END;

-- If a refund webhook arrived before protection could be promoted, recognize gross revenue at protection
-- and immediately mirror the already-known fee refund as an ACTUAL adjustment.
CREATE TRIGGER IF NOT EXISTS transactions_record_fee_refund_present_at_protection
AFTER UPDATE OF record_classification, bg_fee_earned_cents ON transactions
WHEN NEW.record_classification = 'PROTECTED'
 AND OLD.record_classification <> 'PROTECTED'
 AND NEW.integrity_fee_collected_cents < NEW.bg_fee_earned_cents
BEGIN
  INSERT OR IGNORE INTO transaction_economics_ledger
    (id, transaction_id, entry_kind, category, amount_micros, basis, source_ref, details_json)
  VALUES (
    'ECO_ACT_ADJ_PRE_' || NEW.id || '_' || NEW.integrity_fee_collected_cents,
    NEW.id,
    'ADJUSTMENT',
    'INTEGRITY_FEE_ADJUSTMENT',
    -((NEW.bg_fee_earned_cents - NEW.integrity_fee_collected_cents) * 10000),
    'ACTUAL',
    'fee-net-at-protection:' || NEW.integrity_fee_collected_cents,
    '{"fee_payer":"MERCHANT","source":"processor_refund_before_protection_confirmation"}'
  );
END;

-- Append-only merchant/Builtegrity cash adjustments. Amount is always a positive magnitude;
-- direction says whose economics moved and in which direction.
CREATE TABLE IF NOT EXISTS transaction_financial_adjustments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  processor TEXT NOT NULL,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN (
    'REFUND','APPLICATION_FEE_REFUND','DISPUTE_DEBIT','DISPUTE_CREDIT','PROCESSOR_ADJUSTMENT','OTHER'
  )),
  direction TEXT NOT NULL CHECK (direction IN (
    'MERCHANT_OUTFLOW','MERCHANT_INFLOW','BUILTEGRITY_OUTFLOW','BUILTEGRITY_INFLOW','INFORMATIONAL'
  )),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  processor_event_id TEXT,
  processor_object_id TEXT,
  adjustment_at TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (processor, processor_event_id, adjustment_type)
);
CREATE INDEX IF NOT EXISTS idx_financial_adjustments_transaction
  ON transaction_financial_adjustments(transaction_id, adjustment_at);
CREATE INDEX IF NOT EXISTS idx_financial_adjustments_merchant_year
  ON transaction_financial_adjustments(merchant_id, adjustment_at);

CREATE TRIGGER IF NOT EXISTS transaction_financial_adjustments_no_update
BEFORE UPDATE ON transaction_financial_adjustments
BEGIN
  SELECT RAISE(ABORT, 'transaction financial adjustments are append-only');
END;
CREATE TRIGGER IF NOT EXISTS transaction_financial_adjustments_no_delete
BEFORE DELETE ON transaction_financial_adjustments
BEGIN
  SELECT RAISE(ABORT, 'transaction financial adjustments are append-only');
END;

-- Tax-law reference data is advisory metadata only. It must never auto-file a form or decide taxable income.
CREATE TABLE IF NOT EXISTS tax_rule_versions (
  id TEXT PRIMARY KEY,
  jurisdiction TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  rule_type TEXT NOT NULL,
  gross_threshold_cents INTEGER,
  transaction_threshold INTEGER,
  threshold_logic TEXT,
  advisory_only INTEGER NOT NULL DEFAULT 1 CHECK (advisory_only = 1),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (jurisdiction, tax_year, rule_type)
);

INSERT OR IGNORE INTO tax_rule_versions (
  id, jurisdiction, tax_year, rule_type, gross_threshold_cents, transaction_threshold,
  threshold_logic, source_name, source_url, verified_at, notes
) VALUES
(
  'TAX-US-2026-1099K-TPSO', 'US-FEDERAL', 2026, '1099_K_TPSO_REFERENCE',
  2000000, 200, 'GREATER_THAN_BOTH',
  'IRS Instructions for Form 1099-K (2026)',
  'https://www.irs.gov/instructions/i1099k',
  '2026-10-13T00:00:00Z',
  'Reference only. State thresholds and filer-specific rules can differ. Builtegrity V1 does not use this row to decide or file merchant tax forms.'
),
(
  'TAX-US-2026-1099NEC-GENERAL', 'US-FEDERAL', 2026, '1099_NEC_GENERAL_REFERENCE',
  200000, NULL, 'AT_LEAST_GROSS',
  'Stripe 2026 Connect tax reporting summary',
  'https://support.stripe.com/questions/1099-tax-reporting-and-filing-for-platforms-and-marketplaces',
  '2026-10-13T00:00:00Z',
  'Reference only for future partner/vendor compensation design. Applicability, exemptions, states, and payment type require tax review.'
);

-- Stripe-style tax-year gross uses processor availability timing and NEVER nets fees/refunds.
-- This is a reconciliation view, not a tax return and not a promise that the values equal a final 1099-K.
CREATE VIEW IF NOT EXISTS merchant_tax_year_charge_summary AS
SELECT
  t.merchant_id,
  strftime('%Y', t.stripe_available_on) AS tax_year,
  t.currency,
  COUNT(*) AS successful_charge_count,
  SUM(COALESCE(t.customer_paid_cents, t.amount_cents)) AS gross_payment_volume_cents,
  SUM(CASE WHEN t.record_classification = 'PROTECTED' THEN 1 ELSE 0 END) AS protected_count,
  SUM(CASE WHEN t.record_classification = 'OBSERVED' THEN 1 ELSE 0 END) AS observed_count,
  SUM(CASE WHEN t.record_classification = 'IMPORTED' THEN 1 ELSE 0 END) AS imported_count,
  SUM(CASE WHEN t.record_classification = 'PROTECTED' THEN COALESCE(t.customer_paid_cents, t.amount_cents) ELSE 0 END) AS protected_volume_cents,
  SUM(COALESCE(t.processor_fee_cents, 0)) AS processor_fee_cents,
  SUM(COALESCE(t.bg_fee_earned_cents, 0)) AS builtegrity_gross_fee_earned_cents,
  SUM(COALESCE(t.integrity_fee_collected_cents, 0)) AS builtegrity_current_fee_cash_cents,
  SUM(COALESCE(t.actual_merchant_net_cents, t.expected_merchant_net_cents, 0)) AS merchant_net_observed_cents,
  SUM(CASE WHEN t.processor_fee_source = 'BALANCE_TOTAL_UNVERIFIED' THEN 1 ELSE 0 END) AS unverified_fee_breakdown_count,
  SUM(CASE WHEN t.payout_accounted = 0 THEN 1 ELSE 0 END) AS unreconciled_payout_count
FROM transactions t
WHERE t.stripe_available_on IS NOT NULL
  AND t.payment_at IS NOT NULL
GROUP BY t.merchant_id, strftime('%Y', t.stripe_available_on), t.currency;

CREATE VIEW IF NOT EXISTS merchant_tax_year_adjustment_summary AS
SELECT
  a.merchant_id,
  strftime('%Y', a.adjustment_at) AS tax_year,
  a.currency,
  SUM(CASE WHEN a.adjustment_type = 'REFUND' AND a.direction = 'MERCHANT_OUTFLOW' THEN a.amount_cents ELSE 0 END) AS customer_refunds_cents,
  SUM(CASE WHEN a.adjustment_type = 'APPLICATION_FEE_REFUND' AND a.direction = 'BUILTEGRITY_OUTFLOW' THEN a.amount_cents ELSE 0 END) AS builtegrity_fee_refunds_cents,
  SUM(CASE WHEN a.adjustment_type = 'DISPUTE_DEBIT' THEN a.amount_cents ELSE 0 END) AS dispute_debits_cents,
  SUM(CASE WHEN a.adjustment_type = 'DISPUTE_CREDIT' THEN a.amount_cents ELSE 0 END) AS dispute_credits_cents,
  COUNT(*) AS adjustment_count
FROM transaction_financial_adjustments a
GROUP BY a.merchant_id, strftime('%Y', a.adjustment_at), a.currency;

-- Builtegrity's own tax/accounting reconciliation comes from ACTUAL ledger entries,
-- not merchant gross payment volume.
CREATE VIEW IF NOT EXISTS builtegrity_tax_year_revenue_summary AS
SELECT
  strftime('%Y', e.created_at) AS tax_year,
  SUM(CASE WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'REVENUE' THEN e.amount_micros ELSE 0 END) AS actual_revenue_micros,
  SUM(CASE WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'ADJUSTMENT' THEN e.amount_micros ELSE 0 END) AS actual_adjustment_micros,
  SUM(CASE WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'PARTNER_SHARE' THEN e.amount_micros ELSE 0 END) AS actual_partner_share_micros,
  SUM(CASE WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'COST' THEN e.amount_micros ELSE 0 END) AS actual_cost_micros,
  SUM(CASE
    WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'REVENUE' THEN e.amount_micros
    WHEN e.basis = 'ACTUAL' AND e.entry_kind = 'ADJUSTMENT' THEN e.amount_micros
    WHEN e.basis = 'ACTUAL' AND e.entry_kind IN ('PARTNER_SHARE','COST') THEN -e.amount_micros
    ELSE 0 END) AS actual_contribution_micros
FROM transaction_economics_ledger e
GROUP BY strftime('%Y', e.created_at);

-- Versioned, immutable Year-End Payment Activity Summary snapshots.
-- These are merchant reconciliation aids, never labeled a tax return or 1099.
CREATE TABLE IF NOT EXISTS year_end_payment_summaries (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version >= 1),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RECONCILED','NEEDS_REVIEW')),
  stripe_account_type_snapshot TEXT,
  tax_form_responsibility_snapshot TEXT NOT NULL,
  successful_charge_count INTEGER NOT NULL DEFAULT 0 CHECK (successful_charge_count >= 0),
  gross_payment_volume_cents INTEGER NOT NULL DEFAULT 0 CHECK (gross_payment_volume_cents >= 0),
  customer_refunds_cents INTEGER NOT NULL DEFAULT 0 CHECK (customer_refunds_cents >= 0),
  processor_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (processor_fee_cents >= 0),
  builtegrity_gross_fee_earned_cents INTEGER NOT NULL DEFAULT 0 CHECK (builtegrity_gross_fee_earned_cents >= 0),
  builtegrity_fee_refunds_cents INTEGER NOT NULL DEFAULT 0 CHECK (builtegrity_fee_refunds_cents >= 0),
  merchant_net_observed_cents INTEGER NOT NULL DEFAULT 0,
  protected_count INTEGER NOT NULL DEFAULT 0 CHECK (protected_count >= 0),
  observed_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  exception_count INTEGER NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  missing_available_on_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_available_on_count >= 0),
  unverified_fee_breakdown_count INTEGER NOT NULL DEFAULT 0 CHECK (unverified_fee_breakdown_count >= 0),
  unreconciled_payout_count INTEGER NOT NULL DEFAULT 0 CHECK (unreconciled_payout_count >= 0),
  snapshot_json TEXT NOT NULL,
  generated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (merchant_id, tax_year, currency, summary_version)
);
CREATE INDEX IF NOT EXISTS idx_year_end_payment_summaries_merchant
  ON year_end_payment_summaries(merchant_id, tax_year DESC, summary_version DESC);

CREATE TABLE IF NOT EXISTS year_end_payment_summary_items (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  record_classification TEXT NOT NULL,
  stripe_available_on TEXT,
  gross_payment_cents INTEGER NOT NULL,
  processor_fee_cents INTEGER NOT NULL DEFAULT 0,
  builtegrity_gross_fee_cents INTEGER NOT NULL DEFAULT 0,
  current_builtegrity_fee_cash_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  payout_accounted INTEGER NOT NULL DEFAULT 0 CHECK (payout_accounted IN (0,1)),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (summary_id) REFERENCES year_end_payment_summaries(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  UNIQUE (summary_id, transaction_id)
);

CREATE TRIGGER IF NOT EXISTS year_end_payment_summary_items_no_update
BEFORE UPDATE ON year_end_payment_summary_items
BEGIN
  SELECT RAISE(ABORT, 'year-end payment summary items are immutable snapshots');
END;
CREATE TRIGGER IF NOT EXISTS year_end_payment_summary_items_no_delete
BEFORE DELETE ON year_end_payment_summary_items
BEGIN
  SELECT RAISE(ABORT, 'year-end payment summary items are immutable snapshots');
END;
CREATE TRIGGER IF NOT EXISTS year_end_payment_summaries_no_delete
BEFORE DELETE ON year_end_payment_summaries
BEGIN
  SELECT RAISE(ABORT, 'year-end payment summaries are permanent versioned records');
END;
CREATE TRIGGER IF NOT EXISTS year_end_payment_summaries_generated_snapshot_immutable
BEFORE UPDATE ON year_end_payment_summaries
WHEN OLD.generated_at IS NOT NULL AND (
  NEW.merchant_id <> OLD.merchant_id
  OR NEW.tax_year <> OLD.tax_year
  OR NEW.currency <> OLD.currency
  OR NEW.summary_version <> OLD.summary_version
  OR COALESCE(NEW.stripe_account_type_snapshot, '') <> COALESCE(OLD.stripe_account_type_snapshot, '')
  OR NEW.tax_form_responsibility_snapshot <> OLD.tax_form_responsibility_snapshot
  OR NEW.successful_charge_count <> OLD.successful_charge_count
  OR NEW.gross_payment_volume_cents <> OLD.gross_payment_volume_cents
  OR NEW.customer_refunds_cents <> OLD.customer_refunds_cents
  OR NEW.processor_fee_cents <> OLD.processor_fee_cents
  OR NEW.builtegrity_gross_fee_earned_cents <> OLD.builtegrity_gross_fee_earned_cents
  OR NEW.builtegrity_fee_refunds_cents <> OLD.builtegrity_fee_refunds_cents
  OR NEW.merchant_net_observed_cents <> OLD.merchant_net_observed_cents
  OR NEW.protected_count <> OLD.protected_count
  OR NEW.observed_count <> OLD.observed_count
  OR NEW.imported_count <> OLD.imported_count
  OR NEW.exception_count <> OLD.exception_count
  OR NEW.missing_available_on_count <> OLD.missing_available_on_count
  OR NEW.unverified_fee_breakdown_count <> OLD.unverified_fee_breakdown_count
  OR NEW.unreconciled_payout_count <> OLD.unreconciled_payout_count
  OR NEW.snapshot_json <> OLD.snapshot_json
  OR NEW.generated_at <> OLD.generated_at
)
BEGIN
  SELECT RAISE(ABORT, 'generated year-end payment summary snapshot is immutable; create a new version');
END;
