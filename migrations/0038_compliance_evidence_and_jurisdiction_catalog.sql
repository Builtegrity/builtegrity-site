PRAGMA foreign_keys = ON;

-- Compliance cannot become green merely because a status string was changed.  Keep the
-- underlying review/evidence dates needed to prove why a gate was cleared.
ALTER TABLE platform_compliance_controls ADD COLUMN pci_validation_reference TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN pci_validation_type TEXT
  CHECK (pci_validation_type IS NULL OR pci_validation_type IN ('SAQ_A','SAQ_A_EP','SAQ_D','ROC','OTHER'));
ALTER TABLE platform_compliance_controls ADD COLUMN pci_attested_at TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN pci_expires_at TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN pci_asv_required INTEGER CHECK (pci_asv_required IS NULL OR pci_asv_required IN (0,1));
ALTER TABLE platform_compliance_controls ADD COLUMN pci_asv_status TEXT
  CHECK (pci_asv_status IS NULL OR pci_asv_status IN ('NOT_APPLICABLE','PENDING','PASS','FAIL','EXPIRED'));
ALTER TABLE platform_compliance_controls ADD COLUMN pci_asv_last_pass_at TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN pci_asv_next_due_at TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN money_transmission_review_reference TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN ri_sales_tax_permit_reference TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN platform_fee_tax_method_reference TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN privacy_program_reference TEXT;
ALTER TABLE platform_compliance_controls ADD COLUMN information_security_program_reference TEXT;

ALTER TABLE merchants ADD COLUMN restricted_business_reviewed_at TEXT;
ALTER TABLE merchants ADD COLUMN restricted_business_evidence_ref TEXT;
ALTER TABLE merchants ADD COLUMN sanctions_evidence_ref TEXT;
ALTER TABLE merchants ADD COLUMN sanctions_next_review_due_at TEXT;

