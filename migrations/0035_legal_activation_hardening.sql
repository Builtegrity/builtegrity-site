PRAGMA foreign_keys = ON;

-- Strengthen merchant activation so no runtime bug can accidentally make a merchant live
-- before BOTH platform-wide and merchant-specific legal controls are complete.
DROP TRIGGER IF EXISTS merchants_active_requires_compliance_insert;
DROP TRIGGER IF EXISTS merchants_active_requires_compliance_update;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_compliance_insert
BEFORE INSERT ON merchants WHEN NEW.status='ACTIVE' AND (
  NEW.country_code <> 'US' OR NEW.customer_market_scope <> 'US_ONLY' OR
  NEW.compliance_status <> 'READY' OR NEW.restricted_business_status <> 'CLEARED' OR
  NEW.sanctions_review_status <> 'CLEAR' OR NEW.legal_acceptance_complete_at IS NULL OR
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
      AND p.funds_custody_allowed=0
      AND p.platform_transfers_allowed=0
      AND p.marketplace_funds_routing_allowed=0
      AND p.international_merchants_allowed=0
      AND p.international_customer_sales_allowed=0
      AND p.subscriptions_allowed=0
      AND p.manual_payouts_allowed=0
      AND p.raw_card_data_allowed=0
  ) OR
  EXISTS (
    SELECT 1 FROM compliance_obligations o
    WHERE o.obligation_type='REQUIRED'
      AND (o.status NOT IN ('SATISFIED','NOT_APPLICABLE')
           OR (o.next_review_due_at IS NOT NULL AND datetime(o.next_review_due_at) <= CURRENT_TIMESTAMP))
  ) OR
  EXISTS (
    SELECT 1 FROM service_provider_registry v
    WHERE (v.personal_data_access=1 OR v.financial_data_access=1)
      AND (v.contract_status<>'APPROVED' OR v.security_review_status<>'APPROVED'
           OR v.subprocessors_reviewed<>1
           OR (v.next_review_due_at IS NOT NULL AND datetime(v.next_review_due_at) <= CURRENT_TIMESTAMP))
  ) OR
  (SELECT COUNT(DISTINCT document_type) FROM legal_document_versions
    WHERE status='APPROVED' AND document_type IN (
      'PLATFORM_AGREEMENT','PRIVACY_NOTICE','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY',
      'FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT','SECURITY_SUMMARY','SUBPROCESSOR_LIST'
    )) < 8
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires completed platform and merchant legal/compliance clearance'); END;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_compliance_update
BEFORE UPDATE OF status,country_code,customer_market_scope,compliance_status,restricted_business_status,sanctions_review_status,legal_acceptance_complete_at ON merchants
WHEN NEW.status='ACTIVE' AND (
  NEW.country_code <> 'US' OR NEW.customer_market_scope <> 'US_ONLY' OR
  NEW.compliance_status <> 'READY' OR NEW.restricted_business_status <> 'CLEARED' OR
  NEW.sanctions_review_status <> 'CLEAR' OR NEW.legal_acceptance_complete_at IS NULL OR
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
      AND p.funds_custody_allowed=0
      AND p.platform_transfers_allowed=0
      AND p.marketplace_funds_routing_allowed=0
      AND p.international_merchants_allowed=0
      AND p.international_customer_sales_allowed=0
      AND p.subscriptions_allowed=0
      AND p.manual_payouts_allowed=0
      AND p.raw_card_data_allowed=0
  ) OR
  EXISTS (
    SELECT 1 FROM compliance_obligations o
    WHERE o.obligation_type='REQUIRED'
      AND (o.status NOT IN ('SATISFIED','NOT_APPLICABLE')
           OR (o.next_review_due_at IS NOT NULL AND datetime(o.next_review_due_at) <= CURRENT_TIMESTAMP))
  ) OR
  EXISTS (
    SELECT 1 FROM service_provider_registry v
    WHERE (v.personal_data_access=1 OR v.financial_data_access=1)
      AND (v.contract_status<>'APPROVED' OR v.security_review_status<>'APPROVED'
           OR v.subprocessors_reviewed<>1
           OR (v.next_review_due_at IS NOT NULL AND datetime(v.next_review_due_at) <= CURRENT_TIMESTAMP))
  ) OR
  (SELECT COUNT(DISTINCT document_type) FROM legal_document_versions
    WHERE status='APPROVED' AND document_type IN (
      'PLATFORM_AGREEMENT','PRIVACY_NOTICE','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY',
      'FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT','SECURITY_SUMMARY','SUBPROCESSOR_LIST'
    )) < 8
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires completed platform and merchant legal/compliance clearance'); END;

