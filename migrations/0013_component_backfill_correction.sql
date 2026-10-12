PRAGMA foreign_keys = ON;

-- Remove the temporary 0011 payout projection that used GROSS_PAYMENT at payout scope.
-- 0012 introduced the dedicated MERCHANT_PAYOUT type. Fresh and upgraded databases converge here.
UPDATE merchant_component_profiles
SET occurrence_count = MAX(0, occurrence_count - COALESCE((
  SELECT COUNT(*) FROM transaction_components c
  WHERE c.merchant_id = merchant_component_profiles.merchant_id
    AND c.component_type_code = 'GROSS_PAYMENT'
    AND c.scope = 'PAYOUT'
    AND c.source_ref = 'backfill:payout-contribution'
),0))
WHERE component_type_code = 'GROSS_PAYMENT';

DROP TRIGGER IF EXISTS transaction_components_no_delete;
DELETE FROM transaction_components
WHERE component_type_code = 'GROSS_PAYMENT'
  AND scope = 'PAYOUT'
  AND source_ref = 'backfill:payout-contribution';
CREATE TRIGGER IF NOT EXISTS transaction_components_no_delete BEFORE DELETE ON transaction_components
BEGIN SELECT RAISE(ABORT, 'transaction_components are append-only'); END;

-- Generic Builtegrity-created purchases have at least one structured line item even when
-- the processor/POS cannot provide richer itemization. Rich adapters can add real line items.
INSERT OR IGNORE INTO transaction_components
(id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
 amount_cents, currency, quantity, unit_amount_cents, raw_label, display_label, source_system, source_ref, status, metadata_json)
SELECT 'CMP_LINE_' || t.id, t.id, t.merchant_id, t.purchase_id, 'SALE_LINE_ITEM', 'ORDER', 'EXPECTED', 'NEUTRAL', 'MERCHANT',
       t.amount_cents, t.currency, 1, t.amount_cents, t.description, t.description, 'BUILTEGRITY', 'initial:synthetic-line-item', 'ACCOUNTED',
       '{"synthetic":true,"reason":"no richer order itemization supplied yet"}'
FROM transactions t;

DROP TRIGGER IF EXISTS transactions_initialize_expected_components;
CREATE TRIGGER transactions_initialize_expected_components
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

  INSERT OR IGNORE INTO transaction_components
    (id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary,
     amount_cents, currency, quantity, unit_amount_cents, raw_label, display_label, source_system, source_ref, status, metadata_json)
  VALUES
    ('CMP_LINE_' || NEW.id, NEW.id, NEW.merchant_id, NEW.purchase_id, 'SALE_LINE_ITEM', 'ORDER', 'EXPECTED', 'NEUTRAL', 'MERCHANT',
     NEW.amount_cents, NEW.currency, 1, NEW.amount_cents, NEW.description, NEW.description, 'BUILTEGRITY', 'initial:synthetic-line-item',
     'ACCOUNTED', '{"synthetic":true,"reason":"no richer order itemization supplied yet"}');
END;
