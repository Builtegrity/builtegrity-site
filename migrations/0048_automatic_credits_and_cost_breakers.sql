PRAGMA foreign_keys = ON;

-- The first platform-credit guard was intentionally conservative. Replace it with a cash-backed
-- guard: a platform credit can never exceed Builtegrity application-fee cash actually collected
-- and not already refunded. This permits a full correction if a software defect overcharged far
-- above the legitimate fee while still preventing the credit table from becoming a transfer rail.
DROP TRIGGER IF EXISTS platform_fee_credit_amount_guard_insert;
CREATE TRIGGER platform_fee_credit_amount_guard_insert
BEFORE INSERT ON platform_fee_credit_authorizations
WHEN NEW.amount_cents > COALESCE((
  SELECT MAX(0, application_fee_gross_confirmed_cents - application_fee_refunded_cents)
  FROM transactions WHERE id=NEW.transaction_id AND merchant_id=NEW.merchant_id
),0)
BEGIN SELECT RAISE(ABORT, 'platform fee credit cannot exceed unrefunded Builtegrity application-fee cash'); END;

-- A processor-confirmed application fee larger than the exact server-owned fee plus previously
-- earned carry is a Builtegrity overcharge by definition. Authorize exactly the excess amount.
CREATE TRIGGER IF NOT EXISTS transactions_auto_authorize_platform_overcharge
AFTER UPDATE OF application_fee_gross_confirmed_cents ON transactions
WHEN NEW.application_fee_gross_confirmed_cents > 0
 AND NEW.application_fee_gross_confirmed_cents > (
   NEW.pricing_calculated_cents + COALESCE(NEW.pricing_carry_reserved_cents,0)
 )
BEGIN
  INSERT OR IGNORE INTO platform_fee_credit_authorizations (
    id,transaction_id,merchant_id,amount_cents,currency,reason_code,evidence_reference,
    authorization_source,status
  ) VALUES (
    'PFC-AUTO-'||NEW.id||'-'||NEW.application_fee_gross_confirmed_cents,
    NEW.id,
    NEW.merchant_id,
    NEW.application_fee_gross_confirmed_cents - (NEW.pricing_calculated_cents + COALESCE(NEW.pricing_carry_reserved_cents,0)),
    NEW.currency,
    'INCORRECT_PLATFORM_FEE',
    'SYSTEM:PROCESSOR_CONFIRMED_APPLICATION_FEE_EXCEEDS_LOCKED_PRICE',
    'SYSTEM_VERIFIED',
    'AUTHORIZED'
  );
END;

-- Any application-fee refund reported by Stripe must reconcile to a documented Builtegrity
-- platform-fault credit. Merchant/customer refunds never create these authorizations.
CREATE TRIGGER IF NOT EXISTS application_fee_refund_requires_authorization
AFTER INSERT ON transaction_financial_adjustments
WHEN NEW.adjustment_type='APPLICATION_FEE_REFUND'
BEGIN
  INSERT INTO system_alerts (
    alert_key,category,severity,status,subject_type,subject_id,message
  )
  SELECT
    'fee-refund:unauthorized:'||NEW.id,
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

-- When the processor webhook confirms an authorized amount has actually left Builtegrity, the
-- credit record becomes completed. The application layer also records the processor refund ID.
CREATE TRIGGER IF NOT EXISTS application_fee_refund_completes_authorization
AFTER INSERT ON transaction_financial_adjustments
WHEN NEW.adjustment_type='APPLICATION_FEE_REFUND'
BEGIN
  UPDATE platform_fee_credit_authorizations
     SET status='COMPLETED', completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP)
   WHERE transaction_id=NEW.transaction_id
     AND amount_cents=NEW.amount_cents
     AND status IN ('AUTHORIZED','PROCESSING');
END;

-- -----------------------------------------------------------------------------
-- Optional-service cost circuit breakers. The critical payment path is not touched.
-- Once a noncritical service consumes its configured monthly allowance it disables itself.
-- -----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS variable_cost_refresh_service_budget
AFTER INSERT ON variable_cost_ledger
BEGIN
  UPDATE optional_service_controls
     SET current_month_spend_cents = CAST((
           SELECT COALESCE(SUM(v.amount_micros),0)/10000
           FROM variable_cost_ledger v
           WHERE v.service_code=NEW.service_code
             AND strftime('%Y-%m',v.incurred_at)=strftime('%Y-%m',NEW.incurred_at)
         ) AS INTEGER),
         updated_at=CURRENT_TIMESTAMP
   WHERE service_code=NEW.service_code;

  UPDATE optional_service_controls
     SET enabled=0,
         reason='Automatic cost circuit breaker: configured monthly budget reached.',
         updated_at=CURRENT_TIMESTAMP
   WHERE service_code=NEW.service_code
     AND monthly_budget_cents>0
     AND current_month_spend_cents*1000000 >= monthly_budget_cents*disable_at_budget_ppm;
END;

CREATE TRIGGER IF NOT EXISTS outsourced_labor_budget_stops_dispatch
AFTER INSERT ON variable_cost_ledger
WHEN NEW.service_code='OUTSOURCED_LABOR'
 AND EXISTS (
   SELECT 1 FROM optional_service_controls
   WHERE service_code='OUTSOURCED_LABOR' AND enabled=0
 )
BEGIN
  UPDATE workforce_policy
     SET auto_dispatch_enabled=0, updated_at=CURRENT_TIMESTAMP
   WHERE id='GLOBAL';
END;

-- If a new month begins, the watchdog/autopilot may explicitly re-enable an optional service only
-- after reviewing its budget. No trigger automatically turns spending back on merely because the
-- calendar changed; this prevents a recurring runaway vendor from silently restarting.

-- Resolution playbook for unexpected fee refunds is internal and never outsourceable because it
-- can affect Builtegrity revenue. Investigation may be assisted elsewhere, but authorization and
-- write-off decisions remain inside the platform control plane.
INSERT OR REPLACE INTO resolution_playbooks
(code,title,party_type,provider_code,verification_handler,default_sla_minutes,notify_after_minutes,repeat_notice_minutes,outsource_category,outsource_after_minutes,default_work_budget_cents,privileged_access_required,outsourcing_allowed,customer_safe) VALUES
('UNAUTHORIZED_FEE_REFUND','Unexpected Builtegrity fee refund','INTERNAL','STRIPE','WATCHDOG_ALERT_CLEARED',30,0,60,NULL,NULL,0,1,0,0);

INSERT OR REPLACE INTO resolution_steps
(playbook_code,sequence,actor_type,title,instruction,link_kind,explicit_url,automatic_verification_note) VALUES
('UNAUTHORIZED_FEE_REFUND',1,'SYSTEM','Freeze assumptions and reconcile evidence','Preserve the Stripe fee-refund event, locked transaction price, platform-credit authorizations and processor application-fee record. Do not create another refund.','NONE',NULL,'The financial alert remains open until the processor movement has a matching authorized cause.'),
('UNAUTHORIZED_FEE_REFUND',2,'SYSTEM','Determine authorized or unauthorized cause','If a matching Builtegrity platform-fault credit exists, reconcile it. Otherwise route the unexplained processor movement for privileged financial/security review.','DASHBOARD','https://dashboard.stripe.com/','Revenue write-offs cannot be approved by an outsourced vendor.'),
('UNAUTHORIZED_FEE_REFUND',3,'SYSTEM','Verify financial reconciliation','Close only after the application-fee cash movement, transaction ledger and credit authorization agree.','NONE',NULL,'Machine verified.');
