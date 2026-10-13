PRAGMA foreign_keys = ON;

-- Tax compliance automation covenant:
-- 1) Every merchant receives monthly, quarterly and annual transaction documentation.
-- 2) Documentation supports accounting/tax preparation but never claims to be a tax return.
-- 3) Filing obligations are driven by an explicit tax profile + versioned rules; UNKNOWN fails closed.
-- 4) Builtegrity never invents its own entity classification or silently files through an unapproved path.
-- 5) Raw SSNs/EINs/TINs are not stored merely to provide transaction documentation.

ALTER TABLE merchants ADD COLUMN federal_tax_classification TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (federal_tax_classification IN (
    'UNKNOWN','SOLE_PROPRIETOR','SMLLC_DISREGARDED','PARTNERSHIP','S_CORP','C_CORP','NONPROFIT','OTHER'
  ));
ALTER TABLE merchants ADD COLUMN tax_home_country TEXT NOT NULL DEFAULT 'US';
ALTER TABLE merchants ADD COLUMN tax_home_state TEXT;
ALTER TABLE merchants ADD COLUMN has_employees INTEGER CHECK (has_employees IS NULL OR has_employees IN (0,1));
ALTER TABLE merchants ADD COLUMN tax_profile_status TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (tax_profile_status IN ('UNKNOWN','SELF_ATTESTED','VERIFIED'));
ALTER TABLE merchants ADD COLUMN tax_profile_updated_at TEXT;
ALTER TABLE merchants ADD COLUMN tax_documentation_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (tax_documentation_enabled IN (0,1));

CREATE TABLE IF NOT EXISTS merchant_tax_profiles (
  merchant_id TEXT PRIMARY KEY,
  federal_tax_classification TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (federal_tax_classification IN (
      'UNKNOWN','SOLE_PROPRIETOR','SMLLC_DISREGARDED','PARTNERSHIP','S_CORP','C_CORP','NONPROFIT','OTHER'
    )),
  tax_home_country TEXT NOT NULL DEFAULT 'US',
  tax_home_state TEXT,
  has_employees INTEGER CHECK (has_employees IS NULL OR has_employees IN (0,1)),
  federal_payroll_return TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (federal_payroll_return IN ('UNKNOWN','NONE','FORM_941','FORM_944')),
  profile_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (profile_status IN ('UNKNOWN','SELF_ATTESTED','VERIFIED')),
  source TEXT NOT NULL DEFAULT 'MERCHANT'
    CHECK (source IN ('MERCHANT','PROCESSOR','OPERATOR','TAX_PROVIDER')),
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);

INSERT OR IGNORE INTO merchant_tax_profiles
  (merchant_id, federal_tax_classification, tax_home_country, tax_home_state,
   has_employees, profile_status, source)
SELECT id, federal_tax_classification, tax_home_country, tax_home_state,
       has_employees, tax_profile_status, 'MERCHANT'
FROM merchants;

-- Versioned tax rules. Rules guide documentation and compliance readiness;
-- they do not, by themselves, authorize a filing or payment.
CREATE TABLE IF NOT EXISTS tax_compliance_rule_versions (
  id TEXT PRIMARY KEY,
  jurisdiction TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  rule_code TEXT NOT NULL,
  applies_to TEXT NOT NULL,
  obligation_kind TEXT NOT NULL CHECK (obligation_kind IN (
    'ANNUAL_RETURN','ESTIMATED_TAX','PAYROLL_RETURN','PAYROLL_DEPOSIT','INFORMATION_RETURN','ENTITY_FEE','OTHER'
  )),
  cadence TEXT NOT NULL CHECK (cadence IN ('ANNUAL','QUARTERLY','MONTHLY','SEMIWEEKLY','DYNAMIC','ONE_TIME')),
  filing_form TEXT,
  threshold_cents INTEGER,
  threshold_basis TEXT,
  due_rule TEXT NOT NULL,
  due_dates_json TEXT,
  automation_level TEXT NOT NULL CHECK (automation_level IN (
    'DOCUMENTATION_ONLY','CALCULATE_WITH_COMPLETE_TAX_PROFILE','PAYMENT_CAN_BE_SCHEDULED','AUTHORIZED_EFILE_PROVIDER_REQUIRED','PAYROLL_PROVIDER_RECOMMENDED'
  )),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  advisory_only INTEGER NOT NULL DEFAULT 1 CHECK (advisory_only = 1),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (jurisdiction, tax_year, rule_code)
);

