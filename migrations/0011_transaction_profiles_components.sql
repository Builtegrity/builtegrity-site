PRAGMA foreign_keys = ON;

-- Universal transaction-intelligence layer.
-- Merchant customization may change presentation/alerts only. It may not disable capture,
-- reconciliation, or historical truth.

CREATE TABLE IF NOT EXISTS transaction_modules (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0,1))
);

INSERT OR IGNORE INTO transaction_modules (code, title, description, mandatory) VALUES
  ('CORE_PAYMENT','Core payment','Principal payment facts and payment state',1),
  ('ORDER_ITEMIZATION','Order itemization','Line items, order subtotals, quantities, SKU/context',0),
  ('TAX','Taxes','Sales, local, excise, VAT and similar taxes',0),
  ('GRATUITY','Gratuities','Employee, pooled and courier gratuities',0),
  ('DISCOUNT','Discounts and credits','Promotions, coupons, loyalty and manual discounts',0),
  ('MERCHANT_CHARGE','Merchant-added charges','Service, convenience, delivery, booking and similar charges',0),
  ('PROCESSOR_ECONOMICS','Processor economics','Processor, authorization and payout fees',0),
  ('PLATFORM_ECONOMICS','Platform economics','Marketplace, delivery and platform commissions',0),
  ('BUILTEGRITY_ECONOMICS','Builtegrity economics','Integrity fee and future Builtegrity transaction charges',1),
  ('PARTNER_ECONOMICS','Partner economics','Referral, reseller and integration partner shares',0),
  ('REFUND','Refunds and reversals','Full, partial and fee reversals',0),
  ('DISPUTE','Disputes and recovery','Disputed principal, dispute fees and recoveries',0),
  ('PAYOUT','Settlement and payout','Expected and actual merchant settlement/payout facts',1),
  ('CURRENCY','Currency and FX','FX fees, conversion and currency adjustments',0),
  ('RESERVE_HOLD','Reserves and holds','Rolling reserves, processor reserves and temporary holds',0),
  ('GOVERNMENT','Government obligations','Tax withholding and statutory charges',0),
  ('LABOR_OBLIGATION','Labor obligations','Employee commission, gratuity and similar obligations',0),
  ('FRANCHISE','Franchise obligations','Royalty, marketing and technology obligations',0),
  ('FULFILLMENT','Fulfillment','Shipping, courier, delivery and fulfillment costs',0),
  ('STORED_VALUE','Stored value','Gift card, store credit, loyalty and promotional value',0),
  ('FINANCING','Financing','BNPL, financing and installment economics',0),
  ('ADJUSTMENT','Adjustments','Rounding, reconciliation and manual corrections',0),
  ('EVIDENCE','Evidence and documents','Receipts, invoices, contracts, fulfillment and transaction evidence',0),
  ('CUSTOM','Merchant-specific components','Merchant-specific charges or obligations that do not fit a standard type',0),
  ('UNKNOWN','Unknown components','Captured facts that require classification; never silently discarded',0);

CREATE TABLE IF NOT EXISTS transaction_component_types (
  code TEXT PRIMARY KEY,
  module_code TEXT NOT NULL,
  family TEXT NOT NULL,
  name TEXT NOT NULL,
  default_direction TEXT NOT NULL CHECK (default_direction IN ('INFLOW','OUTFLOW','NEUTRAL')),
  reconciliation_role TEXT NOT NULL CHECK (reconciliation_role IN ('PRINCIPAL','ADDITION','DEDUCTION','NONCASH','CONTEXT','ADJUSTMENT')),
  default_beneficiary TEXT NOT NULL CHECK (default_beneficiary IN ('MERCHANT','CUSTOMER','EMPLOYEE','PROCESSOR','BUILTEGRITY','PARTNER','PLATFORM','GOVERNMENT','OTHER','UNKNOWN')),
  accounting_required INTEGER NOT NULL DEFAULT 1 CHECK (accounting_required IN (0,1)),
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  FOREIGN KEY (module_code) REFERENCES transaction_modules(code)
);

