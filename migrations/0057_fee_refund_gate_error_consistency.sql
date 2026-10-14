PRAGMA foreign_keys = ON;

-- Preserve a stable legal/compliance error prefix so existing activation diagnostics remain useful
-- regardless of which fail-closed trigger SQLite evaluates first.
DROP TRIGGER IF EXISTS merchants_active_requires_fee_policy_acceptance_insert;
CREATE TRIGGER merchants_active_requires_fee_policy_acceptance_insert
BEFORE INSERT ON merchants
WHEN NEW.status='ACTIVE' AND NOT EXISTS (
  SELECT 1 FROM merchant_fee_policy_acceptances a
  JOIN fee_refund_policy_versions p ON p.version=a.fee_refund_policy_version AND p.status='APPROVED'
  JOIN legal_document_versions d ON d.version=a.fee_schedule_version AND d.document_type='FEE_SCHEDULE' AND d.status='APPROVED'
  WHERE a.merchant_id=NEW.id
    AND p.effective_at IS NOT NULL AND datetime(p.effective_at)<=CURRENT_TIMESTAMP
    AND (p.next_review_due_at IS NULL OR datetime(p.next_review_due_at)>CURRENT_TIMESTAMP)
    AND d.effective_at IS NOT NULL AND datetime(d.effective_at)<=CURRENT_TIMESTAMP
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant legal/compliance clearance requires explicit current Platform Fee/refund policy acceptance'); END;

DROP TRIGGER IF EXISTS merchants_active_requires_fee_policy_acceptance_update;
CREATE TRIGGER merchants_active_requires_fee_policy_acceptance_update
BEFORE UPDATE OF status ON merchants
WHEN NEW.status='ACTIVE' AND NOT EXISTS (
  SELECT 1 FROM merchant_fee_policy_acceptances a
  JOIN fee_refund_policy_versions p ON p.version=a.fee_refund_policy_version AND p.status='APPROVED'
  JOIN legal_document_versions d ON d.version=a.fee_schedule_version AND d.document_type='FEE_SCHEDULE' AND d.status='APPROVED'
  WHERE a.merchant_id=NEW.id
    AND p.effective_at IS NOT NULL AND datetime(p.effective_at)<=CURRENT_TIMESTAMP
    AND (p.next_review_due_at IS NULL OR datetime(p.next_review_due_at)>CURRENT_TIMESTAMP)
    AND d.effective_at IS NOT NULL AND datetime(d.effective_at)<=CURRENT_TIMESTAMP
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant legal/compliance clearance requires explicit current Platform Fee/refund policy acceptance'); END;

DROP TRIGGER IF EXISTS merchants_active_requires_fee_refund_compliance_insert;
CREATE TRIGGER merchants_active_requires_fee_refund_compliance_insert
BEFORE INSERT ON merchants
WHEN NEW.status='ACTIVE' AND (
  NOT EXISTS (SELECT 1 FROM platform_compliance_controls p WHERE p.id='GLOBAL'
    AND p.platform_fee_refund_policy_status='APPROVED' AND p.platform_fee_refund_policy_reference IS NOT NULL
    AND p.platform_fee_refund_policy_reviewed_at IS NOT NULL
    AND (p.platform_fee_refund_policy_next_review_due_at IS NULL OR datetime(p.platform_fee_refund_policy_next_review_due_at)>CURRENT_TIMESTAMP))
  OR NOT EXISTS (SELECT 1 FROM state_jurisdiction_support s JOIN fee_refund_handler_catalog h ON h.code=s.platform_fee_refund_handler_code
    WHERE s.state_code=NEW.state_code AND s.platform_fee_refund_review_status='READY' AND h.implementation_status='TESTED'
      AND s.platform_fee_refund_reference IS NOT NULL AND s.platform_fee_refund_reviewed_at IS NOT NULL
      AND (s.platform_fee_refund_next_review_due_at IS NULL OR datetime(s.platform_fee_refund_next_review_due_at)>CURRENT_TIMESTAMP))
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant legal/compliance clearance requires approved Platform Fee/refund policy and reviewed state rule'); END;

DROP TRIGGER IF EXISTS merchants_active_requires_fee_refund_compliance_update;
CREATE TRIGGER merchants_active_requires_fee_refund_compliance_update
BEFORE UPDATE OF status,state_code ON merchants
WHEN NEW.status='ACTIVE' AND (
  NOT EXISTS (SELECT 1 FROM platform_compliance_controls p WHERE p.id='GLOBAL'
    AND p.platform_fee_refund_policy_status='APPROVED' AND p.platform_fee_refund_policy_reference IS NOT NULL
    AND p.platform_fee_refund_policy_reviewed_at IS NOT NULL
    AND (p.platform_fee_refund_policy_next_review_due_at IS NULL OR datetime(p.platform_fee_refund_policy_next_review_due_at)>CURRENT_TIMESTAMP))
  OR NOT EXISTS (SELECT 1 FROM state_jurisdiction_support s JOIN fee_refund_handler_catalog h ON h.code=s.platform_fee_refund_handler_code
    WHERE s.state_code=NEW.state_code AND s.platform_fee_refund_review_status='READY' AND h.implementation_status='TESTED'
      AND s.platform_fee_refund_reference IS NOT NULL AND s.platform_fee_refund_reviewed_at IS NOT NULL
      AND (s.platform_fee_refund_next_review_due_at IS NULL OR datetime(s.platform_fee_refund_next_review_due_at)>CURRENT_TIMESTAMP))
)
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant legal/compliance clearance requires approved Platform Fee/refund policy and reviewed state rule'); END;
