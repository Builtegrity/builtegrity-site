PRAGMA foreign_keys = ON;

-- State-by-state merchant enablement. U.S.-only is not enough: each merchant state must
-- have a reviewed jurisdiction pack before a merchant in that state can become ACTIVE.
CREATE TABLE IF NOT EXISTS state_jurisdiction_support (
  state_code TEXT PRIMARY KEY CHECK (length(state_code)=2 AND state_code=upper(state_code)),
  state_name TEXT NOT NULL,
  merchant_onboarding_status TEXT NOT NULL DEFAULT 'BLOCKED'
    CHECK (merchant_onboarding_status IN ('BLOCKED','COUNSEL_REVIEW','READY','SUSPENDED')),
  money_transmission_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (money_transmission_review_status IN ('PENDING','CLEARED_NON_LICENSED','LICENSE_REQUIRED','LICENSE_ACTIVE','SUSPENDED')),
  sales_tax_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (sales_tax_review_status IN ('PENDING','CLEARED','REGISTRATION_REQUIRED','REGISTERED','NOT_APPLICABLE')),
  privacy_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (privacy_review_status IN ('PENDING','CLEARED')),
  breach_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (breach_review_status IN ('PENDING','CLEARED')),
  entity_nexus_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (entity_nexus_review_status IN ('PENDING','CLEARED','FOREIGN_QUALIFICATION_REQUIRED','REGISTERED')),
  income_tax_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (income_tax_review_status IN ('PENDING','CLEARED','REGISTRATION_REQUIRED','REGISTERED','NOT_APPLICABLE')),
  electronic_transactions_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (electronic_transactions_review_status IN ('PENDING','CLEARED')),
  counsel_reference TEXT,
  tax_reference TEXT,
  reviewed_at TEXT,
  next_review_due_at TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO state_jurisdiction_support(state_code,state_name,merchant_onboarding_status,notes)
VALUES('RI','Rhode Island','COUNSEL_REVIEW','Launch state. Remains blocked until exact payments/tax/privacy/entity pack is cleared.');

-- Explicit Rhode Island state payments-law classification gate. Federal FinCEN analysis alone
-- is not enough because state currency-transmission licensing is separately administered.
INSERT OR IGNORE INTO compliance_obligations(
  id,jurisdiction,category,obligation_type,title,requirement_summary,trigger_summary,source_name,source_url,status
) VALUES
 ('COMP-RI-MONEY-TRANSMISSION','US-RI','PAYMENTS','REQUIRED','Rhode Island currency-transmission licensing classification',
  'Obtain documented Rhode Island payments-counsel/DBR analysis that Builtegrity''s exact Stripe direct-charge/application-fee architecture does not require a Rhode Island currency-transmission license, or obtain the required license before activation.',
  'Any Builtegrity activity with a Rhode Island resident/person; reopen before custody, stored value, transfers, escrow, manual payouts, marketplace funds routing, or other funds-flow changes.',
  'R.I. Gen. Laws §§ 19-14-1 and 19-14-2',
  'https://webserver.rilegislature.gov/Statutes/TITLE19/19-14/19-14-2.htm','COUNSEL_REVIEW'),
 ('COMP-US-STATE-MTL','US-STATES','PAYMENTS','REQUIRED','State money-transmitter/licensing expansion review',
  'Before enabling merchants in another state, determine under that state''s current law whether the exact Builtegrity funds flow requires money-transmitter/payment licensing or qualifies for an exclusion/exemption; record evidence in the state jurisdiction pack.',
  'Every new merchant state and every material funds-flow change.',
  'Conference of State Bank Supervisors / state regulators',
  'https://www.csbs.org/money-transmission-modernization-act','OPEN'),
 ('COMP-RI-UETA','US-RI','ELECTRONIC_RECORDS','REQUIRED','Rhode Island Uniform Electronic Transactions Act controls',
  'Capture agreement to transact electronically, preserve attribution/security evidence, and keep electronic records capable of retention/reproduction where writing requirements are satisfied electronically.',
  'Electronic merchant/customer agreements and transaction terms involving Rhode Island.',
  'R.I. Gen. Laws Chapter 42-127.1',
  'https://webserver.rilegislature.gov/Statutes/TITLE42/42-127.1/INDEX.HTM','OPEN'),
 ('COMP-FTC-GLBA-CLASSIFICATION','US-FEDERAL','PRIVACY_SECURITY','REQUIRED','GLBA / FTC Safeguards Rule classification',
  'Obtain documented analysis of whether Builtegrity is a financial institution or finder/significantly engaged in financial activities under the FTC Safeguards Rule. If covered, implement every applicable Safeguards Rule requirement and breach-reporting duty before LIVE.',
  'Initial launch and any expansion into financial activities, payments control, financial advice, lending, collection, or broader transaction intermediation.',
  'Federal Trade Commission Safeguards Rule',
  'https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know','COUNSEL_REVIEW');

-- No ACTIVE merchant without a supported state pack. Null/unknown state fails closed.
DROP TRIGGER IF EXISTS merchants_active_requires_compliance_insert;
DROP TRIGGER IF EXISTS merchants_active_requires_compliance_update;

CREATE TRIGGER merchants_active_requires_compliance_insert
BEFORE INSERT ON merchants WHEN NEW.status='ACTIVE' AND (
  NEW.country_code <> 'US' OR NEW.customer_market_scope <> 'US_ONLY' OR NEW.state_code IS NULL OR
  NEW.compliance_status <> 'READY' OR NEW.restricted_business_status <> 'CLEARED' OR
  NEW.sanctions_review_status <> 'CLEAR' OR NEW.legal_acceptance_complete_at IS NULL OR
  NOT EXISTS (
    SELECT 1 FROM state_jurisdiction_support s
    WHERE s.state_code=NEW.state_code
      AND s.merchant_onboarding_status='READY'
      AND s.money_transmission_review_status IN ('CLEARED_NON_LICENSED','LICENSE_ACTIVE')
      AND s.sales_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
      AND s.privacy_review_status='CLEARED'
      AND s.breach_review_status='CLEARED'
      AND s.entity_nexus_review_status IN ('CLEARED','REGISTERED')
      AND s.income_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
      AND s.electronic_transactions_review_status='CLEARED'
      AND (s.next_review_due_at IS NULL OR datetime(s.next_review_due_at)>CURRENT_TIMESTAMP)
  ) OR
  NOT EXISTS (
    SELECT 1 FROM platform_compliance_controls p
    WHERE p.id='GLOBAL'
      AND p.legal_entity_status='CONFIRMED'
      AND p.money_transmission_review_status='CONFIRMED_NON_MSB'
      AND p.ri_sales_tax_permit_status IN ('ACTIVE','NOT_APPLICABLE')
      AND p.platform_fee_tax_method_status IN ('IMPLEMENTED','NOT_APPLICABLE')
      AND p.pci_status='VALID'
      AND p.vendor_contract_status='COMPLETE'
      AND p.privacy_program_status='APPROVED'
      AND p.information_security_program_status='APPROVED'
      AND p.funds_custody_allowed=0 AND p.platform_transfers_allowed=0
      AND p.marketplace_funds_routing_allowed=0 AND p.international_merchants_allowed=0
      AND p.international_customer_sales_allowed=0 AND p.subscriptions_allowed=0
      AND p.manual_payouts_allowed=0 AND p.raw_card_data_allowed=0
  ) OR
  EXISTS (
    SELECT 1 FROM compliance_obligations o
    WHERE o.obligation_type='REQUIRED'
      AND (o.status NOT IN ('SATISFIED','NOT_APPLICABLE')
           OR (o.next_review_due_at IS NOT NULL AND datetime(o.next_review_due_at)<=CURRENT_TIMESTAMP))
  ) OR
  EXISTS (
    SELECT 1 FROM service_provider_registry v
    WHERE (v.personal_data_access=1 OR v.financial_data_access=1)
      AND (v.contract_status<>'APPROVED' OR v.security_review_status<>'APPROVED'
           OR v.subprocessors_reviewed<>1
           OR (v.next_review_due_at IS NOT NULL AND datetime(v.next_review_due_at)<=CURRENT_TIMESTAMP))
  ) OR
  (SELECT COUNT(DISTINCT document_type) FROM legal_document_versions
    WHERE status='APPROVED' AND document_type IN (
      'PLATFORM_AGREEMENT','PRIVACY_NOTICE','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY',
      'FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT','SECURITY_SUMMARY','SUBPROCESSOR_LIST')) < 8
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires completed platform, state, and merchant legal/compliance clearance'); END;

CREATE TRIGGER merchants_active_requires_compliance_update
BEFORE UPDATE OF status,country_code,state_code,customer_market_scope,compliance_status,restricted_business_status,sanctions_review_status,legal_acceptance_complete_at ON merchants
WHEN NEW.status='ACTIVE' AND (
  NEW.country_code <> 'US' OR NEW.customer_market_scope <> 'US_ONLY' OR NEW.state_code IS NULL OR
  NEW.compliance_status <> 'READY' OR NEW.restricted_business_status <> 'CLEARED' OR
  NEW.sanctions_review_status <> 'CLEAR' OR NEW.legal_acceptance_complete_at IS NULL OR
  NOT EXISTS (
    SELECT 1 FROM state_jurisdiction_support s
    WHERE s.state_code=NEW.state_code
      AND s.merchant_onboarding_status='READY'
      AND s.money_transmission_review_status IN ('CLEARED_NON_LICENSED','LICENSE_ACTIVE')
      AND s.sales_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
      AND s.privacy_review_status='CLEARED'
      AND s.breach_review_status='CLEARED'
      AND s.entity_nexus_review_status IN ('CLEARED','REGISTERED')
      AND s.income_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
      AND s.electronic_transactions_review_status='CLEARED'
      AND (s.next_review_due_at IS NULL OR datetime(s.next_review_due_at)>CURRENT_TIMESTAMP)
  ) OR
  NOT EXISTS (
    SELECT 1 FROM platform_compliance_controls p
    WHERE p.id='GLOBAL'
      AND p.legal_entity_status='CONFIRMED'
      AND p.money_transmission_review_status='CONFIRMED_NON_MSB'
      AND p.ri_sales_tax_permit_status IN ('ACTIVE','NOT_APPLICABLE')
      AND p.platform_fee_tax_method_status IN ('IMPLEMENTED','NOT_APPLICABLE')
      AND p.pci_status='VALID'
      AND p.vendor_contract_status='COMPLETE'
      AND p.privacy_program_status='APPROVED'
      AND p.information_security_program_status='APPROVED'
      AND p.funds_custody_allowed=0 AND p.platform_transfers_allowed=0
      AND p.marketplace_funds_routing_allowed=0 AND p.international_merchants_allowed=0
      AND p.international_customer_sales_allowed=0 AND p.subscriptions_allowed=0
      AND p.manual_payouts_allowed=0 AND p.raw_card_data_allowed=0
  ) OR
  EXISTS (
    SELECT 1 FROM compliance_obligations o
    WHERE o.obligation_type='REQUIRED'
      AND (o.status NOT IN ('SATISFIED','NOT_APPLICABLE')
           OR (o.next_review_due_at IS NOT NULL AND datetime(o.next_review_due_at)<=CURRENT_TIMESTAMP))
  ) OR
  EXISTS (
    SELECT 1 FROM service_provider_registry v
    WHERE (v.personal_data_access=1 OR v.financial_data_access=1)
      AND (v.contract_status<>'APPROVED' OR v.security_review_status<>'APPROVED'
           OR v.subprocessors_reviewed<>1
           OR (v.next_review_due_at IS NOT NULL AND datetime(v.next_review_due_at)<=CURRENT_TIMESTAMP))
  ) OR
  (SELECT COUNT(DISTINCT document_type) FROM legal_document_versions
    WHERE status='APPROVED' AND document_type IN (
      'PLATFORM_AGREEMENT','PRIVACY_NOTICE','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY',
      'FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT','SECURITY_SUMMARY','SUBPROCESSOR_LIST')) < 8
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires completed platform, state, and merchant legal/compliance clearance'); END;

-- A state being suspended/expired immediately prevents new ACTIVE transitions; already-active
-- merchants are demoted by this trigger when their state pack is changed.
CREATE TRIGGER IF NOT EXISTS state_jurisdiction_demote_merchants
AFTER UPDATE OF merchant_onboarding_status,money_transmission_review_status,sales_tax_review_status,privacy_review_status,breach_review_status,entity_nexus_review_status,income_tax_review_status,electronic_transactions_review_status,next_review_due_at
ON state_jurisdiction_support
WHEN NEW.merchant_onboarding_status<>'READY'
  OR NEW.money_transmission_review_status NOT IN ('CLEARED_NON_LICENSED','LICENSE_ACTIVE')
  OR NEW.sales_tax_review_status NOT IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
  OR NEW.privacy_review_status<>'CLEARED'
  OR NEW.breach_review_status<>'CLEARED'
  OR NEW.entity_nexus_review_status NOT IN ('CLEARED','REGISTERED')
  OR NEW.income_tax_review_status NOT IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
  OR NEW.electronic_transactions_review_status<>'CLEARED'
  OR (NEW.next_review_due_at IS NOT NULL AND datetime(NEW.next_review_due_at)<=CURRENT_TIMESTAMP)
BEGIN
  UPDATE merchants
     SET status=CASE WHEN status='ACTIVE' THEN 'PAUSED' ELSE status END,
         compliance_status='BLOCKED',updated_at=CURRENT_TIMESTAMP
   WHERE state_code=NEW.state_code;
END;
