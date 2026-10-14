-- TEST FIXTURE ONLY. Never execute against production.
-- This makes MER-0001 legally/compliance-ready so CI suites can isolate
-- transaction/tax/financial invariants that specifically require an ACTIVE merchant.

UPDATE platform_compliance_controls
SET legal_entity_status='CONFIRMED',
    money_transmission_review_status='CONFIRMED_NON_MSB',
    money_transmission_review_reference='CI_TEST_FIXTURE',
    ri_sales_tax_permit_status='ACTIVE',
    ri_sales_tax_permit_reference='CI_TEST_FIXTURE',
    platform_fee_tax_method_status='IMPLEMENTED',
    platform_fee_tax_method_reference='CI_TEST_FIXTURE',
    pci_status='VALID',
    pci_validation_reference='CI_TEST_FIXTURE',
    pci_validation_type='SAQ_A',
    pci_attested_at=CURRENT_TIMESTAMP,
    pci_expires_at=datetime('now','+1 year'),
    pci_asv_required=0,
    pci_asv_status='NOT_APPLICABLE',
    vendor_contract_status='COMPLETE',
    privacy_program_status='APPROVED',
    privacy_program_reference='CI_TEST_FIXTURE',
    information_security_program_status='APPROVED',
    information_security_program_reference='CI_TEST_FIXTURE',
    platform_fee_refund_policy_status='APPROVED',
    platform_fee_refund_policy_reference='CI_TEST_FIXTURE',
    platform_fee_refund_policy_reviewed_at=CURRENT_TIMESTAMP,
    platform_fee_refund_policy_next_review_due_at=datetime('now','+1 year'),
    legal_launch_state='READY',
    last_legal_review_at=CURRENT_TIMESTAMP,
    next_legal_review_due_at=datetime('now','+1 year')
WHERE id='GLOBAL';

UPDATE fee_refund_policy_versions
SET status='APPROVED',
    effective_at=COALESCE(effective_at,CURRENT_TIMESTAMP),
    counsel_reviewed_at=COALESCE(counsel_reviewed_at,CURRENT_TIMESTAMP),
    counsel_reference=COALESCE(counsel_reference,'CI_TEST_FIXTURE'),
    next_review_due_at=COALESCE(next_review_due_at,datetime('now','+1 year'))
WHERE id='FEE-REFUND-POLICY-V1';

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
    counsel_reference=COALESCE(counsel_reference,'CI_TEST_FIXTURE')
WHERE status<>'RETIRED';

UPDATE state_jurisdiction_support
SET merchant_onboarding_status='READY',
    customer_transaction_status='READY',
    money_transmission_review_status='CLEARED_NON_LICENSED',
    sales_tax_review_status='REGISTERED',
    privacy_review_status='CLEARED',
    breach_review_status='CLEARED',
    entity_nexus_review_status='CLEARED',
    income_tax_review_status='CLEARED',
    electronic_transactions_review_status='CLEARED',
    consumer_protection_review_status='CLEARED',
    platform_fee_refund_review_status='READY',
    platform_fee_refund_handler_code='RETAIN_IF_EARNED',
    platform_fee_refund_reference='CI_TEST_FIXTURE',
    platform_fee_refund_reviewed_at=CURRENT_TIMESTAMP,
    platform_fee_refund_next_review_due_at=datetime('now','+1 year'),
    counsel_reference='CI_TEST_FIXTURE',
    tax_reference='CI_TEST_FIXTURE',
    reviewed_at=CURRENT_TIMESTAMP,
    next_review_due_at=datetime('now','+1 year'),
    updated_at=CURRENT_TIMESTAMP
WHERE state_code='RI';

UPDATE merchants
SET country_code='US',
    state_code='RI',
    customer_market_scope='US_ONLY',
    restricted_business_status='CLEARED',
    restricted_business_reviewed_at=CURRENT_TIMESTAMP,
    restricted_business_evidence_ref='CI_TEST_FIXTURE',
    sanctions_review_status='CLEAR',
    sanctions_reviewed_at=CURRENT_TIMESTAMP,
    sanctions_evidence_ref='CI_TEST_FIXTURE',
    sanctions_next_review_due_at=datetime('now','+90 days'),
    compliance_status='INCOMPLETE'
WHERE id='MER-0001';

INSERT OR IGNORE INTO merchant_legal_acceptances
  (id,merchant_id,external_user_id,document_type,document_version,acceptance_method,evidence_json)
SELECT 'MLA-CI-' || document_type,
       'MER-0001','ci_legal_fixture',document_type,version,'CLICKWRAP','{"ci_fixture":true}'
FROM legal_document_versions
WHERE status='APPROVED'
  AND document_type IN ('PLATFORM_AGREEMENT','DATA_PROCESSING_ADDENDUM','ACCEPTABLE_USE_POLICY','FEE_SCHEDULE','ELECTRONIC_RECORDS_CONSENT');

INSERT OR IGNORE INTO merchant_fee_policy_acceptances
  (id,merchant_id,external_user_id,fee_schedule_version,fee_refund_policy_version,
   acknowledgment_version,acknowledgment_text,acknowledgment_sha256,evidence_json)
SELECT 'MFPA-CI-MER-0001','MER-0001','ci_legal_fixture',d.version,p.version,
       'BG-FEE-REFUND-ACK-V1','CI fixture acknowledgment','CI_TEST_FIXTURE_SHA','{"ci_fixture":true}'
FROM legal_document_versions d, fee_refund_policy_versions p
WHERE d.document_type='FEE_SCHEDULE' AND d.status='APPROVED'
  AND p.id='FEE-REFUND-POLICY-V1' AND p.status='APPROVED'
ORDER BY datetime(d.effective_at) DESC
LIMIT 1;

UPDATE transactions
SET customer_attested_country_code='US',
    customer_attested_state_code='RI',
    customer_attested_at=COALESCE(customer_attested_at,CURRENT_TIMESTAMP),
    checkout_legal_gate_at=COALESCE(checkout_legal_gate_at,CURRENT_TIMESTAMP),
    legal_compliance_state=CASE WHEN legal_compliance_state='PENDING' THEN 'CLEARED' ELSE legal_compliance_state END
WHERE id='TX-0001';

-- Readiness assertions belong in the calling CI workflow. Production migrations never execute this fixture.