INSERT OR IGNORE INTO tax_compliance_rule_versions
(id,jurisdiction,tax_year,rule_code,applies_to,obligation_kind,cadence,filing_form,
 threshold_cents,threshold_basis,due_rule,due_dates_json,automation_level,
 source_name,source_url,verified_at,notes)
VALUES
('TCR-US-2026-IND-EST','US-FEDERAL',2026,'INDIVIDUAL_ESTIMATED_TAX',
 'SOLE_PROPRIETOR,SMLLC_DISREGARDED,PARTNER,S_CORP_SHAREHOLDER','ESTIMATED_TAX','QUARTERLY','1040-ES',
 100000,'EXPECTED_BALANCE_DUE','Calendar-year individual installments',
 '["2026-04-15","2026-06-15","2026-09-15","2027-01-15"]',
 'PAYMENT_CAN_BE_SCHEDULED','IRS Estimated Taxes','https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes','2026-10-13T00:00:00Z',
 'Individuals, including sole proprietors, partners and S-corporation shareholders, generally make estimated payments when expected tax due is $1,000 or more.'),
('TCR-US-2026-CORP-EST','US-FEDERAL',2026,'C_CORP_ESTIMATED_TAX',
 'C_CORP','ESTIMATED_TAX','QUARTERLY','1120-W',50000,'EXPECTED_CORPORATE_TAX',
 'Calendar-year corporation installments',
 '["2026-04-15","2026-06-15","2026-09-15","2026-12-15"]',
 'PAYMENT_CAN_BE_SCHEDULED','IRS Estimated Taxes','https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes','2026-10-13T00:00:00Z',
 'Corporations generally make estimated payments when expected tax is $500 or more.'),
('TCR-US-2026-SCORP-SPECIAL-EST','US-FEDERAL',2026,'S_CORP_SPECIAL_ENTITY_ESTIMATED_TAX',
 'S_CORP','ESTIMATED_TAX','QUARTERLY','1120-S',50000,'SPECIFIED_ENTITY_LEVEL_TAXES',
 'Only if built-in-gains, excess-net-passive-income, investment-credit-recapture or similar entity-level taxes reach threshold',
 '["2026-04-15","2026-06-15","2026-09-15","2026-12-15"]',
 'CALCULATE_WITH_COMPLETE_TAX_PROFILE','IRS Businesses Estimated Tax FAQ','https://www.irs.gov/faqs/estimated-tax/businesses','2026-10-13T00:00:00Z',
 'Most ordinary S-corporation operating income passes through; shareholder estimated-tax obligations are separate.'),
('TCR-US-2026-941','US-FEDERAL',2026,'EMPLOYER_FORM_941',
 'EMPLOYER_FORM_941','PAYROLL_RETURN','QUARTERLY','941',NULL,'EMPLOYER_STATUS',
 'Quarterly return due last day of month after quarter end',
 '["2026-04-30","2026-07-31","2026-11-02","2027-02-01"]',
 'PAYROLL_PROVIDER_RECOMMENDED','IRS Instructions for Form 941','https://www.irs.gov/instructions/i941','2026-10-13T00:00:00Z',
 'Most employers file Form 941 every quarter unless the IRS has authorized Form 944 or another exception.'),
('TCR-US-2026-PAYROLL-DEPOSIT','US-FEDERAL',2026,'EMPLOYMENT_TAX_DEPOSITS',
 'EMPLOYER','PAYROLL_DEPOSIT','DYNAMIC',NULL,NULL,'LOOKBACK_PERIOD_AND_PAYDATE',
 'Monthly or semiweekly deposit schedule; $100,000 next-day rule may apply',NULL,
 'PAYROLL_PROVIDER_RECOMMENDED','IRS Topic 757','https://www.irs.gov/taxtopics/tc757','2026-10-13T00:00:00Z',
 'Quarterly Form 941 filing does not mean payroll tax deposits are quarterly.'),
