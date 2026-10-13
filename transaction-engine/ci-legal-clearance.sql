-- TEST FIXTURE ONLY. Never execute against production.
-- This makes MER-0001 legally/compliance-ready so older CI suites can isolate
-- tax/financial invariants that specifically require an ACTIVE merchant.

UPDATE platform_compliance_controls
SET legal_entity_status='CONFIRMED',
    money_transmission_review_status='CONFIRMED_NON_MSB',
    ri_sales_tax_permit_status='ACTIVE',
    platform_fee_tax_method_status='IMPLEMENTED',
    pci_status='VALID',
    vendor_contract_status='COMPLETE',
    privacy_program_status='APPROVED',
    information_security_program_status='APPROVED',
    legal_launch_state='READY',
    last_legal_review_at=CURRENT_TIMESTAMP,
    next_legal_review_due_at=datetime('now','+1 year')
WHERE id='GLOBAL';

UPDATE compliance_obligations
SET status=CASE WHEN obligation_type='CONDITIONAL' AND status='NOT_APPLICABLE' THEN 'NOT_APPLICABLE' ELSE 'SATISFIED' END,
    evidence_ref='CI_TEST_FIXTURE',
    verified_at=CURRENT_TIMESTAMP,
    next_review_due_at=datetime('now','+1 year'),
    updated_at=CURRENT_TIMESTAMP;

UPDATE service_provider_registry
SET contract_status='APPROVED',
    security_review_status='APPROVED',
    subprocessors_reviewed=1,
    last_reviewed_at=CURRENT_TIMESTAMP,
    next_review_due_at=datetime('now','+1 year');

UPDATE legal_document_versions
SET status='APPROVED',
    effective_at=COALESCE(effective_at,CURRENT_TIMESTAMP),
    counsel_reviewed_at=COALESCE(counsel_reviewed_at,CURRENT_TIMESTAMP),
    counsel_reference=COALESCE(counsel_reference,'CI_TEST_FIXTURE');

UPDATE merchants
SET country_code='US',
    customer_market_scope='US_ONLY',
    restricted_business_status='CLEARED',
    sanctions_review_status='CLEAR',
    sanctions_reviewed_at=CURRENT_TIMESTAMP,
    compliance_status='INCOMPLETE'
WHERE id='MER-0001';

INSERT OR IGNORE INTO merchant_legal_acceptances
  (id,merchant_id,external_user_id,document_type,document_version,acceptance_method,evidence_json)
SELECT 'MLA-CI-' || document_type,
       'MER-0001','ci_legal_fixture',document_type,version,'CLICKWRAP','{"ci_fixture":true}'
FROM legal_document_versions
WHERE status='APPROVED'
  AND document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT');

-- Readiness assertions belong in the calling CI workflow rather than using SQLite RAISE()
-- outside a trigger. Production migrations never execute this fixture.
