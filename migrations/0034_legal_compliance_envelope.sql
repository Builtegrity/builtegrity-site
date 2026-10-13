PRAGMA foreign_keys = ON;

-- Builtegrity V1 intentionally has a narrow legal operating envelope. Expanding any
-- of these boundaries requires a new legal/compliance review and a versioned migration.
CREATE TABLE IF NOT EXISTS platform_compliance_controls (
  id TEXT PRIMARY KEY CHECK (id = 'GLOBAL'),
  launch_country TEXT NOT NULL DEFAULT 'US' CHECK (launch_country = 'US'),
  launch_currency TEXT NOT NULL DEFAULT 'USD' CHECK (launch_currency = 'USD'),
  payment_architecture TEXT NOT NULL DEFAULT 'STRIPE_DIRECT_CHARGE'
    CHECK (payment_architecture = 'STRIPE_DIRECT_CHARGE'),
  funds_custody_allowed INTEGER NOT NULL DEFAULT 0 CHECK (funds_custody_allowed = 0),
  platform_transfers_allowed INTEGER NOT NULL DEFAULT 0 CHECK (platform_transfers_allowed = 0),
  marketplace_funds_routing_allowed INTEGER NOT NULL DEFAULT 0 CHECK (marketplace_funds_routing_allowed = 0),
  international_merchants_allowed INTEGER NOT NULL DEFAULT 0 CHECK (international_merchants_allowed = 0),
  international_customer_sales_allowed INTEGER NOT NULL DEFAULT 0 CHECK (international_customer_sales_allowed = 0),
  subscriptions_allowed INTEGER NOT NULL DEFAULT 0 CHECK (subscriptions_allowed = 0),
  manual_payouts_allowed INTEGER NOT NULL DEFAULT 0 CHECK (manual_payouts_allowed = 0),
  raw_card_data_allowed INTEGER NOT NULL DEFAULT 0 CHECK (raw_card_data_allowed = 0),
  prohibited_sensitive_data_allowed INTEGER NOT NULL DEFAULT 0 CHECK (prohibited_sensitive_data_allowed = 0),
  automated_marketing_sms_allowed INTEGER NOT NULL DEFAULT 0 CHECK (automated_marketing_sms_allowed = 0),
  automated_marketing_robocalls_allowed INTEGER NOT NULL DEFAULT 0 CHECK (automated_marketing_robocalls_allowed = 0),
  legal_entity_status TEXT NOT NULL DEFAULT 'UNCONFIRMED'
    CHECK (legal_entity_status IN ('UNCONFIRMED','CONFIRMED')),
  money_transmission_review_status TEXT NOT NULL DEFAULT 'PENDING_COUNSEL'
    CHECK (money_transmission_review_status IN ('PENDING_COUNSEL','CONFIRMED_NON_MSB','LICENSE_REQUIRED','REVIEW_EXPIRED')),
  ri_sales_tax_permit_status TEXT NOT NULL DEFAULT 'REQUIRED_BEFORE_LIVE'
    CHECK (ri_sales_tax_permit_status IN ('REQUIRED_BEFORE_LIVE','ACTIVE','NOT_APPLICABLE','EXPIRED')),
  platform_fee_tax_method_status TEXT NOT NULL DEFAULT 'UNRESOLVED'
    CHECK (platform_fee_tax_method_status IN ('UNRESOLVED','IMPLEMENTED','NOT_APPLICABLE')),
  pci_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (pci_status IN ('PENDING','VALID','EXPIRED','FAILED')),
  vendor_contract_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (vendor_contract_status IN ('PENDING','COMPLETE','NEEDS_REVIEW')),
  privacy_program_status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (privacy_program_status IN ('DRAFT','APPROVED','NEEDS_REVIEW')),
  information_security_program_status TEXT NOT NULL DEFAULT 'IMPLEMENTED_DRAFT'
    CHECK (information_security_program_status IN ('IMPLEMENTED_DRAFT','APPROVED','NEEDS_REVIEW')),
  legal_launch_state TEXT NOT NULL DEFAULT 'BLOCKED'
    CHECK (legal_launch_state IN ('BLOCKED','READY')),
  last_legal_review_at TEXT,
  next_legal_review_due_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO platform_compliance_controls(id) VALUES('GLOBAL');

-- Legal documents are versioned evidence. Only APPROVED versions may be accepted by a merchant.
CREATE TABLE IF NOT EXISTS legal_document_versions (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'PLATFORM_AGREEMENT','PRIVACY_NOTICE','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY',
    'FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT','SECURITY_SUMMARY','SUBPROCESSOR_LIST'
  )),
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COUNSEL_REVIEW','APPROVED','RETIRED')),
  public_path TEXT,
  content_sha256 TEXT,
  effective_at TEXT,
  counsel_reviewed_at TEXT,
  counsel_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_type, version)
);

