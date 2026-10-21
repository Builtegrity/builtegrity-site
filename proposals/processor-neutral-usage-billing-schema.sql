-- BUILTEGRITY USAGE BILLING SCHEMA CANDIDATE — NOT A D1 MIGRATION.
-- Not applied or released. Confirm latest canonical migration/version, existing merchant
-- PK types, D1 compatibility and tenant authorization before promoting to migrations/.
-- Do not alter existing PROTECTED application-fee paths.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bg_observation_connections (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('stripe','square')),
  processor_account_id TEXT NOT NULL,
  authorization_mode TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','RESTRICTED','REVOKED','ERROR')),
  event_cursor TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (merchant_id, provider, processor_account_id)
);
CREATE INDEX IF NOT EXISTS bg_observation_connections_by_merchant ON bg_observation_connections (merchant_id,status);

CREATE TABLE IF NOT EXISTS bg_processor_event_inbox (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  processor_account_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_event_type TEXT NOT NULL,
  provider_occurred_at TEXT,
  payload_sha256 TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','PROCESSED','RETRY','REJECTED')),
  UNIQUE(provider,processor_account_id,provider_event_id)
);
CREATE INDEX IF NOT EXISTS bg_processor_event_inbox_status ON bg_processor_event_inbox(status,received_at);

CREATE TABLE IF NOT EXISTS bg_usage_agreements (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  version TEXT NOT NULL,
  pricing_policy_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(length(currency)=3),
  signed_evidence_ref TEXT NOT NULL,
  billing_authorization_ref TEXT NOT NULL,
  billing_customer_ref TEXT,
  effective_from TEXT NOT NULL,
  effective_until TEXT,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','SUSPENDED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(effective_until IS NULL OR effective_until > effective_from),
  UNIQUE(merchant_id,version)
);
CREATE INDEX IF NOT EXISTS bg_usage_agreements_active ON bg_usage_agreements(merchant_id,status,effective_from);

CREATE TABLE IF NOT EXISTS bg_usage_entitlements (
  entitlement_key TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  processor_account_id TEXT NOT NULL,
  processor_transaction_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL REFERENCES bg_usage_agreements(id),
  pricing_policy_id TEXT NOT NULL,
  source_classification TEXT NOT NULL CHECK(source_classification IN ('PROTECTED','OBSERVED','IMPORTED')),
  collection_method TEXT NOT NULL CHECK(collection_method IN ('USAGE_BILLING','APPLICATION_FEE')),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  fee_micros INTEGER NOT NULL CHECK(fee_micros >= 0),
  earned_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(merchant_id,provider,processor_account_id,processor_transaction_id,agreement_id,collection_method)
);
CREATE INDEX IF NOT EXISTS bg_usage_entitlements_merchant ON bg_usage_entitlements(merchant_id,earned_at);

CREATE TABLE IF NOT EXISTS bg_usage_adjustments (
  adjustment_key TEXT PRIMARY KEY,
  entitlement_key TEXT NOT NULL REFERENCES bg_usage_entitlements(entitlement_key),
  merchant_id TEXT NOT NULL,
  provider_adjustment_ref TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('REFUND','DISPUTE','MANUAL_APPROVED_CREDIT')),
  delta_micros INTEGER NOT NULL CHECK(delta_micros < 0),
  occurred_at TEXT NOT NULL,
  UNIQUE(entitlement_key,provider_adjustment_ref,reason)
);
CREATE INDEX IF NOT EXISTS bg_usage_adjustments_entitlement ON bg_usage_adjustments(entitlement_key);

CREATE TABLE IF NOT EXISTS bg_usage_invoice_lines (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  entitlement_key TEXT REFERENCES bg_usage_entitlements(entitlement_key),
  adjustment_key TEXT REFERENCES bg_usage_adjustments(adjustment_key),
  invoice_period TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  billing_provider TEXT NOT NULL,
  billing_provider_line_ref TEXT,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','SUBMITTED','ACCEPTED','REJECTED','REVERSED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((entitlement_key IS NOT NULL AND adjustment_key IS NULL) OR (entitlement_key IS NULL AND adjustment_key IS NOT NULL)),
  UNIQUE(entitlement_key,invoice_period),
  UNIQUE(adjustment_key,invoice_period)
);
CREATE INDEX IF NOT EXISTS bg_usage_invoice_lines_merchant ON bg_usage_invoice_lines(merchant_id,invoice_period);

CREATE TABLE IF NOT EXISTS bg_usage_collections (
  collection_key TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  billing_provider TEXT NOT NULL,
  provider_invoice_ref TEXT NOT NULL,
  provider_payment_ref TEXT,
  currency TEXT NOT NULL CHECK(length(currency)=3),
  collected_micros INTEGER NOT NULL DEFAULT 0 CHECK(collected_micros >= 0),
  status TEXT NOT NULL CHECK(status IN ('OPEN','PAID','FAILED','VOID','REFUNDED')),
  observed_at TEXT NOT NULL,
  UNIQUE(billing_provider,provider_invoice_ref,provider_payment_ref)
);
CREATE INDEX IF NOT EXISTS bg_usage_collections_merchant ON bg_usage_collections(merchant_id,observed_at);

-- IMPORTANT BEFORE DEPLOY:
-- 1. No table-level assumption that all payment data is billable.
-- 2. The service layer verifies merchant-scoped refs and agreement effective dates.
-- 3. A transaction is assigned ONE contracted collection method; both paths never accrue.
-- 4. Signed processor webhooks, verified billing webhooks and provider reconciliation are required.
-- 5. Credits cannot exceed original entitlement in aggregate; enforce transactionally at write.
-- 6. Invoice acceptance is NOT cash settlement. Track authoritative payment status separately.
-- 7. Deleting or rewriting earned ledger entries must be denied at the application boundary.
-- 8. Implement foreign keys to existing merchant/transaction tables only after confirming schema.