('TCR-US-2026-940','US-FEDERAL',2026,'FUTA_FORM_940',
 'EMPLOYER','ANNUAL_RETURN','ANNUAL','940',50000,'UNDEPOSITED_FUTA_END_OF_QUARTER',
 'Annual Form 940; FUTA deposits required after a quarter when accumulated liability exceeds $500',NULL,
 'PAYROLL_PROVIDER_RECOMMENDED','IRS Employment Tax Due Dates','https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-due-dates','2026-10-13T00:00:00Z',
 'FUTA return is annual while deposits can become due quarterly.'),
('TCR-US-2026-1099NEC','US-FEDERAL',2026,'FORM_1099_NEC',
 'BUSINESS_PAYER','INFORMATION_RETURN','ANNUAL','1099-NEC',200000,'REPORTABLE_NONEMPLOYEE_COMPENSATION',
 'Generally file and furnish by January 31 following the calendar year',NULL,
 'AUTHORIZED_EFILE_PROVIDER_REQUIRED','IRS 1099 Information Return Requirements','https://www.irs.gov/businesses/small-businesses-self-employed/am-i-required-to-file-a-form-1099-or-other-information-return','2026-10-13T00:00:00Z',
 '2026 general nonemployee-compensation threshold is $2,000; payment-method and recipient exceptions still apply.'),
('TCR-RI-2026-IND-EST','US-RI',2026,'RI_INDIVIDUAL_ESTIMATED_TAX',
 'RI_INDIVIDUAL','ESTIMATED_TAX','QUARTERLY','RI-1040ES',25000,'EXPECTED_RI_TAX_AFTER_CREDITS',
 'Calendar-year individual installments',
 '["2026-04-15","2026-06-15","2026-09-15","2027-01-15"]',
 'PAYMENT_CAN_BE_SCHEDULED','RI Division of Taxation 2026 RI-1040ES','https://tax.ri.gov/forms/individual-tax-forms/personal-income-tax-forms','2026-10-13T00:00:00Z',
 'RI individuals generally make estimated payments when expected RI tax after credits is $250 or more.'),
('TCR-RI-2026-CORP-EST','US-RI',2026,'RI_CORPORATE_ESTIMATED_TAX',
 'C_CORP,OTHER_CORPORATE_TAXPAYER','ESTIMATED_TAX','QUARTERLY','BUS-EST',50000,'EXPECTED_RI_ENTITY_TAX',
 'Calendar-year corporation installments',
 '["2026-04-15","2026-06-15","2026-09-15","2026-12-15"]',
 'PAYMENT_CAN_BE_SCHEDULED','RI Estimated Tax Payments Regulation','https://tax.ri.gov/sites/g/files/xkgbur541/files/regulations/other/280-RICR-20-25-5-Estimated-Tax-Payments-Final.pdf','2026-10-13T00:00:00Z',
 'Rhode Island corporations generally make estimates if expected entity tax exceeds $500.'),
('TCR-RI-2026-1065','US-RI',2026,'RI_LLC_PARTNERSHIP_ANNUAL',
 'SMLLC_DISREGARDED,PARTNERSHIP,LLC_NOT_CORPORATION','ANNUAL_RETURN','ANNUAL','RI-1065',40000,'ANNUAL_MINIMUM_CHARGE_OR_FEE',
 'Calendar-year partnership generally due 15th day of third month; calendar-year SMLLC generally due 15th day of fourth month',NULL,
 'AUTHORIZED_EFILE_PROVIDER_REQUIRED','RI Tax Filing Requirements','https://tax.ri.gov/tax-sections/corporate-tax/tax-filing-requirements','2026-10-13T00:00:00Z',
 'RI LLCs not taxed as corporations and SMLLCs file RI-1065; entities other than general partnerships are generally subject to the $400 annual charge.'),