INSERT OR IGNORE INTO legal_document_versions(id,document_type,version,status,public_path) VALUES
 ('LEGAL-PLATFORM-001','PLATFORM_AGREEMENT','2026-10-draft','DRAFT','/terms/'),
 ('LEGAL-PRIVACY-001','PRIVACY_NOTICE','2026-10-draft','DRAFT','/privacy/'),
 ('LEGAL-DPA-001','DATA_PROCESSING_ADDENDUM','2026-10-draft','DRAFT','/legal/dpa/'),
 ('LEGAL-AUP-001','ACCEPTABLE_USE_POLICY','2026-10-draft','DRAFT','/legal/acceptable-use/'),
 ('LEGAL-FEE-001','FEE_SCHEDULE','2026-10-draft','DRAFT','/legal/fees/'),
 ('LEGAL-ESIGN-001','ELECTRONIC_RECORDS_CONSENT','2026-10-draft','DRAFT','/legal/electronic-records/'),
 ('LEGAL-SEC-001','SECURITY_SUMMARY','2026-10-draft','DRAFT','/legal/security/'),
 ('LEGAL-SUBPROCESSOR-001','SUBPROCESSOR_LIST','2026-10-draft','DRAFT','/legal/subprocessors/');

ALTER TABLE merchants ADD COLUMN country_code TEXT NOT NULL DEFAULT 'US' CHECK (country_code = 'US');
ALTER TABLE merchants ADD COLUMN state_code TEXT;
ALTER TABLE merchants ADD COLUMN customer_market_scope TEXT NOT NULL DEFAULT 'US_ONLY' CHECK (customer_market_scope = 'US_ONLY');
ALTER TABLE merchants ADD COLUMN compliance_status TEXT NOT NULL DEFAULT 'INCOMPLETE'
  CHECK (compliance_status IN ('INCOMPLETE','READY','BLOCKED','NEEDS_REVIEW'));
ALTER TABLE merchants ADD COLUMN restricted_business_status TEXT NOT NULL DEFAULT 'UNREVIEWED'
  CHECK (restricted_business_status IN ('UNREVIEWED','ATTESTED','CLEARED','RESTRICTED','PROHIBITED'));
ALTER TABLE merchants ADD COLUMN sanctions_review_status TEXT NOT NULL DEFAULT 'UNREVIEWED'
  CHECK (sanctions_review_status IN ('UNREVIEWED','CLEAR','POTENTIAL_MATCH','BLOCKED'));
ALTER TABLE merchants ADD COLUMN sanctions_reviewed_at TEXT;
ALTER TABLE merchants ADD COLUMN legal_acceptance_complete_at TEXT;

ALTER TABLE customers ADD COLUMN country_code TEXT NOT NULL DEFAULT 'US' CHECK (country_code = 'US');
ALTER TABLE customers ADD COLUMN privacy_deletion_requested_at TEXT;
ALTER TABLE customers ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1));

