PRAGMA foreign_keys = ON;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_fee_policy_acceptance_insert
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
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires explicit current Platform Fee/refund policy acceptance'); END;

CREATE TRIGGER IF NOT EXISTS merchants_active_requires_fee_policy_acceptance_update
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
BEGIN SELECT RAISE(ABORT,'ACTIVE merchant requires explicit current Platform Fee/refund policy acceptance'); END;

CREATE TRIGGER IF NOT EXISTS transactions_auto_authorize_required_fee_refund
AFTER UPDATE OF refunded_cents ON transactions
WHEN NEW.refunded_cents>OLD.refunded_cents
 AND NEW.fee_refund_handler_code IS NOT NULL
 AND NEW.application_fee_gross_confirmed_cents>0
 AND NEW.fee_refund_handler_code<>'RETAIN_IF_EARNED'
BEGIN
  INSERT OR IGNORE INTO platform_fee_credit_authorizations
    (id,transaction_id,merchant_id,amount_cents,currency,reason_code,evidence_reference,authorization_source,status)
  SELECT
    'PFC-LEGAL-'||NEW.id||'-'||NEW.fee_refund_handler_code||'-'||target_cents,
    NEW.id,NEW.merchant_id,
    target_cents - NEW.application_fee_refunded_cents
      - COALESCE((SELECT SUM(c.amount_cents) FROM platform_fee_credit_authorizations c
                  WHERE c.transaction_id=NEW.id AND c.reason_code='LEGAL_REQUIRED_CREDIT'
                    AND c.status IN ('AUTHORIZED','PROCESSING')),0),
    NEW.currency,'LEGAL_REQUIRED_CREDIT',
    'POLICY='||COALESCE(NEW.fee_refund_policy_version_id,'UNKNOWN')||
    ';HANDLER='||NEW.fee_refund_handler_code||
    ';SOURCE='||COALESCE(NEW.fee_refund_rule_source,'UNKNOWN')||
    ';MERCHANT_STATE='||COALESCE(NEW.fee_refund_merchant_state_code,'UNKNOWN')||
    ';CUSTOMER_STATE='||COALESCE(NEW.fee_refund_customer_state_code,'UNKNOWN')||
    ';TRIGGER=UNDERLYING_REFUND;TARGET='||target_cents,
    'LEGAL','AUTHORIZED'
  FROM (
    SELECT CASE
      WHEN NEW.fee_refund_handler_code='FULL_APP_FEE_ON_ANY_REFUND' AND NEW.refunded_cents>0
        THEN NEW.application_fee_gross_confirmed_cents
      WHEN NEW.fee_refund_handler_code IN ('FULL_APP_FEE_ON_FULL_REFUND','FULL_APP_FEE_ON_FULL_REFUND_OR_LOST_DISPUTE')
           AND NEW.refunded_cents>=COALESCE(NULLIF(NEW.customer_paid_cents,0),NEW.amount_cents)
        THEN NEW.application_fee_gross_confirmed_cents
      WHEN NEW.fee_refund_handler_code='PRO_RATA_APP_FEE' AND NEW.refunded_cents>0
        THEN MIN(NEW.application_fee_gross_confirmed_cents,
          CAST((NEW.application_fee_gross_confirmed_cents * NEW.refunded_cents
            + COALESCE(NULLIF(NEW.customer_paid_cents,0),NEW.amount_cents) - 1)
            / COALESCE(NULLIF(NEW.customer_paid_cents,0),NEW.amount_cents) AS INTEGER))
      ELSE 0 END AS target_cents
  ) target
  WHERE target_cents > NEW.application_fee_refunded_cents
    + COALESCE((SELECT SUM(c.amount_cents) FROM platform_fee_credit_authorizations c
                WHERE c.transaction_id=NEW.id AND c.reason_code='LEGAL_REQUIRED_CREDIT'
                  AND c.status IN ('AUTHORIZED','PROCESSING')),0);
END;

CREATE TRIGGER IF NOT EXISTS transaction_events_auto_authorize_lost_dispute_fee_refund
AFTER INSERT ON transaction_events
WHEN NEW.event_type='DISPUTE_CLOSED'
 AND lower(COALESCE(json_extract(NEW.event_data_json,'$.status'),''))='lost'
BEGIN
  INSERT OR IGNORE INTO platform_fee_credit_authorizations
    (id,transaction_id,merchant_id,amount_cents,currency,reason_code,evidence_reference,authorization_source,status)
  SELECT
    'PFC-LEGAL-'||t.id||'-LOST-DISPUTE-'||t.application_fee_gross_confirmed_cents,
    t.id,t.merchant_id,
    t.application_fee_gross_confirmed_cents - t.application_fee_refunded_cents
      - COALESCE((SELECT SUM(c.amount_cents) FROM platform_fee_credit_authorizations c
                  WHERE c.transaction_id=t.id AND c.reason_code='LEGAL_REQUIRED_CREDIT'
                    AND c.status IN ('AUTHORIZED','PROCESSING')),0),
    t.currency,'LEGAL_REQUIRED_CREDIT',
    'POLICY='||COALESCE(t.fee_refund_policy_version_id,'UNKNOWN')||
    ';HANDLER='||t.fee_refund_handler_code||
    ';SOURCE='||COALESCE(t.fee_refund_rule_source,'UNKNOWN')||
    ';TRIGGER=DISPUTE_LOST',
    'LEGAL','AUTHORIZED'
  FROM transactions t
  WHERE t.id=NEW.transaction_id
    AND t.fee_refund_handler_code='FULL_APP_FEE_ON_FULL_REFUND_OR_LOST_DISPUTE'
    AND t.application_fee_gross_confirmed_cents > t.application_fee_refunded_cents
      + COALESCE((SELECT SUM(c.amount_cents) FROM platform_fee_credit_authorizations c
                  WHERE c.transaction_id=t.id AND c.reason_code='LEGAL_REQUIRED_CREDIT'
                    AND c.status IN ('AUTHORIZED','PROCESSING')),0);
END;

CREATE TRIGGER IF NOT EXISTS fee_refund_policy_demote_merchants
AFTER UPDATE OF status,next_review_due_at ON fee_refund_policy_versions
WHEN OLD.status='APPROVED' AND (
  NEW.status<>'APPROVED' OR (NEW.next_review_due_at IS NOT NULL AND datetime(NEW.next_review_due_at)<=CURRENT_TIMESTAMP)
)
BEGIN
  UPDATE merchants SET status=CASE WHEN status='ACTIVE' THEN 'PAUSED' ELSE status END,
         compliance_status='BLOCKED',updated_at=CURRENT_TIMESTAMP;
END;