-- Legal acceptance inserts automatically re-evaluate merchant-specific completion. This does not
-- activate a merchant; Stripe verification still owns the technical ACTIVE transition after all gates pass.
CREATE TRIGGER IF NOT EXISTS merchant_legal_acceptance_refresh_compliance
AFTER INSERT ON merchant_legal_acceptances
BEGIN
  UPDATE merchants
  SET compliance_status = CASE WHEN
        country_code='US'
        AND customer_market_scope='US_ONLY'
        AND restricted_business_status='CLEARED'
        AND sanctions_review_status='CLEAR'
        AND (
          SELECT COUNT(*) FROM (
            SELECT DISTINCT d.document_type
            FROM legal_document_versions d
            JOIN merchant_legal_acceptances a
              ON a.merchant_id=NEW.merchant_id
             AND a.document_type=d.document_type
             AND a.document_version=d.version
            WHERE d.status='APPROVED'
              AND d.document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT')
          )
        )=5
      THEN 'READY' ELSE 'INCOMPLETE' END,
      legal_acceptance_complete_at = CASE WHEN
        country_code='US'
        AND customer_market_scope='US_ONLY'
        AND restricted_business_status='CLEARED'
        AND sanctions_review_status='CLEAR'
        AND (
          SELECT COUNT(*) FROM (
            SELECT DISTINCT d.document_type
            FROM legal_document_versions d
            JOIN merchant_legal_acceptances a
              ON a.merchant_id=NEW.merchant_id
             AND a.document_type=d.document_type
             AND a.document_version=d.version
            WHERE d.status='APPROVED'
              AND d.document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT')
          )
        )=5
      THEN COALESCE(legal_acceptance_complete_at,CURRENT_TIMESTAMP) ELSE NULL END,
      updated_at=CURRENT_TIMESTAMP
  WHERE id=NEW.merchant_id;
END;

-- Adding/reclassifying a forbidden business or sanctions issue immediately demotes a merchant.
CREATE TRIGGER IF NOT EXISTS merchant_compliance_demote_on_risk_update
AFTER UPDATE OF restricted_business_status,sanctions_review_status,country_code,customer_market_scope ON merchants
WHEN NEW.restricted_business_status<>'CLEARED' OR NEW.sanctions_review_status<>'CLEAR'
  OR NEW.country_code<>'US' OR NEW.customer_market_scope<>'US_ONLY'
BEGIN
  UPDATE merchants
  SET status=CASE WHEN status='ACTIVE' THEN 'PAUSED' ELSE status END,
      compliance_status='BLOCKED',legal_acceptance_complete_at=NULL,updated_at=CURRENT_TIMESTAMP
  WHERE id=NEW.id;
END;

-- Additional state-level obligations that become relevant as a U.S. SaaS/payment-adjacent platform scales.
INSERT OR IGNORE INTO compliance_obligations(id,jurisdiction,category,obligation_type,title,requirement_summary,trigger_summary,source_name,source_url,status) VALUES
 ('COMP-US-BREACH-50','US-STATES','INCIDENT_RESPONSE','REQUIRED','All-state breach notification matrix','For every security incident involving personal information, determine each affected resident state and apply that state''s notice timing, regulator, content and credit-bureau rules before notices are sent.','Any confirmed breach involving U.S. residents outside Rhode Island.','National Conference of State Legislatures security breach laws','https://www.ncsl.org/technology-and-communication/security-breach-notification-laws','OPEN'),
 ('COMP-US-INCOME-NEXUS','US-STATES','TAX','RISK_CONTROL','State income/franchise tax nexus monitoring','Track revenue, payroll, property, employees and other state contacts that can create income/franchise tax filing obligations.','Business activity outside Rhode Island.','Multistate Tax Commission','https://www.mtc.gov/','OPEN'),
 ('COMP-US-FOREIGN-QUAL','US-STATES','ENTITY','RISK_CONTROL','Foreign qualification monitoring','Review whether employees, offices, repeated in-state activity or other contacts require Builtegrity to register as a foreign entity in another state.','Material business presence outside Rhode Island.','U.S. Small Business Administration','https://www.sba.gov/business-guide/launch-your-business/register-your-business','OPEN'),
 ('COMP-US-UNCLAIMED','US-STATES','PROPERTY','CONDITIONAL','Unclaimed property/escheat','If Builtegrity ever owes merchant, partner, employee or vendor property that remains unclaimed, track dormancy and report/remit under the holder state rules.','Uncashed/undeliverable balances or credits held by Builtegrity.','National Association of Unclaimed Property Administrators','https://unclaimed.org/','NOT_APPLICABLE'),
 ('COMP-FTC-ACT','US-FEDERAL','CONSUMER_PROTECTION','REQUIRED','Truthful product and protection claims','Do not describe Builtegrity as insurance, a bank, a payment processor, a guarantee of payout, or a guarantee of winning disputes; material fee and product limitations must be clear before purchase/use.','All public marketing, merchant onboarding and customer payment pages.','Federal Trade Commission Act Section 5','https://www.ftc.gov/legal-library/browse/statutes/federal-trade-commission-act','OPEN');
