PRAGMA foreign_keys = ON;

-- Runtime projection triggers for canonical components. These do not replace provider adapters;
-- they guarantee that core Builtegrity transaction state always emits minimum transaction facts.

INSERT OR IGNORE INTO transaction_component_types
(code,module_code,family,name,default_direction,reconciliation_role,default_beneficiary,accounting_required,description)
VALUES
('MERCHANT_PAYOUT','PAYOUT','PAYOUT','Merchant payout contribution','INFLOW','PRINCIPAL','MERCHANT',1,'Amount from this transaction ultimately attributed to merchant payout.');

CREATE TRIGGER IF NOT EXISTS merchant_profile_mandatory_modules_autocreate
AFTER INSERT ON merchants
BEGIN
  INSERT OR IGNORE INTO merchant_profile_modules (merchant_id,module_code,activation_state)
  SELECT NEW.id, code, 'MANDATORY' FROM transaction_modules WHERE mandatory = 1;
END;

CREATE TRIGGER IF NOT EXISTS transactions_initialize_expected_components
AFTER INSERT ON transactions
BEGIN
  INSERT OR IGNORE INTO transaction_components
    (id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
     amount_cents, currency, display_label, source_system, source_ref, status)
  VALUES
    ('CMP_EXP_GROSS_' || NEW.id, NEW.id, NEW.merchant_id, NEW.purchase_id, 'GROSS_PAYMENT', 'PAYMENT', 'EXPECTED',
     'INFLOW', 'MERCHANT', NEW.amount_cents, NEW.currency, 'Expected customer payment', 'BUILTEGRITY', 'initial:expected-gross', 'ACCOUNTED');

  INSERT OR IGNORE INTO transaction_components
    (id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
     amount_cents, currency, display_label, source_system, source_ref, status)
  SELECT
    'CMP_EXP_FEE_' || NEW.id, NEW.id, NEW.merchant_id, NEW.purchase_id, 'INTEGRITY_FEE', 'PAYMENT', 'EXPECTED',
    'OUTFLOW', 'BUILTEGRITY', NEW.integrity_fee_earned_cents, NEW.currency, 'Expected Builtegrity Integrity Fee',
    'BUILTEGRITY', 'initial:expected-integrity-fee', 'ACCOUNTED'
  WHERE NEW.integrity_fee_earned_cents > 0;
END;

CREATE TRIGGER IF NOT EXISTS transactions_component_actual_payment
AFTER UPDATE OF customer_paid_cents, payment_status ON transactions
WHEN NEW.payment_status = 'succeeded'
  AND NEW.customer_paid_cents IS NOT NULL
  AND (OLD.payment_status IS NULL OR OLD.payment_status <> 'succeeded' OR OLD.customer_paid_cents IS NULL)
BEGIN
  INSERT OR IGNORE INTO transaction_components
    (id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
     amount_cents, currency, display_label, source_system, source_ref, status)
  VALUES
    ('CMP_ACT_GROSS_' || NEW.id, NEW.id, NEW.merchant_id, NEW.purchase_id, 'GROSS_PAYMENT', 'PAYMENT', 'ACTUAL',
     'INFLOW', 'MERCHANT', NEW.customer_paid_cents, NEW.currency, 'Actual customer payment', NEW.processor,
     'transaction-state:actual-gross', 'ACCOUNTED');
END;

CREATE TRIGGER IF NOT EXISTS transactions_component_processor_fee
AFTER UPDATE OF processor_fee_cents ON transactions
WHEN NEW.processor_fee_cents IS NOT NULL AND NEW.processor_fee_cents >= 0 AND OLD.processor_fee_cents IS NULL
BEGIN
  INSERT OR IGNORE INTO transaction_components
    (id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
     amount_cents, currency, display_label, source_system, source_ref, status)
  VALUES
    ('CMP_ACT_PROC_' || NEW.id, NEW.id, NEW.merchant_id, NEW.purchase_id, 'PROCESSOR_FEE', 'PAYMENT', 'ACTUAL',
     'OUTFLOW', 'PROCESSOR', NEW.processor_fee_cents, NEW.currency, 'Processor fee', NEW.processor,
     'transaction-state:processor-fee', 'ACCOUNTED');
END;

CREATE TRIGGER IF NOT EXISTS transactions_component_integrity_fee
AFTER UPDATE OF integrity_fee_collected_cents ON transactions
WHEN NEW.integrity_fee_collected_cents > 0 AND OLD.integrity_fee_collected_cents = 0
BEGIN
  INSERT OR IGNORE INTO transaction_components
    (id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
     amount_cents, currency, display_label, source_system, source_ref, status)
  VALUES
    ('CMP_ACT_FEE_' || NEW.id, NEW.id, NEW.merchant_id, NEW.purchase_id, 'INTEGRITY_FEE', 'PAYMENT', 'ACTUAL',
     'OUTFLOW', 'BUILTEGRITY', NEW.integrity_fee_collected_cents, NEW.currency, 'Builtegrity Integrity Fee', NEW.processor,
     'transaction-state:integrity-fee', 'ACCOUNTED');
END;

CREATE TRIGGER IF NOT EXISTS transactions_component_payout
AFTER UPDATE OF actual_merchant_net_cents ON transactions
WHEN NEW.actual_merchant_net_cents IS NOT NULL AND OLD.actual_merchant_net_cents IS NULL
BEGIN
  INSERT OR IGNORE INTO transaction_components
    (id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
     amount_cents, currency, display_label, source_system, source_ref, status)
  VALUES
    ('CMP_ACT_PAYOUT_' || NEW.id, NEW.id, NEW.merchant_id, NEW.purchase_id, 'MERCHANT_PAYOUT', 'PAYOUT', 'ACTUAL',
     'INFLOW', 'MERCHANT', NEW.actual_merchant_net_cents, NEW.currency, 'Merchant payout contribution', NEW.processor,
     'transaction-state:payout', 'ACCOUNTED');
END;

-- Correct the legacy 0011 backfill type if 0011 inserted a payout contribution as GROSS_PAYMENT.
INSERT OR IGNORE INTO transaction_components
(id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
 amount_cents, currency, display_label, source_system, source_ref, status)
SELECT 'CMP_ACT_MERCHANT_PAYOUT_' || t.id, t.id, t.merchant_id, t.purchase_id, 'MERCHANT_PAYOUT', 'PAYOUT', 'ACTUAL',
       'INFLOW', 'MERCHANT', t.actual_merchant_net_cents, t.currency, 'Merchant payout contribution', t.processor,
       'backfill:merchant-payout', 'ACCOUNTED'
FROM transactions t WHERE t.actual_merchant_net_cents IS NOT NULL;