INSERT OR IGNORE INTO transaction_component_types
(code,module_code,family,name,default_direction,reconciliation_role,default_beneficiary,accounting_required,description) VALUES
  ('GROSS_PAYMENT','CORE_PAYMENT','SALE','Gross payment','INFLOW','PRINCIPAL','MERCHANT',1,'Total customer payment observed or expected.'),
  ('DEPOSIT_PAYMENT','CORE_PAYMENT','SALE','Deposit payment','INFLOW','PRINCIPAL','MERCHANT',1,'Deposit or initial payment.'),
  ('BALANCE_PAYMENT','CORE_PAYMENT','SALE','Balance payment','INFLOW','PRINCIPAL','MERCHANT',1,'Remaining/final balance payment.'),
  ('INSTALLMENT_PAYMENT','CORE_PAYMENT','SALE','Installment payment','INFLOW','PRINCIPAL','MERCHANT',1,'Installment against a larger purchase.'),
  ('SALE_LINE_ITEM','ORDER_ITEMIZATION','SALE','Sale line item','NEUTRAL','CONTEXT','MERCHANT',0,'Itemized product/service line used to explain an order.'),
  ('ORDER_SUBTOTAL','ORDER_ITEMIZATION','SALE','Order subtotal','NEUTRAL','CONTEXT','MERCHANT',0,'Order subtotal before additions/deductions.'),
  ('SALES_TAX','TAX','TAX','Sales tax','NEUTRAL','ADDITION','GOVERNMENT',1,'General sales/use tax collected in the transaction.'),
  ('LOCAL_TAX','TAX','TAX','Local tax','NEUTRAL','ADDITION','GOVERNMENT',1,'Municipal/local tax.'),
  ('EXCISE_TAX','TAX','TAX','Excise tax','NEUTRAL','ADDITION','GOVERNMENT',1,'Excise or special-category tax.'),
  ('VAT','TAX','TAX','Value-added tax','NEUTRAL','ADDITION','GOVERNMENT',1,'VAT or similar consumption tax.'),
  ('EMPLOYEE_TIP','GRATUITY','GRATUITY','Employee tip','NEUTRAL','ADDITION','EMPLOYEE',1,'Tip intended for an employee.'),
  ('POOLED_TIP','GRATUITY','GRATUITY','Pooled tip','NEUTRAL','ADDITION','EMPLOYEE',1,'Tip intended for a pooled gratuity obligation.'),
  ('COURIER_TIP','GRATUITY','GRATUITY','Courier tip','NEUTRAL','ADDITION','OTHER',1,'Tip passed to a courier/delivery worker.'),
  ('PROMOTION_DISCOUNT','DISCOUNT','DISCOUNT','Promotion discount','NEUTRAL','DEDUCTION','MERCHANT',0,'Promotion applied to order value.'),
  ('COUPON_DISCOUNT','DISCOUNT','DISCOUNT','Coupon discount','NEUTRAL','DEDUCTION','MERCHANT',0,'Coupon discount.'),
  ('LOYALTY_DISCOUNT','DISCOUNT','DISCOUNT','Loyalty discount','NEUTRAL','DEDUCTION','MERCHANT',0,'Loyalty-program discount.'),
  ('EMPLOYEE_DISCOUNT','DISCOUNT','DISCOUNT','Employee discount','NEUTRAL','DEDUCTION','MERCHANT',0,'Employee discount.'),
  ('MANUAL_DISCOUNT','DISCOUNT','DISCOUNT','Manual discount','NEUTRAL','DEDUCTION','MERCHANT',0,'Manual or manager-entered discount.'),
  ('CASH_DISCOUNT','DISCOUNT','DISCOUNT','Cash discount','NEUTRAL','DEDUCTION','MERCHANT',0,'Discount based on payment method or cash pricing.'),
  ('SERVICE_CHARGE','MERCHANT_CHARGE','FEE','Service charge','NEUTRAL','ADDITION','MERCHANT',1,'Merchant-added service charge.'),
  ('CONVENIENCE_FEE','MERCHANT_CHARGE','FEE','Convenience fee','NEUTRAL','ADDITION','MERCHANT',1,'Merchant-added convenience fee.'),
  ('BOOKING_FEE','MERCHANT_CHARGE','FEE','Booking fee','NEUTRAL','ADDITION','MERCHANT',1,'Merchant-added booking/reservation fee.'),
  ('DELIVERY_CHARGE','MERCHANT_CHARGE','FEE','Delivery charge','NEUTRAL','ADDITION','MERCHANT',1,'Customer-facing delivery charge.'),
  ('SHIPPING_CHARGE','MERCHANT_CHARGE','FEE','Shipping charge','NEUTRAL','ADDITION','MERCHANT',1,'Customer-facing shipping charge.'),
  ('RUSH_FEE','MERCHANT_CHARGE','FEE','Rush fee','NEUTRAL','ADDITION','MERCHANT',1,'Expedited/rush service fee.'),
  ('CARD_SURCHARGE','MERCHANT_CHARGE','FEE','Card surcharge','NEUTRAL','ADDITION','MERCHANT',1,'Payment-method surcharge where lawful and processor-supported.'),
  ('PROCESSOR_FEE','PROCESSOR_ECONOMICS','FEE','Processor fee','OUTFLOW','DEDUCTION','PROCESSOR',1,'Processor-reported payment processing fee.'),
  ('AUTHORIZATION_FEE','PROCESSOR_ECONOMICS','FEE','Authorization fee','OUTFLOW','DEDUCTION','PROCESSOR',1,'Payment authorization/network fee when separately reported.'),
  ('PAYOUT_FEE','PROCESSOR_ECONOMICS','FEE','Payout fee','OUTFLOW','DEDUCTION','PROCESSOR',1,'Fee charged to deliver a payout.'),
  ('PLATFORM_COMMISSION','PLATFORM_ECONOMICS','FEE','Platform commission','OUTFLOW','DEDUCTION','PLATFORM',1,'Third-party platform commission.'),
  ('MARKETPLACE_COMMISSION','PLATFORM_ECONOMICS','FEE','Marketplace commission','OUTFLOW','DEDUCTION','PLATFORM',1,'Marketplace commission.'),
  ('DELIVERY_PLATFORM_COMMISSION','PLATFORM_ECONOMICS','FEE','Delivery platform commission','OUTFLOW','DEDUCTION','PLATFORM',1,'Delivery marketplace/platform commission.'),
  ('REFERRAL_FEE','PLATFORM_ECONOMICS','FEE','Referral fee','OUTFLOW','DEDUCTION','OTHER',1,'Third-party referral/lead fee attributable to transaction.'),
  ('INTEGRITY_FEE','BUILTEGRITY_ECONOMICS','FEE','Builtegrity Integrity Fee','OUTFLOW','DEDUCTION','BUILTEGRITY',1,'Builtegrity transaction-integrity fee paid by merchant.'),
  ('PARTNER_SHARE','PARTNER_ECONOMICS','FEE','Partner share','OUTFLOW','DEDUCTION','PARTNER',1,'Builtegrity/merchant ecosystem partner share when applicable.'),
  ('FULL_REFUND','REFUND','REFUND','Full refund','OUTFLOW','ADJUSTMENT','CUSTOMER',1,'Full customer refund.'),
  ('PARTIAL_REFUND','REFUND','REFUND','Partial refund','OUTFLOW','ADJUSTMENT','CUSTOMER',1,'Partial customer refund.'),
  ('APPLICATION_FEE_REFUND','REFUND','REFUND','Application fee refund','INFLOW','ADJUSTMENT','MERCHANT',1,'Builtegrity/application-fee amount returned to merchant.'),
  ('DISPUTE_PRINCIPAL','DISPUTE','DISPUTE','Disputed principal','OUTFLOW','ADJUSTMENT','CUSTOMER',1,'Principal amount placed into dispute/chargeback.'),
  ('DISPUTE_FEE','DISPUTE','DISPUTE','Dispute fee','OUTFLOW','DEDUCTION','PROCESSOR',1,'Processor/network dispute fee.'),
  ('DISPUTE_RECOVERY','DISPUTE','DISPUTE','Dispute recovery','INFLOW','ADJUSTMENT','MERCHANT',1,'Funds recovered after a dispute.'),
  ('FX_FEE','CURRENCY','FEE','Foreign-exchange fee','OUTFLOW','DEDUCTION','PROCESSOR',1,'Currency conversion/FX fee.'),
  ('CURRENCY_ADJUSTMENT','CURRENCY','ADJUSTMENT','Currency adjustment','NEUTRAL','ADJUSTMENT','OTHER',1,'Currency conversion or settlement adjustment.'),
  ('PROCESSOR_RESERVE','RESERVE_HOLD','RESERVE','Processor reserve','OUTFLOW','DEDUCTION','PROCESSOR',1,'Processor-held reserve amount.'),
  ('ROLLING_RESERVE','RESERVE_HOLD','RESERVE','Rolling reserve','OUTFLOW','DEDUCTION','PROCESSOR',1,'Rolling reserve withholding.'),
  ('TEMPORARY_HOLD','RESERVE_HOLD','RESERVE','Temporary hold','OUTFLOW','DEDUCTION','PROCESSOR',1,'Temporary payment/payout hold.'),
  ('RESERVE_RELEASE','RESERVE_HOLD','RESERVE','Reserve release','INFLOW','ADJUSTMENT','MERCHANT',1,'Previously held reserve released to merchant.'),
  ('TAX_WITHHOLDING','GOVERNMENT','TAX','Tax withholding','OUTFLOW','DEDUCTION','GOVERNMENT',1,'Tax withheld from settlement.'),
  ('STATUTORY_FEE','GOVERNMENT','FEE','Statutory fee','OUTFLOW','DEDUCTION','GOVERNMENT',1,'Government/statutory transaction fee.'),
  ('EMPLOYEE_COMMISSION','LABOR_OBLIGATION','LABOR','Employee commission','OUTFLOW','DEDUCTION','EMPLOYEE',1,'Commission owed to employee/contractor from transaction.'),
  ('FRANCHISE_ROYALTY','FRANCHISE','FRANCHISE','Franchise royalty','OUTFLOW','DEDUCTION','OTHER',1,'Franchise royalty obligation.'),
  ('FRANCHISE_MARKETING_FEE','FRANCHISE','FRANCHISE','Franchise marketing fee','OUTFLOW','DEDUCTION','OTHER',1,'Franchise marketing fund obligation.'),
  ('FRANCHISE_TECH_FEE','FRANCHISE','FRANCHISE','Franchise technology fee','OUTFLOW','DEDUCTION','OTHER',1,'Franchise technology-system fee.'),
  ('COURIER_COST','FULFILLMENT','FULFILLMENT','Courier cost','OUTFLOW','DEDUCTION','OTHER',1,'Courier cost attributable to fulfillment.'),
  ('DELIVERY_PLATFORM_COST','FULFILLMENT','FULFILLMENT','Delivery platform cost','OUTFLOW','DEDUCTION','PLATFORM',1,'Delivery/fulfillment platform cost.'),
  ('SHIPPING_COST','FULFILLMENT','FULFILLMENT','Shipping cost','OUTFLOW','DEDUCTION','OTHER',1,'Merchant shipping/fulfillment cost tied to transaction.'),
  ('GIFT_CARD_REDEMPTION','STORED_VALUE','STORED_VALUE','Gift card redemption','NEUTRAL','NONCASH','MERCHANT',1,'Stored-value gift card used toward purchase.'),
  ('STORE_CREDIT_REDEMPTION','STORED_VALUE','STORED_VALUE','Store credit redemption','NEUTRAL','NONCASH','MERCHANT',1,'Store credit applied to purchase.'),
  ('LOYALTY_REDEMPTION','STORED_VALUE','STORED_VALUE','Loyalty redemption','NEUTRAL','NONCASH','MERCHANT',0,'Loyalty points/value applied to purchase.'),
  ('PROMOTIONAL_CREDIT','STORED_VALUE','STORED_VALUE','Promotional credit','NEUTRAL','NONCASH','MERCHANT',0,'Promotional credit applied to purchase.'),
  ('BNPL_FEE','FINANCING','FINANCING','BNPL fee','OUTFLOW','DEDUCTION','PLATFORM',1,'Buy-now-pay-later provider fee.'),
  ('FINANCING_FEE','FINANCING','FINANCING','Financing fee','OUTFLOW','DEDUCTION','OTHER',1,'Financing/provider fee.'),
  ('INSTALLMENT_ADJUSTMENT','FINANCING','FINANCING','Installment adjustment','NEUTRAL','ADJUSTMENT','OTHER',1,'Adjustment related to installment financing.'),
  ('ROUNDING_ADJUSTMENT','ADJUSTMENT','ADJUSTMENT','Rounding adjustment','NEUTRAL','ADJUSTMENT','OTHER',1,'Rounding adjustment.'),
  ('RECONCILIATION_ADJUSTMENT','ADJUSTMENT','ADJUSTMENT','Reconciliation adjustment','NEUTRAL','ADJUSTMENT','OTHER',1,'Controlled reconciliation correction.'),
  ('MANUAL_ADJUSTMENT','ADJUSTMENT','ADJUSTMENT','Manual adjustment','NEUTRAL','ADJUSTMENT','OTHER',1,'Explicitly recorded manual financial adjustment.'),
  ('MERCHANT_CUSTOM_FEE','CUSTOM','CUSTOM','Merchant-specific fee','OUTFLOW','DEDUCTION','OTHER',1,'Merchant-specific recurring fee/obligation not represented by a standard code.'),
  ('OTHER_THIRD_PARTY_FEE','CUSTOM','CUSTOM','Other third-party fee','OUTFLOW','DEDUCTION','OTHER',1,'Known third-party fee without a narrower standard category.'),
  ('UNKNOWN_OTHER','UNKNOWN','UNKNOWN','Unknown component','NEUTRAL','CONTEXT','UNKNOWN',1,'Captured component not yet classified. Must never be discarded solely because it is unknown.');

