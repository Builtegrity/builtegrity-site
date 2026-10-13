PRAGMA foreign_keys = ON;

-- Computed truth is preferred over a manually-maintained green checkbox.
CREATE VIEW IF NOT EXISTS platform_legal_readiness AS
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
SELECT
  CASE WHEN COUNT(*)=0 THEN 'READY' ELSE 'BLOCKED' END AS state,
  COUNT(*) AS blocker_count,
  GROUP_CONCAT(blocker,'|') AS blockers
FROM blockers;

CREATE VIEW IF NOT EXISTS merchant_legal_readiness AS
SELECT
  m.id AS merchant_id,
  m.status AS merchant_status,
  m.country_code,
  m.customer_market_scope,
  m.restricted_business_status,
  m.sanctions_review_status,
  m.compliance_status,
  m.legal_acceptance_complete_at,
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT d.document_type
       FROM legal_document_versions d
       JOIN merchant_legal_acceptances a
         ON a.merchant_id=m.id AND a.document_type=d.document_type AND a.document_version=d.version
      WHERE d.status='APPROVED'
        AND d.document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT')
   )) AS approved_document_acceptance_count,
  CASE WHEN m.country_code='US'
         AND m.customer_market_scope='US_ONLY'
         AND m.restricted_business_status='CLEARED'
         AND m.sanctions_review_status='CLEAR'
         AND m.legal_acceptance_complete_at IS NOT NULL
         AND m.compliance_status='READY'
         AND (SELECT COUNT(*) FROM (
           SELECT DISTINCT d.document_type
             FROM legal_document_versions d
             JOIN merchant_legal_acceptances a
               ON a.merchant_id=m.id AND a.document_type=d.document_type AND a.document_version=d.version
            WHERE d.status='APPROVED'
              AND d.document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT')
         ))=5
       THEN 'READY' ELSE 'BLOCKED' END AS legal_state
FROM merchants m;

INSERT OR IGNORE INTO compliance_obligations(id,jurisdiction,category,obligation_type,title,requirement_summary,trigger_summary,source_name,source_url,status) VALUES
 ('COMP-FIN-B0I-DOMESTIC','US-FEDERAL','ENTITY','CONDITIONAL','Corporate Transparency Act BOI reporting','Domestic U.S.-created entities are currently exempt from federal BOI reporting under FinCEN''s 2026 final rule; monitor rule changes rather than filing a report that is not required.','Rule changes or future foreign-formed reporting entity status.','FinCEN Beneficial Ownership Information','https://www.fincen.gov/boi','NOT_APPLICABLE'),
 ('COMP-FED-EIN','US-FEDERAL','ENTITY','REQUIRED','Employer Identification Number and tax identity','Maintain the correct EIN/tax identity for the actual legal entity and tax classification used by Builtegrity.','Formation or entity/classification change.','Internal Revenue Service EIN','https://www.irs.gov/businesses/small-businesses-self-employed/employer-id-numbers','OPEN'),
 ('COMP-FED-W9-1099','US-FEDERAL','VENDOR_TAX','CONDITIONAL','W-9 and information-return program','Collect current W-9 information from U.S. payees where required and issue/file applicable information returns when payment/type thresholds are met.','Partner/referral/vendor/contractor payments.','Internal Revenue Service information returns','https://www.irs.gov/businesses/small-businesses-self-employed/information-reporting-by-applicable-large-employers','OPEN'),
 ('COMP-FED-WORKER-CLASS','US-FEDERAL','EMPLOYMENT','CONDITIONAL','Worker classification','Classify employees versus independent contractors based on applicable federal/state tests; do not use a contract label to override actual facts.','Hiring any worker or contractor.','Internal Revenue Service worker classification','https://www.irs.gov/businesses/small-businesses-self-employed/independent-contractor-defined','NOT_APPLICABLE'),
 ('COMP-FED-I9-PAYROLL','US-FEDERAL','EMPLOYMENT','CONDITIONAL','Employment eligibility and payroll withholding','Complete Form I-9, obtain payroll withholding forms, deposit/report employment taxes and maintain payroll records when employees are hired.','First employee.','USCIS Form I-9 and IRS employment taxes','https://www.uscis.gov/i-9','NOT_APPLICABLE'),
 ('COMP-RI-EMPLOYMENT','US-RI','EMPLOYMENT','CONDITIONAL','Rhode Island employer registrations and workers compensation','Before/when employees are hired, complete applicable RI withholding/unemployment registrations, workers-compensation coverage and state labor-law obligations.','First Rhode Island employee, subject to statutory exemptions.','Rhode Island Department of Labor and Training','https://dlt.ri.gov/','NOT_APPLICABLE'),
 ('COMP-FED-RECORDS','US-FEDERAL','RECORD_RETENTION','RISK_CONTROL','Federal tax/accounting record retention','Keep records supporting income, deductions, credits and tax filings for the applicable limitations period; longer periods can apply to particular records.','All federal tax filings.','Internal Revenue Service recordkeeping','https://www.irs.gov/businesses/small-businesses-self-employed/how-long-should-i-keep-records','OPEN');