('TCR-RI-2026-1120S','US-RI',2026,'RI_S_CORP_ANNUAL',
 'S_CORP','ANNUAL_RETURN','ANNUAL','RI-1120S',40000,'ANNUAL_MINIMUM_TAX',
 'Generally due 15th day of third month after year end',NULL,
 'AUTHORIZED_EFILE_PROVIDER_REQUIRED','RI Tax Filing Requirements','https://tax.ri.gov/tax-sections/corporate-tax/tax-filing-requirements','2026-10-13T00:00:00Z',
 'RI S corporations file RI-1120S and are generally subject to at least the $400 minimum tax.'),
('TCR-RI-2026-1120C','US-RI',2026,'RI_C_CORP_ANNUAL',
 'C_CORP','ANNUAL_RETURN','ANNUAL','RI-1120C',40000,'ANNUAL_MINIMUM_TAX',
 'Calendar-year corporation generally due 15th day of fourth month after year end',NULL,
 'AUTHORIZED_EFILE_PROVIDER_REQUIRED','RI Tax Filing Requirements','https://tax.ri.gov/tax-sections/corporate-tax/tax-filing-requirements','2026-10-13T00:00:00Z',
 'RI C corporations file RI-1120C and pay 7% of RI net income or the $400 minimum, whichever is greater.'),
('TCR-RI-2026-941','US-RI',2026,'RI_EMPLOYER_941',
 'RI_EMPLOYER','PAYROLL_RETURN','QUARTERLY','RI-941',NULL,'EMPLOYER_STATUS',
 'Quarterly RI-941 due last day of month following quarter end',NULL,
 'PAYROLL_PROVIDER_RECOMMENDED','RI Division of Taxation Withholding Tax','https://tax.ri.gov/tax-sections/withholding-tax','2026-10-13T00:00:00Z',
 'RI withholding payment frequency can be weekly, monthly or quarterly even though RI-941 reconciliation is quarterly.');

-- Quarterly merchant payment-activity summaries support estimated-tax/accounting work.
-- They are not estimated-tax returns and never compute tax due from payment volume alone.
CREATE TABLE IF NOT EXISTS quarterly_payment_summaries (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  currency TEXT NOT NULL DEFAULT 'USD',
  summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version >= 1),
  period_start TEXT NOT NULL,
  period_end_exclusive TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RECONCILED','NEEDS_REVIEW')),
  federal_tax_classification_snapshot TEXT NOT NULL,
  tax_profile_status_snapshot TEXT NOT NULL,
  purpose_code TEXT NOT NULL,
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
  unreconciled_payout_count INTEGER NOT NULL DEFAULT 0 CHECK (unreconciled_payout_count >= 0),
  snapshot_json TEXT NOT NULL,
  generated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (merchant_id, tax_year, quarter, currency, summary_version)
);
CREATE INDEX IF NOT EXISTS idx_quarterly_payment_summaries_merchant
  ON quarterly_payment_summaries(merchant_id, tax_year DESC, quarter DESC, summary_version DESC);