CREATE TABLE IF NOT EXISTS merchant_transaction_profiles (
  merchant_id TEXT PRIMARY KEY,
  profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  discovery_mode TEXT NOT NULL DEFAULT 'AUTOMATIC' CHECK (discovery_mode IN ('AUTOMATIC','REVIEW_REQUIRED')),
  stream_detail_level TEXT NOT NULL DEFAULT 'SUMMARY' CHECK (stream_detail_level IN ('SUMMARY','DETAILED')),
  default_alert_mode TEXT NOT NULL DEFAULT 'EXCEPTIONS_ONLY' CHECK (default_alert_mode IN ('EXCEPTIONS_ONLY','MATERIAL_CHANGES','ALL')),
  status TEXT NOT NULL DEFAULT 'LEARNING' CHECK (status IN ('LEARNING','ACTIVE','REVIEW_REQUIRED')),
  first_discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_discovered_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);

CREATE TRIGGER IF NOT EXISTS merchant_transaction_profile_autocreate
AFTER INSERT ON merchants
BEGIN
  INSERT OR IGNORE INTO merchant_transaction_profiles (merchant_id) VALUES (NEW.id);
END;

INSERT OR IGNORE INTO merchant_transaction_profiles (merchant_id)
SELECT id FROM merchants;

