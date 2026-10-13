-- TEST FIXTURE ONLY. Requires the full compliance migration chain.
-- Adds the minimum customer/transaction jurisdiction evidence needed for CI tests that
-- intentionally exercise a PROTECTED transition on TX-0001. Never use in production.

UPDATE customers
SET country_code='US',
    state_code='RI',
    jurisdiction_source='CUSTOMER_ATTESTATION',
    jurisdiction_verified_at=CURRENT_TIMESTAMP,
    jurisdiction_match_status='UNVERIFIED'
WHERE id='CUST-0001';

UPDATE transactions
SET customer_attested_country_code='US',
    customer_attested_state_code='RI',
    customer_attested_at=COALESCE(customer_attested_at,CURRENT_TIMESTAMP),
    checkout_legal_gate_at=COALESCE(checkout_legal_gate_at,CURRENT_TIMESTAMP),
    legal_compliance_state=CASE WHEN legal_compliance_state='PENDING' THEN 'CLEARED' ELSE legal_compliance_state END
WHERE id='TX-0001';
