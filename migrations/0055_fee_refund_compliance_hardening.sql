PRAGMA foreign_keys = ON;

-- Platform-fee retention is allowed only when an approved fee/refund policy, explicit
-- merchant acceptance, and a reviewed jurisdiction rule all exist. Unknown law fails closed.
ALTER TABLE platform_compliance_controls ADD COLUMN platform_fee_refund_policy_status TEXT NOT NULL DEFAULT 'PENDING_COUNSEL'
  CHECK (platform_fee_refund_policy_status IN ('PENDING_COUNSEL','APPROVED','BLOCKED','REVIEW_EXPIRED'));
ALTER TABLE platform_compliance_controls ADD COLUMN platform_fee_refund_policy_reference TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN platform_fee_refund_policy_reviewed_at TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN platform_fee_refund_policy_next_review_due_at TEXT;

ALTER TABLE state_jurisdiction_support ADD COLUMN platform_fee_refund_review_status TEXT NOT NULL DEFAULT 'PENDING_COUNSEL'
  CHECK (platform_fee_refund_review_status IN ('PENDING_COUNSEL','READY','BLOCKED','REVIEW_EXPIRED'));
ALTER TABLE state_jurisdiction_support ADD COLUMN platform_fee_refund_handler_code TEXT;
ALTER TABLE state_jurisdiction_support ADD COLUMN platform_fee_refund_reference TEXT;
ALTER TABLE state_jurisdiction_support ADD COLUMN platform_fee_refund_reviewed_at TEXT;
ALTER TABLE state_jurisdiction_support ADD COLUMN platform_fee_refund_next_review_due_at TEXT;