-- Immutable clickwrap/e-sign evidence. Do not store raw IP addresses or raw user agents.
CREATE TABLE IF NOT EXISTS merchant_legal_acceptances (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  document_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acceptance_method TEXT NOT NULL DEFAULT 'CLICKWRAP'
    CHECK (acceptance_method IN ('CLICKWRAP','ELECTRONIC_SIGNATURE')),
  network_evidence_hash TEXT,
  user_agent_hash TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE(merchant_id, external_user_id, document_type, document_version)
);
CREATE INDEX IF NOT EXISTS idx_merchant_legal_acceptances_merchant ON merchant_legal_acceptances(merchant_id,accepted_at);
CREATE TRIGGER IF NOT EXISTS merchant_legal_acceptances_no_update
BEFORE UPDATE ON merchant_legal_acceptances BEGIN
  SELECT RAISE(ABORT,'merchant legal acceptance evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS merchant_legal_acceptances_no_delete
BEFORE DELETE ON merchant_legal_acceptances BEGIN
  SELECT RAISE(ABORT,'merchant legal acceptance evidence is immutable');
END;

-- Authoritative obligation register. The machine can block launch on any REQUIRED item that
-- is not SATISFIED/NOT_APPLICABLE or that has expired.
CREATE TABLE IF NOT EXISTS compliance_obligations (
  id TEXT PRIMARY KEY,
  jurisdiction TEXT NOT NULL,
  category TEXT NOT NULL,
  obligation_type TEXT NOT NULL CHECK (obligation_type IN ('REQUIRED','CONDITIONAL','RISK_CONTROL')),
  title TEXT NOT NULL,
  requirement_summary TEXT NOT NULL,
  trigger_summary TEXT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SATISFIED','NOT_APPLICABLE','COUNSEL_REVIEW','BLOCKED')),
  evidence_ref TEXT,
  verified_at TEXT,
  next_review_due_at TEXT,
  owner_role TEXT NOT NULL DEFAULT 'COMPLIANCE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_compliance_obligations_status ON compliance_obligations(obligation_type,status,next_review_due_at);

INSERT OR IGNORE INTO compliance_obligations(id,jurisdiction,category,obligation_type,title,requirement_summary,trigger_summary,source_name,source_url,status) VALUES
 ('COMP-FED-MSB','US-FEDERAL','PAYMENTS','REQUIRED','Money-transmission classification','Maintain a payments architecture in which Builtegrity does not accept or transmit customer funds; obtain counsel confirmation before live funds move.','Any change to funds custody, transfers, marketplace routing, stored value, escrow, or payout control reopens review.','FinCEN money transmitter guidance','https://www.fincen.gov/resources/statutes-regulations/administrative-rulings/determination-money-services-business-status','COUNSEL_REVIEW'),
 ('COMP-STRIPE-PLATFORM','US','PAYMENTS','REQUIRED','Stripe Platform Provider Agreement','Connected merchants must receive a clear platform agreement covering Builtegrity activity, data access, platform fees and responsibilities.','Any Stripe Connect merchant.','Stripe Connected Account Agreement','https://stripe.com/legal/connect-account','OPEN'),
 ('COMP-STRIPE-RESTRICTED','US','MERCHANT_RISK','REQUIRED','Restricted and prohibited business screening','Do not enable prohibited businesses and require review/approval for restricted categories.','Before merchant activation and periodically thereafter.','Stripe Restricted Businesses','https://stripe.com/legal/restricted-businesses','OPEN'),
 ('COMP-PCI','US','SECURITY','REQUIRED','PCI DSS outsourced-checkout compliance','Keep cardholder data entirely in Stripe-hosted Checkout, maintain applicable SAQ A controls and required ASV scanning.','Before live card acceptance and recurring validation thereafter.','PCI Security Standards Council','https://www.pcisecuritystandards.org/','OPEN'),
 ('COMP-OFAC','US-FEDERAL','SANCTIONS','REQUIRED','OFAC sanctions compliance','Do not knowingly provide services to blocked persons or prohibited transactions; screen merchants and investigate potential matches.','Before activation and on material account changes/list refreshes.','U.S. Treasury OFAC','https://ofac.treasury.gov/sanctions-list-search-tool','OPEN'),
 ('COMP-ESIGN','US-FEDERAL','ELECTRONIC_RECORDS','REQUIRED','Electronic record and signature integrity','Capture affirmative agreement and preserve final electronic records so they remain accessible and reproducible; use enhanced E-SIGN consent where a law requires consumer disclosures in writing.','Electronic contracts, disclosures and transaction terms.','15 U.S.C. 7001','https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section7001','OPEN'),
 ('COMP-FTC-SECURITY','US-FEDERAL','SECURITY','REQUIRED','Reasonable data security','Minimize collection, restrict access, secure data throughout its lifecycle, govern service providers and maintain incident response.','Whenever Builtegrity stores personal information.','Federal Trade Commission Start with Security','https://www.ftc.gov/business-guidance/resources/start-security-guide-business','OPEN'),
 ('COMP-CANSPAM','US-FEDERAL','COMMUNICATIONS','CONDITIONAL','CAN-SPAM commercial email','Commercial email must use accurate headers/subjects, required disclosures/address, unsubscribe and timely suppression.','If Builtegrity sends commercial marketing email.','Federal Trade Commission CAN-SPAM guide','https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business','OPEN'),
 ('COMP-TCPA','US-FEDERAL','COMMUNICATIONS','CONDITIONAL','TCPA marketing calls/texts','Do not send covered automated marketing calls or texts without legally sufficient prior express written consent and revocation controls.','If automated/prerecorded telemarketing or robotexts are enabled.','Federal Communications Commission TCPA','https://www.fcc.gov/','NOT_APPLICABLE'),
 ('COMP-COPPA','US-FEDERAL','PRIVACY','CONDITIONAL','COPPA child data','Do not knowingly collect personal information directly from children under 13 without a compliant parental-consent program.','If service becomes child-directed or Builtegrity gains actual knowledge of under-13 collection.','Federal Trade Commission COPPA','https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions','NOT_APPLICABLE'),
 ('COMP-RI-INFOSEC','US-RI','SECURITY','REQUIRED','Rhode Island risk-based information security program','Maintain written risk-based administrative, technical and physical security practices, written retention rules, secure disposal, and security terms with third parties.','Handling personal information about any Rhode Island resident.','R.I. Gen. Laws 11-49.3-2','https://webserver.rilegislature.gov/Statutes/TITLE11/11-49.3/11-49.3-2.HTM','OPEN'),
 ('COMP-RI-BREACH','US-RI','INCIDENT_RESPONSE','REQUIRED','Rhode Island breach notification process','Maintain incident workflow capable of RI resident notice within the statutory deadline and AG/credit bureau notice when thresholds are met.','Qualifying breach involving Rhode Island resident personal information.','R.I. Gen. Laws 11-49.3-4','https://webserver.rilegislature.gov/Statutes/TITLE11/11-49.3/11-49.3-4.HTM','OPEN'),
 ('COMP-RI-PRIVACY','US-RI','PRIVACY','REQUIRED','Rhode Island online privacy notice and scalable consumer-rights program','Publish required data practices; maintain a controller/processor framework and consumer-rights capability before statutory thresholds are crossed.','RI business/website now; additional rights/processor duties when statutory thresholds apply.','R.I. Gen. Laws 6-48.1','https://webserver.rilegislature.gov/Statutes/TITLE6/6-48.1/INDEX.htm','OPEN'),
 ('COMP-RI-SALESTAX','US-RI','TAX','REQUIRED','Rhode Island sales tax permit and taxable platform-fee treatment','Register before taxable retail sales and implement separately accounted sales tax on taxable Builtegrity platform fees before live RI merchant billing.','Builtegrity is RI-based and provides vendor-hosted software/platform access for a fee.','Rhode Island Division of Taxation','https://tax.ri.gov/tax-sections/sales-excise-taxes/sales-use-tax','OPEN'),
 ('COMP-RI-ANNUAL','US-RI','ENTITY','REQUIRED','Rhode Island entity good standing','Maintain registered agent/office, annual report and applicable annual business tax return/fee.','If Builtegrity operates through a RI registered entity.','Rhode Island Department of State','https://www.sos.ri.gov/divisions/business-services/ri-business/maintain-your-business','OPEN'),
 ('COMP-US-SALESTAX-NEXUS','US-STATES','TAX','REQUIRED','State sales-tax nexus monitoring','Continuously monitor physical/economic nexus and SaaS/platform-fee taxability; register before collecting in a jurisdiction.','Sales or physical presence in U.S. states.','Streamlined Sales Tax remote seller guidance','https://www.streamlinedsalestax.org/for-businesses/remote-seller-faqs/remote-seller-state-guidance','OPEN'),
 ('COMP-US-PRIVACY','US-STATES','PRIVACY','RISK_CONTROL','National high-water-mark privacy baseline','Provide access/correction/deletion/portability intake, no-sale/no-targeted-ad policy, data minimization, processor contracts and opt-out signal handling so state expansion does not require redesign.','U.S. customer data; specific state thresholds vary.','NCSL consumer privacy database','https://www.ncsl.org/technology-and-communication/consumer-privacy-legislation-database','OPEN'),
 ('COMP-ADA-WEB','US-FEDERAL','ACCESSIBILITY','RISK_CONTROL','Accessible public web/payment experience','Build public and checkout surfaces to WCAG 2.2 AA as the engineering baseline for equal access.','Public-facing web/payment interfaces.','U.S. Department of Justice ADA web guidance','https://www.ada.gov/resources/web-guidance/','OPEN');

-- Service providers that can receive Builtegrity data must be contractually/security reviewed.
CREATE TABLE IF NOT EXISTS service_provider_registry (
  id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  personal_data_access INTEGER NOT NULL DEFAULT 0 CHECK (personal_data_access IN (0,1)),
  financial_data_access INTEGER NOT NULL DEFAULT 0 CHECK (financial_data_access IN (0,1)),
  contract_status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED' CHECK (contract_status IN ('REVIEW_REQUIRED','APPROVED','BLOCKED')),
  security_review_status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED' CHECK (security_review_status IN ('REVIEW_REQUIRED','APPROVED','BLOCKED')),
  subprocessors_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (subprocessors_reviewed IN (0,1)),
  data_location_notes TEXT,
  agreement_url TEXT,
  last_reviewed_at TEXT,
  next_review_due_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO service_provider_registry(id,provider_name,purpose,personal_data_access,financial_data_access,agreement_url) VALUES
 ('VENDOR-STRIPE','Stripe','Payment processing and connected-account infrastructure',1,1,'https://stripe.com/legal'),
 ('VENDOR-CLOUDFLARE','Cloudflare','Application hosting, D1, R2, edge security',1,1,'https://www.cloudflare.com/terms/'),
 ('VENDOR-CLERK','Clerk','Identity and authentication',1,0,'https://clerk.com/legal'),
 ('VENDOR-RESEND','Resend','Transactional email delivery',1,0,'https://resend.com/legal'),
 ('VENDOR-INTUIT','Intuit QuickBooks Online','Company accounting books integration',1,1,'https://www.intuit.com/legal/'),
 ('VENDOR-GITHUB','GitHub','Source control and CI/CD',0,0,'https://docs.github.com/site-policy');

-- Written retention schedule. Legal hold always overrides automated deletion.
CREATE TABLE IF NOT EXISTS data_retention_policies (
  id TEXT PRIMARY KEY,
  data_category TEXT NOT NULL UNIQUE,
  retention_months INTEGER CHECK (retention_months IS NULL OR retention_months > 0),
  trigger_event TEXT NOT NULL,
  rationale TEXT NOT NULL,
  automation_status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (automation_status IN ('PLANNED','ENFORCED','MANUAL_REVIEW')),
  counsel_review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (counsel_review_status IN ('PENDING','APPROVED','NEEDS_REVIEW')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO data_retention_policies(id,data_category,retention_months,trigger_event,rationale,automation_status) VALUES
 ('RET-TX','TRANSACTION_RECORDS',84,'TRANSACTION_COMPLETE','Contract, dispute, accounting, audit and legal-defense record; subject to counsel confirmation.','MANUAL_REVIEW'),
 ('RET-ACCOUNTING','ACCOUNTING_TAX_RECORDS',84,'PERIOD_CLOSE','Tax/accounting substantiation; state-specific minimums may require less or more.','MANUAL_REVIEW'),
 ('RET-SECURITY','SECURITY_AUDIT_LOGS',24,'LOG_CREATED','Security investigation and accountability balanced against minimization.','MANUAL_REVIEW'),
 ('RET-MARKETING','MARKETING_CONSENT_AND_SUPPRESSION',60,'CONSENT_OR_OPTOUT','Proof of consent/opt-out and suppression history.','MANUAL_REVIEW'),
 ('RET-FAILED-SIGNUP','FAILED_OR_ABANDONED_SIGNUP',3,'LAST_ACTIVITY','Minimize personal data that never becomes an active merchant relationship.','PLANNED');

CREATE TABLE IF NOT EXISTS privacy_requests (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('MERCHANT_USER','CUSTOMER','OTHER')),
  subject_ref TEXT,
  request_type TEXT NOT NULL CHECK (request_type IN ('ACCESS','CORRECT','DELETE','PORTABILITY','OPT_OUT','APPEAL','OTHER')),
  jurisdiction_code TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','VERIFYING','IN_PROGRESS','COMPLETED','DENIED','WITHDRAWN')),
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  internal_target_at TEXT NOT NULL,
  legal_deadline_at TEXT,
  identity_verified_at TEXT,
  completed_at TEXT,
  denial_reason TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_due ON privacy_requests(status,internal_target_at,legal_deadline_at);

CREATE TABLE IF NOT EXISTS security_incidents (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONTAINED','INVESTIGATING','NOTIFICATION_REVIEW','CLOSED')),
  discovered_at TEXT NOT NULL,
  confirmed_breach_at TEXT,
  description TEXT NOT NULL,
  personal_information_involved INTEGER NOT NULL DEFAULT 0 CHECK (personal_information_involved IN (0,1)),
  affected_ri_residents INTEGER NOT NULL DEFAULT 0 CHECK (affected_ri_residents >= 0),
  ri_notice_deadline_at TEXT,
  ri_ag_notice_required INTEGER NOT NULL DEFAULT 0 CHECK (ri_ag_notice_required IN (0,1)),
  ri_credit_bureau_notice_required INTEGER NOT NULL DEFAULT 0 CHECK (ri_credit_bureau_notice_required IN (0,1)),
  legal_review_required INTEGER NOT NULL DEFAULT 1 CHECK (legal_review_required = 1),
  containment_notes TEXT,
  notification_evidence_json TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_security_incidents_open ON security_incidents(status,severity,ri_notice_deadline_at);

-- US-only / USD-only V1 invariants at the database boundary.
CREATE TRIGGER IF NOT EXISTS purchases_v1_usd_insert
BEFORE INSERT ON purchases WHEN upper(NEW.currency) <> 'USD'
BEGIN SELECT RAISE(ABORT,'Builtegrity V1 supports USD purchases only'); END;
CREATE TRIGGER IF NOT EXISTS purchases_v1_usd_update
BEFORE UPDATE OF currency ON purchases WHEN upper(NEW.currency) <> 'USD'
BEGIN SELECT RAISE(ABORT,'Builtegrity V1 supports USD purchases only'); END;
CREATE TRIGGER IF NOT EXISTS transactions_v1_usd_insert
BEFORE INSERT ON transactions WHEN upper(NEW.currency) <> 'USD'
BEGIN SELECT RAISE(ABORT,'Builtegrity V1 supports USD transactions only'); END;
CREATE TRIGGER IF NOT EXISTS transactions_v1_usd_update
BEFORE UPDATE OF currency ON transactions WHEN upper(NEW.currency) <> 'USD'
BEGIN SELECT RAISE(ABORT,'Builtegrity V1 supports USD transactions only'); END;

-- A merchant can never be ACTIVE merely because Stripe works. Legal/compliance gates are independent.
CREATE TRIGGER IF NOT EXISTS merchants_active_requires_compliance_insert
BEFORE INSERT ON merchants WHEN NEW.status='ACTIVE' AND (
  NEW.country_code <> 'US' OR NEW.customer_market_scope <> 'US_ONLY' OR
  NEW.compliance_status <> 'READY' OR NEW.restricted_business_status <> 'CLEARED' OR
  NEW.sanctions_review_status <> 'CLEAR' OR NEW.legal_acceptance_complete_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires completed V1 legal/compliance clearance'); END;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_compliance_update
BEFORE UPDATE OF status,country_code,customer_market_scope,compliance_status,restricted_business_status,sanctions_review_status,legal_acceptance_complete_at ON merchants
WHEN NEW.status='ACTIVE' AND (
  NEW.country_code <> 'US' OR NEW.customer_market_scope <> 'US_ONLY' OR
  NEW.compliance_status <> 'READY' OR NEW.restricted_business_status <> 'CLEARED' OR
  NEW.sanctions_review_status <> 'CLEAR' OR NEW.legal_acceptance_complete_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires completed V1 legal/compliance clearance'); END;

-- Existing test merchants stay non-live until legal review is complete.
UPDATE merchants SET status='TEST', compliance_status='INCOMPLETE'
WHERE status='ACTIVE';
