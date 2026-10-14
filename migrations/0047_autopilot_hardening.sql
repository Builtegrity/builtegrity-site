PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Outsourced workforce approval is fail-closed.
-- Customer-contact data requires an active DPA. No capability may become dispatchable
-- before the vendor is fully approved, priced and capped.
-- -----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS workforce_capability_approval_guard_insert
BEFORE INSERT ON workforce_vendor_capabilities
WHEN NEW.approved=1 AND (
  NEW.unit_cost_cents<=0 OR
  NOT EXISTS (
    SELECT 1 FROM workforce_vendors v
    WHERE v.id=NEW.vendor_id
      AND v.status='APPROVED'
      AND v.contract_status='ACTIVE'
      AND v.tax_status='CLEARED'
      AND v.per_work_order_cap_cents>0
      AND v.monthly_cap_cents>0
      AND (
        NEW.max_data_class<>'CUSTOMER_CONTACT' OR v.dpa_status='ACTIVE'
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'workforce capability requires approved vendor, active contract, tax clearance, pricing/caps and DPA for customer-contact data'); END;

CREATE TRIGGER IF NOT EXISTS workforce_capability_approval_guard_update
BEFORE UPDATE OF approved,unit_cost_cents,max_data_class ON workforce_vendor_capabilities
WHEN NEW.approved=1 AND (
  NEW.unit_cost_cents<=0 OR
  NOT EXISTS (
    SELECT 1 FROM workforce_vendors v
    WHERE v.id=NEW.vendor_id
      AND v.status='APPROVED'
      AND v.contract_status='ACTIVE'
      AND v.tax_status='CLEARED'
      AND v.per_work_order_cap_cents>0
      AND v.monthly_cap_cents>0
      AND (
        NEW.max_data_class<>'CUSTOMER_CONTACT' OR v.dpa_status='ACTIVE'
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'workforce capability requires approved vendor, active contract, tax clearance, pricing/caps and DPA for customer-contact data'); END;

CREATE TRIGGER IF NOT EXISTS workforce_vendor_no_dpa_regression
BEFORE UPDATE OF dpa_status,status,auto_dispatch_enabled ON workforce_vendors
WHEN NEW.status='APPROVED' AND NEW.auto_dispatch_enabled=1
 AND EXISTS (
   SELECT 1 FROM workforce_vendor_capabilities c
   WHERE c.vendor_id=NEW.id AND c.approved=1 AND c.max_data_class='CUSTOMER_CONTACT'
 )
 AND NEW.dpa_status<>'ACTIVE'
BEGIN SELECT RAISE(ABORT, 'auto-dispatch vendor handling customer contact data requires an active DPA'); END;

CREATE TRIGGER IF NOT EXISTS workforce_vendor_no_contract_regression
BEFORE UPDATE OF contract_status,tax_status,status,auto_dispatch_enabled,per_work_order_cap_cents,monthly_cap_cents ON workforce_vendors
WHEN NEW.status='APPROVED' AND NEW.auto_dispatch_enabled=1 AND (
  NEW.contract_status<>'ACTIVE' OR NEW.tax_status<>'CLEARED' OR
  NEW.per_work_order_cap_cents<=0 OR NEW.monthly_cap_cents<=0
)
BEGIN SELECT RAISE(ABORT, 'auto-dispatch vendor cannot remain active after contract/tax/budget controls regress'); END;

-- -----------------------------------------------------------------------------
-- Builtegrity fee refunds are exceptional platform-fault credits, never a side effect of a
-- merchant/customer refund. Any processor-side application fee refund without an authorization
-- record is observable as an exception and must be reconciled.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_fee_credit_authorizations (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'DUPLICATE_PLATFORM_CHARGE',
    'INCORRECT_PLATFORM_FEE',
    'CONFIRMED_PLATFORM_DEFECT',
    'LEGAL_REQUIRED_CREDIT'
  )),
  evidence_reference TEXT NOT NULL,
  authorization_source TEXT NOT NULL CHECK (authorization_source IN ('SYSTEM_VERIFIED','AUTHORIZED_OPERATOR','LEGAL')),
  status TEXT NOT NULL DEFAULT 'AUTHORIZED' CHECK (status IN ('AUTHORIZED','PROCESSING','COMPLETED','FAILED','CANCELLED')),
  processor_fee_refund_id TEXT,
  authorized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);
CREATE INDEX IF NOT EXISTS idx_platform_fee_credit_tx
  ON platform_fee_credit_authorizations(transaction_id,status,authorized_at);

CREATE TRIGGER IF NOT EXISTS platform_fee_credit_no_amount_increase
BEFORE UPDATE OF amount_cents,transaction_id,merchant_id,reason_code,evidence_reference,authorization_source
ON platform_fee_credit_authorizations
WHEN NEW.amount_cents<>OLD.amount_cents OR NEW.transaction_id<>OLD.transaction_id OR
     NEW.merchant_id<>OLD.merchant_id OR NEW.reason_code<>OLD.reason_code OR
     NEW.evidence_reference<>OLD.evidence_reference OR NEW.authorization_source<>OLD.authorization_source
BEGIN SELECT RAISE(ABORT, 'platform fee credit authorization evidence is immutable'); END;

-- The authorized platform-fault credit may never exceed the Builtegrity fee actually earned on
-- that transaction. This prevents a credit record from becoming a generic transfer mechanism.
CREATE TRIGGER IF NOT EXISTS platform_fee_credit_amount_guard_insert
BEFORE INSERT ON platform_fee_credit_authorizations
WHEN NEW.amount_cents > COALESCE((
  SELECT CAST(COALESCE(integrity_fee_earned_micros,integrity_fee_earned_cents*10000)/10000 AS INTEGER)
  FROM transactions WHERE id=NEW.transaction_id AND merchant_id=NEW.merchant_id
),0)
BEGIN SELECT RAISE(ABORT, 'platform fee credit cannot exceed earned Builtegrity fee'); END;

-- -----------------------------------------------------------------------------
-- Optional-cost circuit breakers. Critical payment/record correctness is never coupled to
-- email, PDFs, AI, enrichment or nonessential analytics.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS optional_service_controls (
  service_code TEXT PRIMARY KEY CHECK (service_code IN ('EMAIL_DIGESTS','PDF_BATCH','AI_ASSIST','ENRICHMENT','NONESSENTIAL_ANALYTICS','OUTSOURCED_LABOR')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  monthly_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_budget_cents >= 0),
  current_month_spend_cents INTEGER NOT NULL DEFAULT 0 CHECK (current_month_spend_cents >= 0),
  disable_at_budget_ppm INTEGER NOT NULL DEFAULT 1000000 CHECK (disable_at_budget_ppm BETWEEN 1 AND 1000000),
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO optional_service_controls (service_code,enabled,monthly_budget_cents,disable_at_budget_ppm,reason) VALUES
('EMAIL_DIGESTS',1,5000,1000000,'Transactional resolution notices are not governed by this optional digest control.'),
('PDF_BATCH',1,5000,1000000,'PDF generation may pause without affecting payments or transaction records.'),
('AI_ASSIST',0,0,1000000,'AI is noncritical and disabled until explicitly budgeted.'),
('ENRICHMENT',0,0,1000000,'External enrichment is noncritical and disabled until explicitly budgeted.'),
('NONESSENTIAL_ANALYTICS',1,5000,1000000,'Nonessential analytics may pause without affecting transaction protection.'),
('OUTSOURCED_LABOR',1,50000,1000000,'Workforce policy and vendor caps provide the primary spend controls.');

CREATE TABLE IF NOT EXISTS variable_cost_ledger (
  id TEXT PRIMARY KEY,
  service_code TEXT NOT NULL,
  provider_code TEXT,
  transaction_id TEXT,
  resolution_instance_id TEXT,
  work_order_id TEXT,
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  source_reference TEXT NOT NULL,
  incurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_variable_cost_month
  ON variable_cost_ledger(service_code,incurred_at);
CREATE TRIGGER IF NOT EXISTS variable_cost_ledger_no_update BEFORE UPDATE ON variable_cost_ledger
BEGIN SELECT RAISE(ABORT, 'variable cost ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS variable_cost_ledger_no_delete BEFORE DELETE ON variable_cost_ledger
BEGIN SELECT RAISE(ABORT, 'variable cost ledger is append-only'); END;

CREATE VIEW IF NOT EXISTS variable_cost_monthly_summary AS
SELECT
  strftime('%Y-%m',incurred_at) AS month,
  service_code,
  provider_code,
  COUNT(*) AS entries,
  SUM(amount_micros) AS amount_micros,
  ROUND(SUM(amount_micros)/10000.0,2) AS amount_cents
FROM variable_cost_ledger
GROUP BY strftime('%Y-%m',incurred_at),service_code,provider_code;

-- Work-order commitments appear automatically in the cost ledger when verified. External-autopay
-- remains a payment method, not a blank check: the estimated contracted unit cost is recorded.
CREATE TRIGGER IF NOT EXISTS workforce_verified_cost_ledger
AFTER UPDATE OF status ON workforce_work_orders
WHEN OLD.status<>'VERIFIED' AND NEW.status='VERIFIED' AND NEW.estimated_cost_cents>0
BEGIN
  INSERT OR IGNORE INTO variable_cost_ledger
    (id,service_code,provider_code,resolution_instance_id,work_order_id,amount_micros,source_reference,incurred_at)
  SELECT
    'COST-'||NEW.id,
    'OUTSOURCED_LABOR',
    v.provider_code,
    NEW.resolution_instance_id,
    NEW.id,
    NEW.estimated_cost_cents*10000,
    NEW.id,
    CURRENT_TIMESTAMP
  FROM workforce_vendors v WHERE v.id=NEW.vendor_id;
END;

-- Explicit non-outsourcing policy for decisions that should never be delegated automatically.
CREATE TABLE IF NOT EXISTS non_outsourceable_work (
  category TEXT PRIMARY KEY,
  reason TEXT NOT NULL
);
INSERT OR REPLACE INTO non_outsourceable_work (category,reason) VALUES
('SECURITY_DECISION','Credential compromise, security containment and privileged security clearance require an authorized Builtegrity security decision path.'),
('LEGAL_DECISION','Legal/regulatory interpretation and clearance cannot be delegated to a generic workforce vendor.'),
('PRICING_CHANGE','Pricing changes require a versioned Builtegrity decision and cannot be made by outsourced support.'),
('REVENUE_WRITEOFF','Outsourced vendors may investigate fee records but cannot authorize Builtegrity revenue write-offs.'),
('VENDOR_APPROVAL','A workforce vendor cannot approve itself or another vendor for automatic dispatch.');
