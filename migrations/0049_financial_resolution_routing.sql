PRAGMA foreign_keys = ON;

-- Unexpected Builtegrity fee refunds are financial-control incidents, not generic technical work.
-- Re-key the detector so the resolver's finance:* rule routes it to FINANCIAL_SAFETY, where it
-- cannot be outsourced or used to authorize a revenue write-off.
DROP TRIGGER IF EXISTS application_fee_refund_requires_authorization;
CREATE TRIGGER application_fee_refund_requires_authorization
AFTER INSERT ON transaction_financial_adjustments
WHEN NEW.adjustment_type='APPLICATION_FEE_REFUND'
BEGIN
  INSERT INTO system_alerts (
    alert_key,category,severity,status,subject_type,subject_id,message
  )
  SELECT
    'finance:fee-refund-unauthorized:'||NEW.id,
    'FINANCE',
    'CRITICAL',
    'OPEN',
    'TRANSACTION',
    NEW.transaction_id,
    'Stripe reported a Builtegrity application-fee refund without a matching documented platform-fault credit authorization.'
  WHERE NOT EXISTS (
    SELECT 1 FROM platform_fee_credit_authorizations c
    WHERE c.transaction_id=NEW.transaction_id
      AND c.amount_cents>=NEW.amount_cents
      AND c.status IN ('AUTHORIZED','PROCESSING','COMPLETED')
  )
  ON CONFLICT(alert_key) DO UPDATE SET
    status='OPEN', severity='CRITICAL', last_seen_at=CURRENT_TIMESTAMP,
    occurrences=system_alerts.occurrences+1, resolved_at=NULL;
END;

-- Remove the now-unreachable special playbook. FINANCIAL_SAFETY is the single authoritative
-- path for processor-money discrepancies, solvency brakes and unexpected platform-fee movement.
DELETE FROM resolution_steps WHERE playbook_code='UNAUTHORIZED_FEE_REFUND';
DELETE FROM resolution_playbooks WHERE code='UNAUTHORIZED_FEE_REFUND';

DELETE FROM resolution_steps WHERE playbook_code='FINANCIAL_SAFETY';
INSERT INTO resolution_steps
(playbook_code,sequence,actor_type,title,instruction,link_kind,explicit_url,automatic_verification_note) VALUES
('FINANCIAL_SAFETY',1,'SYSTEM','Freeze unsafe financial assumptions','Preserve processor evidence, locked pricing, platform-credit authorizations, financial-safety snapshots and the originating alert. Do not create a compensating transfer, fee refund or revenue write-off merely to make records match.','NONE',NULL,'Financial controls remain fail closed until evidence reconciles.'),
('FINANCIAL_SAFETY',2,'SYSTEM','Reconcile the authoritative source','For processor fee or balance discrepancies, compare the Builtegrity ledger with the official Stripe record. For margin/solvency conditions, refresh the processor balance, cost ledger and financial position inputs.','DASHBOARD','https://dashboard.stripe.com/','Stripe is authoritative for processor cash movement; Builtegrity is authoritative for its locked pricing and authorization ledger.'),
('FINANCIAL_SAFETY',3,'SYSTEM','Route only the real external action','If Stripe shows an unexplained processor movement, use official Stripe Support. If the issue is a Builtegrity platform defect, create a documented platform-fault credit authorization for only the verified excess. Security/legal decisions remain on their separate authorized paths.','SUPPORT','https://support.stripe.com/','No outsourced vendor may authorize a write-off or arbitrary money movement.'),
('FINANCIAL_SAFETY',4,'SYSTEM','Verify before restoring normal operation','Rerun the originating financial watchdog. Resolve only when processor cash, Builtegrity pricing/credits, variable-cost records and financial-safety state agree.','NONE',NULL,'The case closes from machine-observable evidence, not a human completion claim.');
