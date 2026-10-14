PRAGMA foreign_keys = ON;

-- Multiple fail-closed workforce guards can reject the same unsafe activation. Keep their
-- messages under one stable prefix so operators and CI can distinguish a deliberate policy
-- rejection from an unexpected database error regardless of SQLite trigger evaluation order.
DROP TRIGGER IF EXISTS workforce_vendor_approval_guard;
CREATE TRIGGER workforce_vendor_approval_guard
BEFORE UPDATE OF status,auto_dispatch_enabled,contract_status,tax_status,dispatch_email,dispatch_endpoint ON workforce_vendors
WHEN NEW.status='APPROVED' AND NEW.auto_dispatch_enabled=1 AND (
  NEW.contract_status<>'ACTIVE' OR NEW.tax_status<>'CLEARED' OR
  (NEW.dispatch_mode='EMAIL' AND (NEW.dispatch_email IS NULL OR NEW.dispatch_email='')) OR
  (NEW.dispatch_mode='WEBHOOK' AND (NEW.dispatch_endpoint IS NULL OR NEW.dispatch_endpoint='')) OR
  NEW.per_work_order_cap_cents<=0 OR NEW.monthly_cap_cents<=0
)
BEGIN SELECT RAISE(ABORT, 'automatic workforce vendor blocked: active contract, tax clearance, dispatch destination and budget caps are required'); END;

DROP TRIGGER IF EXISTS workforce_vendor_no_dpa_regression;
CREATE TRIGGER workforce_vendor_no_dpa_regression
BEFORE UPDATE OF dpa_status,status,auto_dispatch_enabled ON workforce_vendors
WHEN NEW.status='APPROVED' AND NEW.auto_dispatch_enabled=1
 AND EXISTS (
   SELECT 1 FROM workforce_vendor_capabilities c
   WHERE c.vendor_id=NEW.id AND c.approved=1 AND c.max_data_class='CUSTOMER_CONTACT'
 )
 AND NEW.dpa_status<>'ACTIVE'
BEGIN SELECT RAISE(ABORT, 'automatic workforce vendor blocked: customer-contact capability requires an active DPA'); END;

DROP TRIGGER IF EXISTS workforce_vendor_no_contract_regression;
CREATE TRIGGER workforce_vendor_no_contract_regression
BEFORE UPDATE OF contract_status,tax_status,status,auto_dispatch_enabled,per_work_order_cap_cents,monthly_cap_cents ON workforce_vendors
WHEN NEW.status='APPROVED' AND NEW.auto_dispatch_enabled=1 AND (
  NEW.contract_status<>'ACTIVE' OR NEW.tax_status<>'CLEARED' OR
  NEW.per_work_order_cap_cents<=0 OR NEW.monthly_cap_cents<=0
)
BEGIN SELECT RAISE(ABORT, 'automatic workforce vendor blocked: contract, tax and budget controls cannot regress'); END;