-- A current PCI validation is mandatory before an ACTIVE merchant can exist.  ASV is
-- conditional because the applicable PCI validation path must be determined from the
-- real production integration/acquirer requirements, not guessed by application code.
CREATE TRIGGER IF NOT EXISTS merchants_active_requires_current_pci_insert
BEFORE INSERT ON merchants WHEN NEW.status='ACTIVE' AND NOT EXISTS (
  SELECT 1 FROM platform_compliance_controls p
   WHERE p.id='GLOBAL'
     AND p.pci_status='VALID'
     AND p.pci_validation_reference IS NOT NULL
     AND p.pci_attested_at IS NOT NULL
     AND p.pci_expires_at IS NOT NULL
     AND datetime(p.pci_expires_at)>CURRENT_TIMESTAMP
     AND (
       p.pci_asv_required=0 OR
       (p.pci_asv_required=1 AND p.pci_asv_status='PASS'
        AND p.pci_asv_last_pass_at IS NOT NULL
        AND p.pci_asv_next_due_at IS NOT NULL
        AND datetime(p.pci_asv_next_due_at)>CURRENT_TIMESTAMP)
     )
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires current evidenced PCI validation'); END;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_current_pci_update
BEFORE UPDATE OF status ON merchants WHEN NEW.status='ACTIVE' AND NOT EXISTS (
  SELECT 1 FROM platform_compliance_controls p
   WHERE p.id='GLOBAL'
     AND p.pci_status='VALID'
     AND p.pci_validation_reference IS NOT NULL
     AND p.pci_attested_at IS NOT NULL
     AND p.pci_expires_at IS NOT NULL
     AND datetime(p.pci_expires_at)>CURRENT_TIMESTAMP
     AND (
       p.pci_asv_required=0 OR
       (p.pci_asv_required=1 AND p.pci_asv_status='PASS'
        AND p.pci_asv_last_pass_at IS NOT NULL
        AND p.pci_asv_next_due_at IS NOT NULL
        AND datetime(p.pci_asv_next_due_at)>CURRENT_TIMESTAMP)
     )
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires current evidenced PCI validation'); END;

-- Merchant sanctions/restricted-business clearance also requires evidence and an expiry
-- date for sanctions screening so a stale one-time check cannot remain green forever.
CREATE TRIGGER IF NOT EXISTS merchants_active_requires_risk_evidence_insert
BEFORE INSERT ON merchants WHEN NEW.status='ACTIVE' AND (
  NEW.restricted_business_reviewed_at IS NULL OR NEW.restricted_business_evidence_ref IS NULL OR
  NEW.sanctions_reviewed_at IS NULL OR NEW.sanctions_evidence_ref IS NULL OR
  NEW.sanctions_next_review_due_at IS NULL OR datetime(NEW.sanctions_next_review_due_at)<=CURRENT_TIMESTAMP
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires current sanctions and restricted-business evidence'); END;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_risk_evidence_update
BEFORE UPDATE OF status,restricted_business_status,sanctions_review_status,sanctions_next_review_due_at ON merchants
WHEN NEW.status='ACTIVE' AND (
  NEW.restricted_business_reviewed_at IS NULL OR NEW.restricted_business_evidence_ref IS NULL OR
  NEW.sanctions_reviewed_at IS NULL OR NEW.sanctions_evidence_ref IS NULL OR
  NEW.sanctions_next_review_due_at IS NULL OR datetime(NEW.sanctions_next_review_due_at)<=CURRENT_TIMESTAMP
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires current sanctions and restricted-business evidence'); END;

-- Every state and DC is represented explicitly.  Nothing outside Rhode Island becomes
-- launchable merely because a two-letter state code was accepted by the database.
INSERT OR IGNORE INTO state_jurisdiction_support(state_code,state_name,merchant_onboarding_status,notes) VALUES
('AL','Alabama','BLOCKED','Jurisdiction pack required before merchant activation.'),
('AK','Alaska','BLOCKED','Jurisdiction pack required before merchant activation.'),
('AZ','Arizona','BLOCKED','Jurisdiction pack required before merchant activation.'),
('AR','Arkansas','BLOCKED','Jurisdiction pack required before merchant activation.'),
('CA','California','BLOCKED','Jurisdiction pack required before merchant activation.'),
('CO','Colorado','BLOCKED','Jurisdiction pack required before merchant activation.'),
('CT','Connecticut','BLOCKED','Jurisdiction pack required before merchant activation.'),
('DE','Delaware','BLOCKED','Jurisdiction pack required before merchant activation.'),
('DC','District of Columbia','BLOCKED','Jurisdiction pack required before merchant activation.'),
('FL','Florida','BLOCKED','Jurisdiction pack required before merchant activation.'),
('GA','Georgia','BLOCKED','Jurisdiction pack required before merchant activation.'),
('HI','Hawaii','BLOCKED','Jurisdiction pack required before merchant activation.'),
('ID','Idaho','BLOCKED','Jurisdiction pack required before merchant activation.'),
('IL','Illinois','BLOCKED','Jurisdiction pack required before merchant activation.'),
('IN','Indiana','BLOCKED','Jurisdiction pack required before merchant activation.'),
('IA','Iowa','BLOCKED','Jurisdiction pack required before merchant activation.'),
('KS','Kansas','BLOCKED','Jurisdiction pack required before merchant activation.'),
('KY','Kentucky','BLOCKED','Jurisdiction pack required before merchant activation.'),
('LA','Louisiana','BLOCKED','Jurisdiction pack required before merchant activation.'),
('ME','Maine','BLOCKED','Jurisdiction pack required before merchant activation.'),
('MD','Maryland','BLOCKED','Jurisdiction pack required before merchant activation.'),
('MA','Massachusetts','BLOCKED','Jurisdiction pack required before merchant activation.'),
('MI','Michigan','BLOCKED','Jurisdiction pack required before merchant activation.'),
('MN','Minnesota','BLOCKED','Jurisdiction pack required before merchant activation.'),
('MS','Mississippi','BLOCKED','Jurisdiction pack required before merchant activation.'),
('MO','Missouri','BLOCKED','Jurisdiction pack required before merchant activation.'),
('MT','Montana','BLOCKED','Jurisdiction pack required before merchant activation.'),
('NE','Nebraska','BLOCKED','Jurisdiction pack required before merchant activation.'),
('NV','Nevada','BLOCKED','Jurisdiction pack required before merchant activation.'),
('NH','New Hampshire','BLOCKED','Jurisdiction pack required before merchant activation.'),
('NJ','New Jersey','BLOCKED','Jurisdiction pack required before merchant activation.'),
('NM','New Mexico','BLOCKED','Jurisdiction pack required before merchant activation.'),
('NY','New York','BLOCKED','Jurisdiction pack required before merchant activation.'),
('NC','North Carolina','BLOCKED','Jurisdiction pack required before merchant activation.'),
('ND','North Dakota','BLOCKED','Jurisdiction pack required before merchant activation.'),
('OH','Ohio','BLOCKED','Jurisdiction pack required before merchant activation.'),
('OK','Oklahoma','BLOCKED','Jurisdiction pack required before merchant activation.'),
('OR','Oregon','BLOCKED','Jurisdiction pack required before merchant activation.'),
('PA','Pennsylvania','BLOCKED','Jurisdiction pack required before merchant activation.'),
('RI','Rhode Island','COUNSEL_REVIEW','Launch state; exact payments, tax, privacy, breach, entity and e-transaction pack must be cleared.'),
('SC','South Carolina','BLOCKED','Jurisdiction pack required before merchant activation.'),
('SD','South Dakota','BLOCKED','Jurisdiction pack required before merchant activation.'),
('TN','Tennessee','BLOCKED','Jurisdiction pack required before merchant activation.'),
('TX','Texas','BLOCKED','Jurisdiction pack required before merchant activation.'),
('UT','Utah','BLOCKED','Jurisdiction pack required before merchant activation.'),
('VT','Vermont','BLOCKED','Jurisdiction pack required before merchant activation.'),
('VA','Virginia','BLOCKED','Jurisdiction pack required before merchant activation.'),
('WA','Washington','BLOCKED','Jurisdiction pack required before merchant activation.'),
('WV','West Virginia','BLOCKED','Jurisdiction pack required before merchant activation.'),
('WI','Wisconsin','BLOCKED','Jurisdiction pack required before merchant activation.'),
('WY','Wyoming','BLOCKED','Jurisdiction pack required before merchant activation.');

-- International expansion is modeled but technically disabled by platform_compliance_controls.
-- These entries are planning states only and cannot override the US-only database invariant.
CREATE TABLE IF NOT EXISTS country_jurisdiction_support (
  country_code TEXT PRIMARY KEY,
  country_name TEXT NOT NULL,
  expansion_status TEXT NOT NULL CHECK (expansion_status IN ('CURRENT_SCOPE','FUTURE_REVIEW','BLOCKED')),
  payments_review_status TEXT NOT NULL DEFAULT 'PENDING',
  indirect_tax_review_status TEXT NOT NULL DEFAULT 'PENDING',
  privacy_review_status TEXT NOT NULL DEFAULT 'PENDING',
  consumer_law_review_status TEXT NOT NULL DEFAULT 'PENDING',
  electronic_contract_review_status TEXT NOT NULL DEFAULT 'PENDING',
  stripe_account_review_status TEXT NOT NULL DEFAULT 'PENDING',
  counsel_reference TEXT,
  reviewed_at TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO country_jurisdiction_support(country_code,country_name,expansion_status,notes) VALUES
('US','United States','CURRENT_SCOPE','Only country enabled by V1 hard constraints.'),
('CA','Canada','FUTURE_REVIEW','Potential English-language expansion; disabled until tax/privacy/payments review.'),
('GB','United Kingdom','FUTURE_REVIEW','Potential English-language expansion; disabled until VAT/UK GDPR/payments/consumer review.'),
('AU','Australia','FUTURE_REVIEW','Potential English-language expansion; disabled until GST/privacy/payments/consumer review.'),
('NZ','New Zealand','FUTURE_REVIEW','Potential English-language expansion; disabled until GST/privacy/payments/consumer review.');

-- The customer location used for privacy/breach jurisdiction is deliberately separate from
-- the merchant-scoped customer identity.  It may be populated from verified checkout data later.
ALTER TABLE customers ADD COLUMN state_code TEXT CHECK (state_code IS NULL OR (length(state_code)=2 AND state_code=upper(state_code)));
ALTER TABLE customers ADD COLUMN state_source TEXT CHECK (state_source IS NULL OR state_source IN ('MERCHANT','STRIPE_BILLING','CUSTOMER','OTHER'));
ALTER TABLE customers ADD COLUMN state_verified_at TEXT;

-- Before a live transaction record is even created, the merchant must still satisfy the
-- platform + state + merchant legal gates.  TEST merchants remain usable by CI/dev fixtures.
CREATE TRIGGER IF NOT EXISTS transactions_live_insert_requires_legal_clearance
BEFORE INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM merchants m WHERE m.id=NEW.merchant_id AND m.status='ACTIVE')
AND (
  NOT EXISTS (SELECT 1 FROM platform_legal_readiness p WHERE p.state='READY') OR
  NOT EXISTS (SELECT 1 FROM merchant_legal_readiness m WHERE m.merchant_id=NEW.merchant_id AND m.legal_state='READY') OR
  NOT EXISTS (
    SELECT 1 FROM merchants m JOIN state_jurisdiction_support s ON s.state_code=m.state_code
     WHERE m.id=NEW.merchant_id
       AND s.merchant_onboarding_status='READY'
       AND s.money_transmission_review_status IN ('CLEARED_NON_LICENSED','LICENSE_ACTIVE')
       AND s.sales_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
       AND s.privacy_review_status='CLEARED'
       AND s.breach_review_status='CLEARED'
       AND s.entity_nexus_review_status IN ('CLEARED','REGISTERED')
       AND s.income_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
       AND s.electronic_transactions_review_status='CLEARED'
       AND (s.next_review_due_at IS NULL OR datetime(s.next_review_due_at)>CURRENT_TIMESTAMP)
  )
)
BEGIN SELECT RAISE(ABORT,'live transaction creation requires current legal/compliance clearance'); END;

-- Add missing conditional/risk controls without pretending they are universally mandated.
INSERT OR IGNORE INTO compliance_obligations(id,jurisdiction,category,obligation_type,title,requirement_summary,trigger_summary,source_name,source_url,status) VALUES
('COMP-US-CYBER-INSURANCE','US','INSURANCE','RISK_CONTROL','Cyber/E&O insurance review','Evaluate cyber, technology E&O and general liability coverage against contractual and incident exposure; insurance is not represented as universally mandated by law.','Before material live scale and whenever major enterprise contracts require coverage.','Internal risk management control','https://www.sba.gov/business-guide/launch-your-business/get-business-insurance','OPEN'),
('COMP-US-MERCHANT-AUTH','US','CONTRACTING','REQUIRED','Merchant-authenticated legal acceptance','A merchant owner/admin—not a Builtegrity operator—must authenticate and affirmatively accept the exact approved Platform Agreement, DPA, AUP, Fee Schedule and Electronic Records Consent versions before activation.','Every merchant activation and every material re-acceptance event.','E-SIGN / Stripe Platform Provider Agreement controls','https://stripe.com/legal/connect-account','OPEN'),
('COMP-US-SDLC','US','SECURITY','RISK_CONTROL','Protected production source-control workflow','Require reviewed CI-protected changes for production compliance/payment code; restrict direct writes to the production branch and periodically review repository/admin access.','Production source code and infrastructure changes.','FTC Start with Security / internal secure-SDLC control','https://www.ftc.gov/business-guidance/resources/start-security-guide-business','OPEN'),
('COMP-RI-LOCAL','US-RI','LOCAL','CONDITIONAL','Municipal zoning/registration review','Confirm the actual Rhode Island operating address and applicable city/town zoning, home-occupation, registration or local permit requirements before using that location as the business premises.','When Builtegrity establishes or changes its physical/home business location.','Rhode Island Department of State municipal guidance','https://www.sos.ri.gov/divisions/business-services/ri-trade-names/maintain-update-trade-name/municipal-registration','OPEN');

-- Correct the earlier information-return source metadata while preserving the immutable obligation ID.
UPDATE compliance_obligations
   SET source_name='IRS Form 1099 information-return guidance',
       source_url='https://www.irs.gov/businesses/small-businesses-self-employed/am-i-required-to-file-a-form-1099-or-other-information-return',
       updated_at=CURRENT_TIMESTAMP
 WHERE id='COMP-FED-W9-1099';
