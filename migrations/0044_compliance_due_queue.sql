PRAGMA foreign_keys = ON;

-- Single operational queue for compliance items that can become stale or miss a deadline.
-- This view does not make legal judgments; it surfaces evidence that is missing, expired,
-- approaching expiry, or awaiting human/legal review.
CREATE VIEW IF NOT EXISTS compliance_due_queue AS
SELECT
  'OBLIGATION:' || id AS item_key,
  'OBLIGATION' AS item_type,
  id AS subject_id,
  CASE
    WHEN status IN ('OPEN','BLOCKED') THEN 'CRITICAL'
    WHEN next_review_due_at IS NOT NULL AND datetime(next_review_due_at)<=datetime('now','+30 days') THEN 'WARN'
    ELSE 'INFO'
  END AS severity,
  title AS summary,
  next_review_due_at AS due_at,
  status AS state
FROM compliance_obligations
WHERE obligation_type='REQUIRED'
  AND (
    status NOT IN ('SATISFIED','NOT_APPLICABLE') OR
    (status='SATISFIED' AND (evidence_ref IS NULL OR verified_at IS NULL)) OR
    (next_review_due_at IS NOT NULL AND datetime(next_review_due_at)<=datetime('now','+30 days'))
  )

UNION ALL
SELECT
  'VENDOR:' || id,'VENDOR',id,
  CASE WHEN contract_status='BLOCKED' OR security_review_status='BLOCKED' THEN 'CRITICAL'
       WHEN contract_status<>'APPROVED' OR security_review_status<>'APPROVED' OR subprocessors_reviewed<>1 THEN 'ERROR'
       ELSE 'WARN' END,
  provider_name || ' compliance/security review',next_review_due_at,
  contract_status || '/' || security_review_status
FROM service_provider_registry
WHERE (personal_data_access=1 OR financial_data_access=1)
  AND (
    contract_status<>'APPROVED' OR security_review_status<>'APPROVED' OR subprocessors_reviewed<>1 OR
    last_reviewed_at IS NULL OR
    (next_review_due_at IS NOT NULL AND datetime(next_review_due_at)<=datetime('now','+30 days'))
  )

UNION ALL
SELECT
  'PCI:GLOBAL','PCI','GLOBAL',
  CASE WHEN pci_status<>'VALID' OR pci_expires_at IS NULL OR datetime(pci_expires_at)<=CURRENT_TIMESTAMP THEN 'CRITICAL' ELSE 'WARN' END,
  'PCI validation / ASV evidence',
  CASE WHEN pci_asv_required=1 AND pci_asv_next_due_at IS NOT NULL AND datetime(pci_asv_next_due_at)<datetime(pci_expires_at)
       THEN pci_asv_next_due_at ELSE pci_expires_at END,
  pci_status
FROM platform_compliance_controls
WHERE id='GLOBAL' AND (
  pci_status<>'VALID' OR pci_validation_reference IS NULL OR pci_attested_at IS NULL OR pci_expires_at IS NULL OR
  datetime(pci_expires_at)<=datetime('now','+30 days') OR pci_asv_required IS NULL OR
  (pci_asv_required=1 AND (pci_asv_status<>'PASS' OR pci_asv_next_due_at IS NULL OR datetime(pci_asv_next_due_at)<=datetime('now','+30 days')))
)

UNION ALL
SELECT
  'MERCHANT-SANCTIONS:' || id,'MERCHANT_SANCTIONS',id,
  CASE WHEN sanctions_review_status IN ('POTENTIAL_MATCH','BLOCKED') OR sanctions_next_review_due_at IS NULL OR datetime(sanctions_next_review_due_at)<=CURRENT_TIMESTAMP THEN 'CRITICAL' ELSE 'WARN' END,
  name || ' sanctions screening',sanctions_next_review_due_at,sanctions_review_status
FROM merchants
WHERE status<>'DISCONNECTED' AND (
  sanctions_review_status<>'CLEAR' OR sanctions_reviewed_at IS NULL OR sanctions_evidence_ref IS NULL OR
  sanctions_next_review_due_at IS NULL OR datetime(sanctions_next_review_due_at)<=datetime('now','+14 days')
)

UNION ALL
SELECT
  'STATE-MERCHANT:' || state_code,'STATE_MERCHANT_PACK',state_code,
  CASE WHEN merchant_onboarding_status='BLOCKED' THEN 'ERROR' ELSE 'WARN' END,
  state_name || ' merchant jurisdiction pack',next_review_due_at,merchant_onboarding_status
FROM state_jurisdiction_support
WHERE merchant_onboarding_status='READY'
  AND next_review_due_at IS NOT NULL
  AND datetime(next_review_due_at)<=datetime('now','+30 days')

UNION ALL
SELECT
  'STATE-CUSTOMER:' || state_code,'STATE_CUSTOMER_PACK',state_code,
  CASE WHEN customer_transaction_status='BLOCKED' THEN 'ERROR' ELSE 'WARN' END,
  state_name || ' customer transaction jurisdiction pack',next_review_due_at,customer_transaction_status
FROM state_jurisdiction_support
WHERE customer_transaction_status='READY'
  AND next_review_due_at IS NOT NULL
  AND datetime(next_review_due_at)<=datetime('now','+30 days')

UNION ALL
SELECT
  'PRIVACY:' || id,'PRIVACY_REQUEST',id,
  CASE WHEN legal_deadline_at IS NOT NULL AND datetime(legal_deadline_at)<=CURRENT_TIMESTAMP THEN 'CRITICAL'
       WHEN datetime(internal_target_at)<=CURRENT_TIMESTAMP THEN 'ERROR' ELSE 'WARN' END,
  'Privacy request ' || request_type,
  COALESCE(legal_deadline_at,internal_target_at),status
FROM privacy_requests
WHERE status NOT IN ('COMPLETED','DENIED','WITHDRAWN')
  AND (
    datetime(internal_target_at)<=datetime('now','+7 days') OR
    (legal_deadline_at IS NOT NULL AND datetime(legal_deadline_at)<=datetime('now','+14 days'))
  )

UNION ALL
SELECT
  'INCIDENT:' || id,'SECURITY_INCIDENT',id,
  CASE WHEN severity='CRITICAL' OR (ri_notice_deadline_at IS NOT NULL AND datetime(ri_notice_deadline_at)<=CURRENT_TIMESTAMP) THEN 'CRITICAL'
       WHEN severity='HIGH' THEN 'ERROR' ELSE 'WARN' END,
  'Security incident: ' || substr(description,1,200),ri_notice_deadline_at,status
FROM security_incidents
WHERE status<>'CLOSED';