CREATE TABLE IF NOT EXISTS merchant_transaction_sources (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  external_account_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('PROCESSOR','POS','ECOMMERCE','MARKETPLACE','ACCOUNTING','FULFILLMENT','OTHER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISCONNECTED','ERROR')),
  capabilities_json TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (merchant_id, source_system, external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_transaction_sources_merchant ON merchant_transaction_sources(merchant_id, status);

CREATE TABLE IF NOT EXISTS merchant_profile_modules (
  merchant_id TEXT NOT NULL,
  module_code TEXT NOT NULL,
  activation_state TEXT NOT NULL DEFAULT 'AUTO_DISCOVERED' CHECK (activation_state IN ('MANDATORY','AUTO_DISCOVERED','CONFIRMED')),
  display_mode TEXT NOT NULL DEFAULT 'SHOW' CHECK (display_mode IN ('SHOW','SUMMARY','HIDE')),
  alert_mode TEXT NOT NULL DEFAULT 'EXCEPTIONS_ONLY' CHECK (alert_mode IN ('EXCEPTIONS_ONLY','MATERIAL_CHANGES','ALL')),
  materiality_threshold_cents INTEGER CHECK (materiality_threshold_cents IS NULL OR materiality_threshold_cents >= 0),
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
  PRIMARY KEY (merchant_id, module_code),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (module_code) REFERENCES transaction_modules(code)
);

INSERT OR IGNORE INTO merchant_profile_modules (merchant_id,module_code,activation_state)
SELECT m.id, tm.code, 'MANDATORY' FROM merchants m CROSS JOIN transaction_modules tm WHERE tm.mandatory = 1;

CREATE TABLE IF NOT EXISTS merchant_component_profiles (
  merchant_id TEXT NOT NULL,
  component_type_code TEXT NOT NULL,
  display_mode TEXT NOT NULL DEFAULT 'SHOW' CHECK (display_mode IN ('SHOW','SUMMARY','HIDE')),
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
  PRIMARY KEY (merchant_id, component_type_code),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (component_type_code) REFERENCES transaction_component_types(code)
);

CREATE TABLE IF NOT EXISTS merchant_component_rules (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_key TEXT NOT NULL,
  normalized_label TEXT,
  component_type_code TEXT NOT NULL,
  rule_status TEXT NOT NULL DEFAULT 'AUTO_DISCOVERED' CHECK (rule_status IN ('AUTO_DISCOVERED','CONFIRMED','NEEDS_REVIEW','RETIRED')),
  calculation_method TEXT NOT NULL DEFAULT 'PROVIDER_REPORTED' CHECK (calculation_method IN ('PROVIDER_REPORTED','FIXED','PERCENTAGE','PASSTHROUGH','UNKNOWN')),
  rate_ppm INTEGER CHECK (rate_ppm IS NULL OR rate_ppm >= 0),
  fixed_amount_cents INTEGER CHECK (fixed_amount_cents IS NULL OR fixed_amount_cents >= 0),
  confidence_ppm INTEGER NOT NULL DEFAULT 0 CHECK (confidence_ppm BETWEEN 0 AND 1000000),
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  metadata_json TEXT,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (component_type_code) REFERENCES transaction_component_types(code),
  UNIQUE (merchant_id, source_system, source_key)
);
CREATE INDEX IF NOT EXISTS idx_component_rules_review ON merchant_component_rules(rule_status, merchant_id);

CREATE TABLE IF NOT EXISTS transaction_components (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  purchase_id TEXT,
  component_type_code TEXT NOT NULL,
  parent_component_id TEXT,
  scope TEXT NOT NULL DEFAULT 'TRANSACTION' CHECK (scope IN ('ORDER','TRANSACTION','PAYMENT','PAYOUT','FULFILLMENT','MERCHANT')),
  basis TEXT NOT NULL DEFAULT 'OBSERVED' CHECK (basis IN ('EXPECTED','ACTUAL','OBSERVED')),
  direction TEXT NOT NULL CHECK (direction IN ('INFLOW','OUTFLOW','NEUTRAL')),
  beneficiary TEXT NOT NULL CHECK (beneficiary IN ('MERCHANT','CUSTOMER','EMPLOYEE','PROCESSOR','BUILTEGRITY','PARTNER','PLATFORM','GOVERNMENT','OTHER','UNKNOWN')),
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  quantity REAL,
  unit_amount_cents INTEGER,
  rate_ppm INTEGER,
  raw_label TEXT,
  display_label TEXT,
  source_system TEXT NOT NULL,
  source_ref TEXT,
  classification_confidence_ppm INTEGER NOT NULL DEFAULT 1000000 CHECK (classification_confidence_ppm BETWEEN 0 AND 1000000),
  status TEXT NOT NULL DEFAULT 'ACCOUNTED' CHECK (status IN ('DETECTED','ACCOUNTED','VOIDED','UNKNOWN')),
  metadata_json TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (purchase_id) REFERENCES purchases(id),
  FOREIGN KEY (component_type_code) REFERENCES transaction_component_types(code),
  FOREIGN KEY (parent_component_id) REFERENCES transaction_components(id)
);
CREATE INDEX IF NOT EXISTS idx_tx_components_transaction ON transaction_components(transaction_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_tx_components_merchant_type ON transaction_components(merchant_id, component_type_code, observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_components_source_ref
  ON transaction_components(transaction_id, source_system, source_ref, component_type_code)
  WHERE source_ref IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS transaction_components_no_update BEFORE UPDATE ON transaction_components
BEGIN SELECT RAISE(ABORT, 'transaction_components are append-only; corrections must be new components'); END;
CREATE TRIGGER IF NOT EXISTS transaction_components_no_delete BEFORE DELETE ON transaction_components
BEGIN SELECT RAISE(ABORT, 'transaction_components are append-only'); END;

CREATE TRIGGER IF NOT EXISTS transaction_components_profile_learning
AFTER INSERT ON transaction_components
BEGIN
  INSERT INTO merchant_component_profiles (merchant_id, component_type_code, occurrence_count, first_seen_at, last_seen_at)
  VALUES (NEW.merchant_id, NEW.component_type_code, 1, NEW.observed_at, NEW.observed_at)
  ON CONFLICT(merchant_id, component_type_code) DO UPDATE SET
    occurrence_count = occurrence_count + 1,
    last_seen_at = excluded.last_seen_at;

  INSERT INTO merchant_profile_modules (merchant_id, module_code, activation_state, occurrence_count, first_seen_at, last_seen_at)
  SELECT NEW.merchant_id, t.module_code,
         CASE WHEN m.mandatory = 1 THEN 'MANDATORY' ELSE 'AUTO_DISCOVERED' END,
         1, NEW.observed_at, NEW.observed_at
  FROM transaction_component_types t JOIN transaction_modules m ON m.code = t.module_code
  WHERE t.code = NEW.component_type_code
  ON CONFLICT(merchant_id, module_code) DO UPDATE SET
    occurrence_count = occurrence_count + 1,
    last_seen_at = excluded.last_seen_at;

  UPDATE merchant_transaction_profiles
     SET last_discovered_at = NEW.observed_at,
         status = CASE WHEN NEW.component_type_code = 'UNKNOWN_OTHER' THEN 'REVIEW_REQUIRED' ELSE status END,
         updated_at = CURRENT_TIMESTAMP
   WHERE merchant_id = NEW.merchant_id;
END;

CREATE TABLE IF NOT EXISTS transaction_artifacts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  purchase_id TEXT,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('RECEIPT','ORDER','INVOICE','CONTRACT','TERMS','FULFILLMENT','PROOF_OF_DELIVERY','REFUND_RECEIPT','DISPUTE_EVIDENCE','PAYOUT_STATEMENT','TAX_DOCUMENT','OTHER')),
  source_system TEXT NOT NULL,
  source_ref TEXT,
  external_url TEXT,
  object_key TEXT,
  sha256 TEXT,
  mime_type TEXT,
  metadata_json TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (purchase_id) REFERENCES purchases(id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_artifacts_transaction ON transaction_artifacts(transaction_id, artifact_type, observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_artifacts_source_ref
  ON transaction_artifacts(transaction_id, source_system, source_ref, artifact_type)
  WHERE source_ref IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS transaction_artifacts_no_update BEFORE UPDATE ON transaction_artifacts
BEGIN SELECT RAISE(ABORT, 'transaction_artifacts are append-only; corrected evidence must be a new artifact'); END;
CREATE TRIGGER IF NOT EXISTS transaction_artifacts_no_delete BEFORE DELETE ON transaction_artifacts
BEGIN SELECT RAISE(ABORT, 'transaction_artifacts are append-only'); END;

CREATE TABLE IF NOT EXISTS transaction_source_objects (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_parent_id TEXT,
  metadata_json TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (merchant_id, source_system, object_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_source_objects_transaction ON transaction_source_objects(transaction_id, source_system);
CREATE TRIGGER IF NOT EXISTS transaction_source_objects_no_update BEFORE UPDATE ON transaction_source_objects
BEGIN SELECT RAISE(ABORT, 'transaction_source_objects are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transaction_source_objects_no_delete BEFORE DELETE ON transaction_source_objects
BEGIN SELECT RAISE(ABORT, 'transaction_source_objects are append-only'); END;

CREATE TABLE IF NOT EXISTS merchant_profile_discovery_events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('SOURCE_CONNECTED','COMPONENT_DISCOVERED','UNKNOWN_COMPONENT','CLASSIFICATION_LEARNED','PROFILE_CONFIRMED','PREFERENCE_CHANGED')),
  source_system TEXT,
  source_ref TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);
CREATE INDEX IF NOT EXISTS idx_profile_discovery_events_merchant ON merchant_profile_discovery_events(merchant_id, created_at);
CREATE TRIGGER IF NOT EXISTS profile_discovery_events_no_update BEFORE UPDATE ON merchant_profile_discovery_events
BEGIN SELECT RAISE(ABORT, 'merchant_profile_discovery_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS profile_discovery_events_no_delete BEFORE DELETE ON merchant_profile_discovery_events
BEGIN SELECT RAISE(ABORT, 'merchant_profile_discovery_events are append-only'); END;

INSERT OR IGNORE INTO id_counters (prefix, next_value) VALUES
  ('CMP',1),('ART',1),('SRC',1),('RULE',1),('DISC',1);

-- Seed expected canonical components for transactions that predate this migration.
INSERT OR IGNORE INTO transaction_components
(id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary, amount_cents, currency, display_label, source_system, source_ref, status)
SELECT 'CMP_EXP_GROSS_' || t.id, t.id, t.merchant_id, t.purchase_id, 'GROSS_PAYMENT', 'PAYMENT', 'EXPECTED', 'INFLOW', 'MERCHANT', t.amount_cents, t.currency,
       'Expected customer payment', 'BUILTEGRITY', 'initial:expected-gross', 'ACCOUNTED'
FROM transactions t;

INSERT OR IGNORE INTO transaction_components
(id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary, amount_cents, currency, display_label, source_system, source_ref, status)
SELECT 'CMP_EXP_FEE_' || t.id, t.id, t.merchant_id, t.purchase_id, 'INTEGRITY_FEE', 'PAYMENT', 'EXPECTED', 'OUTFLOW', 'BUILTEGRITY', t.integrity_fee_earned_cents, t.currency,
       'Expected Builtegrity Integrity Fee', 'BUILTEGRITY', 'initial:expected-integrity-fee', 'ACCOUNTED'
FROM transactions t
WHERE t.integrity_fee_earned_cents > 0;

INSERT OR IGNORE INTO transaction_components
(id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary, amount_cents, currency, display_label, source_system, source_ref, status)
SELECT 'CMP_ACT_PROC_' || t.id, t.id, t.merchant_id, t.purchase_id, 'PROCESSOR_FEE', 'PAYMENT', 'ACTUAL', 'OUTFLOW', 'PROCESSOR', t.processor_fee_cents, t.currency,
       'Processor fee', t.processor, 'backfill:processor-fee', 'ACCOUNTED'
FROM transactions t WHERE t.processor_fee_cents IS NOT NULL AND t.processor_fee_cents > 0;

INSERT OR IGNORE INTO transaction_components
(id, transaction_id, merchant_id, purchase_id, component_type_code, scope, basis, direction, beneficiary, amount_cents, currency, display_label, source_system, source_ref, status)
SELECT 'CMP_ACT_PAYOUT_' || t.id, t.id, t.merchant_id, t.purchase_id, 'GROSS_PAYMENT', 'PAYOUT', 'ACTUAL', 'INFLOW', 'MERCHANT', t.actual_merchant_net_cents, t.currency,
       'Merchant payout contribution', t.processor, 'backfill:payout-contribution', 'ACCOUNTED'
FROM transactions t WHERE t.actual_merchant_net_cents IS NOT NULL;

CREATE VIEW IF NOT EXISTS transaction_component_stream AS
SELECT
  c.id,
  c.transaction_id,
  c.merchant_id,
  c.purchase_id,
  c.component_type_code,
  t.module_code,
  t.family,
  t.name AS component_name,
  t.accounting_required,
  c.scope,
  c.basis,
  c.direction,
  c.beneficiary,
  c.amount_cents,
  c.currency,
  c.quantity,
  c.unit_amount_cents,
  c.rate_ppm,
  c.raw_label,
  COALESCE(c.display_label, t.name) AS display_label,
  COALESCE(cp.display_mode, mp.display_mode, 'SHOW') AS display_mode,
  c.source_system,
  c.source_ref,
  c.status,
  c.observed_at
FROM transaction_components c
JOIN transaction_component_types t ON t.code = c.component_type_code
LEFT JOIN merchant_component_profiles cp ON cp.merchant_id = c.merchant_id AND cp.component_type_code = c.component_type_code
LEFT JOIN merchant_profile_modules mp ON mp.merchant_id = c.merchant_id AND mp.module_code = t.module_code;