CREATE TABLE IF NOT EXISTS quarterly_payment_summary_items (
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
  FOREIGN KEY (summary_id) REFERENCES quarterly_payment_summaries(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  UNIQUE (summary_id, transaction_id)
);

CREATE TRIGGER IF NOT EXISTS quarterly_payment_summaries_generated_no_update
BEFORE UPDATE ON quarterly_payment_summaries
WHEN OLD.generated_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'generated quarterly payment summary snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS quarterly_payment_summaries_generated_no_delete
BEFORE DELETE ON quarterly_payment_summaries
WHEN OLD.generated_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'generated quarterly payment summary snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS quarterly_payment_summary_items_no_update BEFORE UPDATE ON quarterly_payment_summary_items
BEGIN SELECT RAISE(ABORT, 'quarterly payment summary items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS quarterly_payment_summary_items_no_delete BEFORE DELETE ON quarterly_payment_summary_items
BEGIN SELECT RAISE(ABORT, 'quarterly payment summary items are immutable'); END;

-- Rendered quarterly/year-end exports and automated delivery share one durable pipeline.
CREATE TABLE IF NOT EXISTS tax_document_exports (
  id TEXT PRIMARY KEY,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('QUARTERLY_PAYMENT_ACTIVITY','YEAR_END_PAYMENT_ACTIVITY')),
  source_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  period_label TEXT NOT NULL,
  object_key TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL,
  pdf_byte_length INTEGER NOT NULL CHECK (pdf_byte_length > 0),
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (document_kind, source_id)
);
CREATE TRIGGER IF NOT EXISTS tax_document_exports_no_update BEFORE UPDATE ON tax_document_exports
BEGIN SELECT RAISE(ABORT, 'tax document exports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_document_exports_no_delete BEFORE DELETE ON tax_document_exports
BEGIN SELECT RAISE(ABORT, 'tax document exports are immutable'); END;

CREATE TABLE IF NOT EXISTS tax_document_deliveries (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','RETRY','DELIVERED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  provider_message_id TEXT,
  delivered_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (export_id) REFERENCES tax_document_exports(id),
  UNIQUE (export_id, recipient_email)
);
CREATE INDEX IF NOT EXISTS idx_tax_document_deliveries_due
  ON tax_document_deliveries(status, next_attempt_at, created_at);

-- Builtegrity's own tax profile is intentionally UNKNOWN until the legal/tax entity is actually confirmed.
CREATE TABLE IF NOT EXISTS builtegrity_tax_profile (
  id TEXT PRIMARY KEY CHECK (id = 'GLOBAL'),
  legal_entity_status TEXT NOT NULL DEFAULT 'UNCONFIRMED'
    CHECK (legal_entity_status IN ('UNCONFIRMED','CONFIRMED')),
  federal_tax_classification TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (federal_tax_classification IN ('UNKNOWN','SOLE_PROPRIETOR','SMLLC_DISREGARDED','PARTNERSHIP','S_CORP','C_CORP')),
  home_country TEXT NOT NULL DEFAULT 'US',
  home_state TEXT NOT NULL DEFAULT 'RI',
  calendar_tax_year INTEGER NOT NULL DEFAULT 1 CHECK (calendar_tax_year IN (0,1)),
  has_employees INTEGER CHECK (has_employees IS NULL OR has_employees IN (0,1)),
  federal_payroll_return TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (federal_payroll_return IN ('UNKNOWN','NONE','FORM_941','FORM_944')),
  accounting_data_status TEXT NOT NULL DEFAULT 'PARTIAL'
    CHECK (accounting_data_status IN ('PARTIAL','COMPLETE_VERIFIED')),
  prior_year_tax_data_status TEXT NOT NULL DEFAULT 'MISSING'
    CHECK (prior_year_tax_data_status IN ('MISSING','VERIFIED')),
  estimated_payment_provider TEXT,
  return_efiling_provider TEXT,
  filing_authorization_status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
    CHECK (filing_authorization_status IN ('NOT_CONFIGURED','READY_FOR_APPROVAL','AUTHORIZED')),
  direct_autofiling_allowed INTEGER NOT NULL DEFAULT 0 CHECK (direct_autofiling_allowed = 0),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO builtegrity_tax_profile (id) VALUES ('GLOBAL');

-- Any change to the company tax profile is audited. TINs are deliberately excluded.
CREATE TABLE IF NOT EXISTS builtegrity_tax_profile_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_snapshot_json TEXT NOT NULL,
  actor_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS builtegrity_tax_profile_events_no_update BEFORE UPDATE ON builtegrity_tax_profile_events
BEGIN SELECT RAISE(ABORT, 'Builtegrity tax profile events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS builtegrity_tax_profile_events_no_delete BEFORE DELETE ON builtegrity_tax_profile_events
BEGIN SELECT RAISE(ABORT, 'Builtegrity tax profile events are append-only'); END;

CREATE TABLE IF NOT EXISTS builtegrity_tax_workpapers (
  id TEXT PRIMARY KEY,
  period_type TEXT NOT NULL CHECK (period_type IN ('QUARTER','YEAR')),
  tax_year INTEGER NOT NULL,
  quarter INTEGER CHECK (quarter IS NULL OR quarter BETWEEN 1 AND 4),
  period_start TEXT NOT NULL,
  period_end_exclusive TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('NEEDS_REVIEW','READY_FOR_PROVIDER')),
  profile_status_snapshot TEXT NOT NULL,
  federal_tax_classification_snapshot TEXT NOT NULL,
  accounting_data_status_snapshot TEXT NOT NULL,
  actual_revenue_micros INTEGER NOT NULL DEFAULT 0,
  actual_adjustment_micros INTEGER NOT NULL DEFAULT 0,
  actual_partner_share_micros INTEGER NOT NULL DEFAULT 0,
  actual_cost_micros INTEGER NOT NULL DEFAULT 0,
  tracked_contribution_micros INTEGER NOT NULL DEFAULT 0,
  estimated_tax_amount_micros INTEGER,
  automation_state TEXT NOT NULL CHECK (automation_state IN (
    'BLOCKED_PROFILE_UNKNOWN','BLOCKED_BOOKS_INCOMPLETE','BLOCKED_PRIOR_YEAR_DATA_MISSING',
    'READY_FOR_CALCULATION','READY_FOR_PROVIDER_REVIEW'
  )),
  snapshot_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (period_type, tax_year, quarter)
);
CREATE TRIGGER IF NOT EXISTS builtegrity_tax_workpapers_no_update BEFORE UPDATE ON builtegrity_tax_workpapers
BEGIN SELECT RAISE(ABORT, 'Builtegrity tax workpapers are immutable snapshots'); END;
CREATE TRIGGER IF NOT EXISTS builtegrity_tax_workpapers_no_delete BEFORE DELETE ON builtegrity_tax_workpapers
BEGIN SELECT RAISE(ABORT, 'Builtegrity tax workpapers are immutable snapshots'); END;

-- Filing/payment execution is a controlled external action. The engine may prepare it automatically,
-- but may not mark a return filed unless an authorized provider/portal confirmation is recorded.
CREATE TABLE IF NOT EXISTS builtegrity_tax_actions (
  id TEXT PRIMARY KEY,
  jurisdiction TEXT NOT NULL,
  obligation_code TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  period_label TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('CALCULATE','PAY','FILE','FURNISH')),
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','READY','AWAITING_APPROVAL','SUBMITTED','CONFIRMED','FAILED','NOT_REQUIRED')),
  amount_micros INTEGER,
  due_at TEXT,
  provider TEXT,
  provider_confirmation_ref TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (jurisdiction, obligation_code, tax_year, period_label, action_type)
);

CREATE TRIGGER IF NOT EXISTS builtegrity_tax_action_confirm_requires_provider
BEFORE UPDATE OF status ON builtegrity_tax_actions
WHEN NEW.status = 'CONFIRMED'
 AND (NEW.provider IS NULL OR NEW.provider_confirmation_ref IS NULL)
BEGIN SELECT RAISE(ABORT, 'tax action cannot be confirmed without provider/portal confirmation evidence'); END;

CREATE VIEW IF NOT EXISTS merchant_tax_document_registry AS
SELECT
  'MONTHLY' AS cadence,
  s.id AS document_id,
  s.scope_id AS merchant_id,
  s.period_label,
  s.status,
  s.generated_at
FROM monthly_statements s
WHERE s.scope_type = 'MERCHANT'
UNION ALL
SELECT
  'QUARTERLY', q.id, q.merchant_id,
  CAST(q.tax_year AS TEXT) || '-Q' || CAST(q.quarter AS TEXT), q.status, q.generated_at
FROM quarterly_payment_summaries q
UNION ALL
SELECT
  'ANNUAL', y.id, y.merchant_id,
  CAST(y.tax_year AS TEXT), y.status, y.generated_at
FROM year_end_payment_summaries y;
