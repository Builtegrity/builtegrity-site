PRAGMA foreign_keys = ON;

DROP VIEW IF EXISTS platform_legal_readiness;
DROP VIEW IF EXISTS merchant_legal_readiness;

CREATE VIEW platform_legal_readiness AS
WITH blockers AS (
  SELECT 'LEGAL_ENTITY_UNCONFIRMED' AS blocker
    FROM platform_compliance_controls WHERE id='GLOBAL' AND legal_entity_status<>'CONFIRMED'
  UNION ALL SELECT 'MONEY_TRANSMISSION_REVIEW_INCOMPLETE'
    FROM platform_compliance_controls WHERE id='GLOBAL' AND money_transmission_review_status<>'CONFIRMED_NON_MSB'
  UNION ALL SELECT 'RI_SALES_TAX_PERMIT_NOT_ACTIVE'
    FROM platform_compliance_controls WHERE id='GLOBAL' AND ri_sales_tax_permit_status NOT IN ('ACTIVE','NOT_APPLICABLE')
  UNION ALL SELECT 'PLATFORM_FEE_TAX_METHOD_UNRESOLVED'
    FROM platform_compliance_controls WHERE id='GLOBAL' AND platform_fee_tax_method_status NOT IN ('IMPLEMENTED','NOT_APPLICABLE')
  UNION ALL SELECT 'PCI_VALIDATION_INCOMPLETE'
    FROM platform_compliance_controls WHERE id='GLOBAL' AND pci_status<>'VALID'
  UNION ALL SELECT 'VENDOR_CONTRACT_REVIEW_INCOMPLETE'
    FROM platform_compliance_controls WHERE id='GLOBAL' AND vendor_contract_status<>'COMPLETE'
  UNION ALL SELECT 'PRIVACY_PROGRAM_NOT_APPROVED'
    FROM platform_compliance_controls WHERE id='GLOBAL' AND privacy_program_status<>'APPROVED'
  UNION ALL SELECT 'INFORMATION_SECURITY_PROGRAM_NOT_APPROVED'
    FROM platform_compliance_controls WHERE id='GLOBAL' AND information_security_program_status<>'APPROVED'
  UNION ALL SELECT 'RI_STATE_JURISDICTION_PACK_NOT_READY'
    WHERE NOT EXISTS (
      SELECT 1 FROM state_jurisdiction_support s
       WHERE s.state_code='RI'
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
  UNION ALL SELECT 'REQUIRED_OBLIGATION_OPEN:' || id
    FROM compliance_obligations
    WHERE obligation_type='REQUIRED' AND (
      status NOT IN ('SATISFIED','NOT_APPLICABLE') OR
      (next_review_due_at IS NOT NULL AND datetime(next_review_due_at)<=CURRENT_TIMESTAMP)
    )
  UNION ALL SELECT 'VENDOR_REVIEW_OPEN:' || id
    FROM service_provider_registry
    WHERE (personal_data_access=1 OR financial_data_access=1) AND (
      contract_status<>'APPROVED' OR security_review_status<>'APPROVED' OR subprocessors_reviewed<>1 OR
      (next_review_due_at IS NOT NULL AND datetime(next_review_due_at)<=CURRENT_TIMESTAMP)
    )
  UNION ALL SELECT 'REQUIRED_LEGAL_DOCUMENTS_NOT_APPROVED'
    WHERE (SELECT COUNT(DISTINCT document_type) FROM legal_document_versions
      WHERE status='APPROVED' AND document_type IN (
        'PLATFORM_AGREEMENT','PRIVACY_NOTICE','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY',
        'FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT','SECURITY_SUMMARY','SUBPROCESSOR_LIST')) < 8
)
SELECT CASE WHEN COUNT(*)=0 THEN 'READY' ELSE 'BLOCKED' END AS state,
       COUNT(*) AS blocker_count,
       GROUP_CONCAT(blocker,'|') AS blockers
FROM blockers;

CREATE VIEW merchant_legal_readiness AS
SELECT
  m.id AS merchant_id,
  m.status AS merchant_status,
  m.country_code,
  m.state_code,
  m.customer_market_scope,
  m.restricted_business_status,
  m.sanctions_review_status,
  m.compliance_status,
  m.legal_acceptance_complete_at,
  s.merchant_onboarding_status AS state_onboarding_status,
  s.money_transmission_review_status AS state_money_transmission_status,
  s.sales_tax_review_status AS state_sales_tax_status,
  s.privacy_review_status AS state_privacy_status,
  s.breach_review_status AS state_breach_status,
  s.entity_nexus_review_status AS state_entity_status,
  s.income_tax_review_status AS state_income_tax_status,
  s.electronic_transactions_review_status AS state_esign_status,
  s.next_review_due_at AS state_review_due_at,
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT d.document_type
       FROM legal_document_versions d
       JOIN merchant_legal_acceptances a
         ON a.merchant_id=m.id AND a.document_type=d.document_type AND a.document_version=d.version
      WHERE d.status='APPROVED'
        AND d.document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT')
   )) AS approved_document_acceptance_count,
  CASE WHEN m.country_code='US'
         AND m.state_code IS NOT NULL
         AND m.customer_market_scope='US_ONLY'
         AND m.restricted_business_status='CLEARED'
         AND m.sanctions_review_status='CLEAR'
         AND m.legal_acceptance_complete_at IS NOT NULL
         AND m.compliance_status='READY'
         AND s.merchant_onboarding_status='READY'
         AND s.money_transmission_review_status IN ('CLEARED_NON_LICENSED','LICENSE_ACTIVE')
         AND s.sales_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
         AND s.privacy_review_status='CLEARED'
         AND s.breach_review_status='CLEARED'
         AND s.entity_nexus_review_status IN ('CLEARED','REGISTERED')
         AND s.income_tax_review_status IN ('CLEARED','REGISTERED','NOT_APPLICABLE')
         AND s.electronic_transactions_review_status='CLEARED'
         AND (s.next_review_due_at IS NULL OR datetime(s.next_review_due_at)>CURRENT_TIMESTAMP)
         AND (SELECT COUNT(*) FROM (
           SELECT DISTINCT d.document_type
             FROM legal_document_versions d
             JOIN merchant_legal_acceptances a
               ON a.merchant_id=m.id AND a.document_type=d.document_type AND a.document_version=d.version
            WHERE d.status='APPROVED'
              AND d.document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT')
         ))=5
       THEN 'READY' ELSE 'BLOCKED' END AS legal_state
FROM merchants m
LEFT JOIN state_jurisdiction_support s ON s.state_code=m.state_code;