CREATE TABLE IF NOT EXISTS fee_refund_handler_catalog (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  underlying_refund_behavior TEXT NOT NULL CHECK (underlying_refund_behavior IN (
    'RETAIN','FULL_ON_FULL_REFUND','FULL_ON_ANY_REFUND','PRO_RATA_TO_UNDERLYING_REFUND'
  )),
  dispute_loss_behavior TEXT NOT NULL DEFAULT 'RETAIN' CHECK (dispute_loss_behavior IN ('RETAIN','TREAT_AS_FULL_REFUND')),
  implementation_status TEXT NOT NULL CHECK (implementation_status IN ('TESTED','NEEDS_IMPLEMENTATION','DISABLED')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR REPLACE INTO fee_refund_handler_catalog
(code,description,underlying_refund_behavior,dispute_loss_behavior,implementation_status,notes) VALUES
('RETAIN_IF_EARNED','Retain an already-earned Builtegrity Platform Fee after merchant/customer refund, cancellation, or dispute unless another legal/processor override applies.','RETAIN','RETAIN','TESTED','Preferred Builtegrity default. May be selected only after counsel confirms the applicable jurisdiction permits this treatment.'),
('FULL_APP_FEE_ON_FULL_REFUND','Refund the full gross Builtegrity application fee when the underlying charge becomes fully refunded.','FULL_ON_FULL_REFUND','RETAIN','TESTED','Conservative handler. Includes any prior fractional-carry cents collected on this application fee.'),
('FULL_APP_FEE_ON_ANY_REFUND','Refund the full gross Builtegrity application fee after any positive underlying refund.','FULL_ON_ANY_REFUND','RETAIN','TESTED','Most conservative refund handler.'),
('PRO_RATA_APP_FEE','Refund the same proportion of the gross Builtegrity application fee as the cumulative underlying refund bears to the original charge.','PRO_RATA_TO_UNDERLYING_REFUND','RETAIN','TESTED','Rounds the required cumulative platform-fee refund upward to the next cent, never downward against the merchant.'),
('FULL_APP_FEE_ON_FULL_REFUND_OR_LOST_DISPUTE','Refund the full gross Builtegrity application fee on a full underlying refund or a lost dispute.','FULL_ON_FULL_REFUND','TREAT_AS_FULL_REFUND','TESTED','Use only where counsel/processor terms require dispute-loss treatment to follow a full refund.');

CREATE TABLE IF NOT EXISTS fee_refund_policy_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COUNSEL_REVIEW','APPROVED','RETIRED')),
  fee_earned_event_code TEXT NOT NULL DEFAULT 'PROTECTED_CONFIRMED' CHECK (fee_earned_event_code='PROTECTED_CONFIRMED'),
  default_handler_code TEXT NOT NULL,
  platform_error_treatment TEXT NOT NULL DEFAULT 'REFUND_VERIFIED_EXCESS' CHECK (platform_error_treatment='REFUND_VERIFIED_EXCESS'),
  legal_override_method TEXT NOT NULL DEFAULT 'STRICTER_APPLICABLE_RULE_WINS' CHECK (legal_override_method='STRICTER_APPLICABLE_RULE_WINS'),
  processor_override_method TEXT NOT NULL DEFAULT 'PROCESSOR_REQUIREMENT_OVERRIDES_DEFAULT' CHECK (processor_override_method='PROCESSOR_REQUIREMENT_OVERRIDES_DEFAULT'),
  disclosure_summary TEXT NOT NULL,
  effective_at TEXT,
  counsel_reviewed_at TEXT,
  counsel_reference TEXT,
  next_review_due_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (default_handler_code) REFERENCES fee_refund_handler_catalog(code)
);

INSERT OR IGNORE INTO fee_refund_policy_versions
(id,version,status,default_handler_code,disclosure_summary) VALUES
('FEE-REFUND-POLICY-V1','2026-10-v1','COUNSEL_REVIEW','RETAIN_IF_EARNED',
 'Builtegrity charges only on successfully processed PROTECTED payments. The Platform Fee becomes earned only when the protected payment succeeds and the matching Builtegrity application fee is processor-confirmed. A later refund, cancellation, or dispute does not by itself reverse an earned Platform Fee except where applicable law, processor requirements, or a verified Builtegrity error require a refund or credit.');

CREATE TABLE IF NOT EXISTS merchant_fee_policy_acceptances (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  fee_schedule_version TEXT NOT NULL,
  fee_refund_policy_version TEXT NOT NULL,
  acknowledgment_version TEXT NOT NULL,
  acknowledgment_text TEXT NOT NULL,
  acknowledgment_sha256 TEXT NOT NULL,
  network_evidence_hash TEXT,
  user_agent_hash TEXT,
  accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE(merchant_id,external_user_id,fee_schedule_version,fee_refund_policy_version,acknowledgment_version)
);
CREATE INDEX IF NOT EXISTS idx_merchant_fee_policy_acceptance ON merchant_fee_policy_acceptances(merchant_id,accepted_at);
CREATE TRIGGER IF NOT EXISTS merchant_fee_policy_acceptances_no_update BEFORE UPDATE ON merchant_fee_policy_acceptances
BEGIN SELECT RAISE(ABORT,'merchant fee-policy acceptance evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS merchant_fee_policy_acceptances_no_delete BEFORE DELETE ON merchant_fee_policy_acceptances
BEGIN SELECT RAISE(ABORT,'merchant fee-policy acceptance evidence is immutable'); END;

ALTER TABLE transactions ADD COLUMN fee_refund_policy_version_id TEXT;
ALTER TABLE transactions ADD COLUMN merchant_fee_policy_acceptance_id TEXT;
ALTER TABLE transactions ADD COLUMN fee_refund_handler_code TEXT;
ALTER TABLE transactions ADD COLUMN fee_refund_rule_source TEXT;
ALTER TABLE transactions ADD COLUMN fee_refund_merchant_state_code TEXT;
ALTER TABLE transactions ADD COLUMN fee_refund_customer_state_code TEXT;
ALTER TABLE transactions ADD COLUMN fee_refund_rule_locked_at TEXT;
ALTER TABLE transactions ADD COLUMN platform_fee_earned_at TEXT;
ALTER TABLE transactions ADD COLUMN platform_fee_earned_event_code TEXT;

CREATE TRIGGER IF NOT EXISTS transactions_mark_platform_fee_earned
AFTER UPDATE OF record_classification ON transactions
WHEN OLD.record_classification<>'PROTECTED' AND NEW.record_classification='PROTECTED'
BEGIN
  UPDATE transactions
     SET platform_fee_earned_at=COALESCE(platform_fee_earned_at,CURRENT_TIMESTAMP),
         platform_fee_earned_event_code=COALESCE(platform_fee_earned_event_code,'PROTECTED_CONFIRMED')
   WHERE id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS transactions_platform_fee_earned_history_immutable
BEFORE UPDATE OF platform_fee_earned_at,platform_fee_earned_event_code ON transactions
WHEN OLD.platform_fee_earned_at IS NOT NULL AND (
  COALESCE(NEW.platform_fee_earned_at,'')<>COALESCE(OLD.platform_fee_earned_at,'') OR
  COALESCE(NEW.platform_fee_earned_event_code,'')<>COALESCE(OLD.platform_fee_earned_event_code,'')
)
BEGIN SELECT RAISE(ABORT,'platform fee earned evidence is immutable'); END;

CREATE TRIGGER IF NOT EXISTS transactions_fee_refund_rule_immutable_after_checkout
BEFORE UPDATE OF fee_refund_policy_version_id,merchant_fee_policy_acceptance_id,fee_refund_handler_code,
                 fee_refund_rule_source,fee_refund_merchant_state_code,fee_refund_customer_state_code,fee_refund_rule_locked_at
ON transactions
WHEN OLD.fee_refund_rule_locked_at IS NOT NULL AND (
  COALESCE(NEW.fee_refund_policy_version_id,'')<>COALESCE(OLD.fee_refund_policy_version_id,'') OR
  COALESCE(NEW.merchant_fee_policy_acceptance_id,'')<>COALESCE(OLD.merchant_fee_policy_acceptance_id,'') OR
  COALESCE(NEW.fee_refund_handler_code,'')<>COALESCE(OLD.fee_refund_handler_code,'') OR
  COALESCE(NEW.fee_refund_rule_source,'')<>COALESCE(OLD.fee_refund_rule_source,'') OR
  COALESCE(NEW.fee_refund_merchant_state_code,'')<>COALESCE(OLD.fee_refund_merchant_state_code,'') OR
  COALESCE(NEW.fee_refund_customer_state_code,'')<>COALESCE(OLD.fee_refund_customer_state_code,'') OR
  COALESCE(NEW.fee_refund_rule_locked_at,'')<>COALESCE(OLD.fee_refund_rule_locked_at,'')
)
BEGIN SELECT RAISE(ABORT,'transaction fee/refund compliance snapshot is immutable once locked'); END;

CREATE TRIGGER IF NOT EXISTS state_fee_refund_ready_requires_tested_handler_insert
BEFORE INSERT ON state_jurisdiction_support
WHEN NEW.platform_fee_refund_review_status='READY' AND (
  NEW.platform_fee_refund_handler_code IS NULL OR NEW.platform_fee_refund_reference IS NULL OR NEW.platform_fee_refund_reviewed_at IS NULL OR
  NOT EXISTS (SELECT 1 FROM fee_refund_handler_catalog h WHERE h.code=NEW.platform_fee_refund_handler_code AND h.implementation_status='TESTED')
)
BEGIN SELECT RAISE(ABORT,'READY platform-fee refund rule requires counsel evidence and a TESTED handler'); END;

CREATE TRIGGER IF NOT EXISTS state_fee_refund_ready_requires_tested_handler_update
BEFORE UPDATE OF platform_fee_refund_review_status,platform_fee_refund_handler_code,platform_fee_refund_reference,platform_fee_refund_reviewed_at
ON state_jurisdiction_support
WHEN NEW.platform_fee_refund_review_status='READY' AND (
  NEW.platform_fee_refund_handler_code IS NULL OR NEW.platform_fee_refund_reference IS NULL OR NEW.platform_fee_refund_reviewed_at IS NULL OR
  NOT EXISTS (SELECT 1 FROM fee_refund_handler_catalog h WHERE h.code=NEW.platform_fee_refund_handler_code AND h.implementation_status='TESTED')
)
BEGIN SELECT RAISE(ABORT,'READY platform-fee refund rule requires counsel evidence and a TESTED handler'); END;

CREATE TRIGGER IF NOT EXISTS state_fee_refund_rule_demote_merchants
AFTER UPDATE OF platform_fee_refund_review_status,platform_fee_refund_handler_code,platform_fee_refund_next_review_due_at
ON state_jurisdiction_support
WHEN NEW.platform_fee_refund_review_status<>'READY'
 OR NEW.platform_fee_refund_handler_code IS NULL
 OR (NEW.platform_fee_refund_next_review_due_at IS NOT NULL AND datetime(NEW.platform_fee_refund_next_review_due_at)<=CURRENT_TIMESTAMP)
 OR NOT EXISTS (SELECT 1 FROM fee_refund_handler_catalog h WHERE h.code=NEW.platform_fee_refund_handler_code AND h.implementation_status='TESTED')
BEGIN
  UPDATE merchants SET status=CASE WHEN status='ACTIVE' THEN 'PAUSED' ELSE status END,
         compliance_status='BLOCKED',updated_at=CURRENT_TIMESTAMP WHERE state_code=NEW.state_code;
END;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_fee_refund_compliance_insert
BEFORE INSERT ON merchants
WHEN NEW.status='ACTIVE' AND (
  NOT EXISTS (
    SELECT 1 FROM platform_compliance_controls p WHERE p.id='GLOBAL'
      AND p.platform_fee_refund_policy_status='APPROVED'
      AND p.platform_fee_refund_policy_reference IS NOT NULL
      AND p.platform_fee_refund_policy_reviewed_at IS NOT NULL
      AND (p.platform_fee_refund_policy_next_review_due_at IS NULL OR datetime(p.platform_fee_refund_policy_next_review_due_at)>CURRENT_TIMESTAMP)
  ) OR
  NOT EXISTS (
    SELECT 1 FROM state_jurisdiction_support s JOIN fee_refund_handler_catalog h ON h.code=s.platform_fee_refund_handler_code
    WHERE s.state_code=NEW.state_code AND s.platform_fee_refund_review_status='READY' AND h.implementation_status='TESTED'
      AND s.platform_fee_refund_reference IS NOT NULL AND s.platform_fee_refund_reviewed_at IS NOT NULL
      AND (s.platform_fee_refund_next_review_due_at IS NULL OR datetime(s.platform_fee_refund_next_review_due_at)>CURRENT_TIMESTAMP)
  )
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires approved platform-fee refund policy and reviewed state rule'); END;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_fee_refund_compliance_update
BEFORE UPDATE OF status,state_code ON merchants
WHEN NEW.status='ACTIVE' AND (
  NOT EXISTS (
    SELECT 1 FROM platform_compliance_controls p WHERE p.id='GLOBAL'
      AND p.platform_fee_refund_policy_status='APPROVED'
      AND p.platform_fee_refund_policy_reference IS NOT NULL
      AND p.platform_fee_refund_policy_reviewed_at IS NOT NULL
      AND (p.platform_fee_refund_policy_next_review_due_at IS NULL OR datetime(p.platform_fee_refund_policy_next_review_due_at)>CURRENT_TIMESTAMP)
  ) OR
  NOT EXISTS (
    SELECT 1 FROM state_jurisdiction_support s JOIN fee_refund_handler_catalog h ON h.code=s.platform_fee_refund_handler_code
    WHERE s.state_code=NEW.state_code AND s.platform_fee_refund_review_status='READY' AND h.implementation_status='TESTED'
      AND s.platform_fee_refund_reference IS NOT NULL AND s.platform_fee_refund_reviewed_at IS NOT NULL
      AND (s.platform_fee_refund_next_review_due_at IS NULL OR datetime(s.platform_fee_refund_next_review_due_at)>CURRENT_TIMESTAMP)
  )
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires approved platform-fee refund policy and reviewed state rule'); END;

INSERT OR IGNORE INTO compliance_obligations
(id,jurisdiction,category,obligation_type,title,requirement_summary,trigger_summary,source_name,source_url,status) VALUES
('COMP-FEE-REFUND-POLICY','US','PLATFORM_FEES','REQUIRED','Platform Fee earning and refund policy counsel approval',
 'Counsel must approve the exact event at which the Builtegrity Platform Fee becomes earned, the retain-by-default rule, the Builtegrity-error credit rule, and the legal/processor override mechanism before LIVE.',
 'Initial launch and every material fee/refund-policy change.','Stripe Connected Account Agreement','https://stripe.com/legal/connect-account','COUNSEL_REVIEW'),
('COMP-FEE-DISCLOSURE','US','PLATFORM_FEES','REQUIRED','Clear and prominent Platform Fee/refundability disclosure',
 'The Platform Provider Agreement and Fee Schedule must clearly disclose the Platform Fee, when it is earned, ordinary refund treatment, and all automatic exception categories; merchant acceptance evidence must identify the exact versions accepted.',
 'Before merchant activation and after every material pricing/refundability change.','Stripe Connect Services Terms','https://stripe.com/legal/ssa-services-terms','COUNSEL_REVIEW'),
('COMP-FEE-MARKETING-CLAIMS','US','ADVERTISING','REQUIRED','No contradictory fee/refund marketing claims',
 'Public claims may not imply the Platform Fee is refundable merely because the merchant later refunds the customer. Approved wording must describe successful processing rather than ultimate merchant retention of sale proceeds.',
 'All pricing, sales, onboarding and merchant-facing copy.','Federal Trade Commission business guidance','https://www.ftc.gov/business-guidance','COUNSEL_REVIEW'),
('COMP-RI-FEE-DTPA','US-RI','PLATFORM_FEES','REQUIRED','Rhode Island deceptive-practices review for Platform Fee disclosures',
 'Rhode Island counsel must confirm that Builtegrity fee earning/refundability disclosures and merchant contracting do not create an unfair or deceptive practice and must identify any required refund override.',
 'Rhode Island launch and any material fee/refund-policy change.','R.I. Gen. Laws 6-13.1-2','https://webserver.rilegislature.gov/Statutes/TITLE6/6-13.1/6-13.1-2.htm','COUNSEL_REVIEW'),
('COMP-STRIPE-FEE-REFUND-TERMS','US','PLATFORM_FEES','REQUIRED','Stripe Platform Fee/refund terms review',
 'Review current Stripe Connect and application-fee refund requirements and confirm the Builtegrity policy remains compatible. Re-review on material Stripe terms changes.',
 'Initial launch, Stripe legal-term change, and periodic review.','Stripe Connected Account Agreement','https://stripe.com/legal/connect-account','COUNSEL_REVIEW');

UPDATE legal_document_versions SET status='RETIRED'
 WHERE id IN ('LEGAL-PLATFORM-001','LEGAL-FEE-001') AND status<>'APPROVED';
INSERT OR IGNORE INTO legal_document_versions(id,document_type,version,status,public_path) VALUES
('LEGAL-PLATFORM-002','PLATFORM_AGREEMENT','2026-10-fee-refund-v1-draft','DRAFT','/terms/'),
('LEGAL-FEE-002','FEE_SCHEDULE','2026-10-fee-refund-v1-draft','DRAFT','/legal/fees/');
