PRAGMA foreign_keys = ON;

-- Monthly statement V2 makes record/revenue classification and fee attribution explicit.
-- "ACCOUNTED" (integrity) and "PROTECTED" (record/revenue class) are different axes.
-- Exact transaction fee entitlement and processor cash collection are also different facts.

ALTER TABLE monthly_statements ADD COLUMN protected_count INTEGER NOT NULL DEFAULT 0
  CHECK (protected_count >= 0);
ALTER TABLE monthly_statements ADD COLUMN transaction_fee_entitlement_micros INTEGER NOT NULL DEFAULT 0
  CHECK (transaction_fee_entitlement_micros >= 0);
ALTER TABLE monthly_statements ADD COLUMN application_fee_gross_cents INTEGER NOT NULL DEFAULT 0
  CHECK (application_fee_gross_cents >= 0);
ALTER TABLE monthly_statements ADD COLUMN carry_settled_cents INTEGER NOT NULL DEFAULT 0
  CHECK (carry_settled_cents >= 0);

ALTER TABLE monthly_statement_items ADD COLUMN record_classification TEXT
  CHECK (record_classification IS NULL OR record_classification IN ('PENDING_PROTECTED','PROTECTED','OBSERVED','IMPORTED','FEE_EXCEPTION'));
ALTER TABLE monthly_statement_items ADD COLUMN transaction_fee_entitlement_micros INTEGER NOT NULL DEFAULT 0
  CHECK (transaction_fee_entitlement_micros >= 0);
ALTER TABLE monthly_statement_items ADD COLUMN application_fee_gross_cents INTEGER NOT NULL DEFAULT 0
  CHECK (application_fee_gross_cents >= 0);
ALTER TABLE monthly_statement_items ADD COLUMN carry_settled_cents INTEGER NOT NULL DEFAULT 0
  CHECK (carry_settled_cents >= 0);
ALTER TABLE monthly_statement_items ADD COLUMN fee_residual_generated_micros INTEGER NOT NULL DEFAULT 0
  CHECK (fee_residual_generated_micros >= 0 AND fee_residual_generated_micros < 10000);

-- Rebuild the generated-summary immutability trigger so V2 semantic fields cannot be
-- rewritten after statement generation. V1 rows remain immutable under the same rule.
DROP TRIGGER IF EXISTS monthly_statements_snapshot_immutable;
CREATE TRIGGER monthly_statements_snapshot_immutable
BEFORE UPDATE ON monthly_statements
WHEN OLD.generated_at IS NOT NULL AND (
  NEW.scope_type <> OLD.scope_type OR
  NEW.scope_id <> OLD.scope_id OR
  NEW.period_start <> OLD.period_start OR
  NEW.period_end_exclusive <> OLD.period_end_exclusive OR
  NEW.period_label <> OLD.period_label OR
  NEW.statement_version <> OLD.statement_version OR
  NEW.transaction_count <> OLD.transaction_count OR
  NEW.merchant_count <> OLD.merchant_count OR
  NEW.protected_volume_cents <> OLD.protected_volume_cents OR
  NEW.protected_count <> OLD.protected_count OR
  NEW.builtegrity_fee_cents <> OLD.builtegrity_fee_cents OR
  NEW.transaction_fee_entitlement_micros <> OLD.transaction_fee_entitlement_micros OR
  NEW.application_fee_gross_cents <> OLD.application_fee_gross_cents OR
  NEW.carry_settled_cents <> OLD.carry_settled_cents OR
  NEW.exception_count <> OLD.exception_count OR
  NEW.accounted_count <> OLD.accounted_count OR
  COALESCE(NEW.object_key, '') <> COALESCE(OLD.object_key, '') OR
  COALESCE(NEW.pdf_sha256, '') <> COALESCE(OLD.pdf_sha256, '') OR
  COALESCE(NEW.pdf_byte_length, -1) <> COALESCE(OLD.pdf_byte_length, -1) OR
  COALESCE(NEW.generated_at, '') <> COALESCE(OLD.generated_at, '')
)
BEGIN
  SELECT RAISE(ABORT, 'generated monthly statement snapshot is immutable');
END;

-- This view is intentionally explicit about the three distinct fee concepts:
-- exact fee entitlement attributed to a protected transaction, gross processor cash
-- collected on its application fee (which can include prior carry), and carry settled.
CREATE VIEW IF NOT EXISTS monthly_statement_v2_source AS
SELECT
  t.id AS transaction_id,
  t.merchant_id,
  t.purchase_id,
  t.customer_id,
  t.amount_cents,
  t.currency,
  t.record_classification,
  t.payment_status,
  t.processor_payout_status AS payout_status,
  t.integrity_status,
  t.exception_status,
  t.payment_at,
  CASE WHEN t.record_classification='PROTECTED' THEN t.amount_cents ELSE 0 END AS protected_amount_cents,
  CASE WHEN t.record_classification='PROTECTED' THEN COALESCE(t.integrity_fee_earned_micros,0) ELSE 0 END AS transaction_fee_entitlement_micros,
  CASE WHEN t.record_classification='PROTECTED' THEN COALESCE(t.application_fee_gross_confirmed_cents,0) ELSE 0 END AS application_fee_gross_cents,
  CASE WHEN t.record_classification='PROTECTED' THEN COALESCE(t.integrity_fee_collected_cents,0) ELSE 0 END AS current_retained_fee_cents,
  CASE WHEN t.record_classification='PROTECTED' THEN COALESCE(t.pricing_carry_settled_cents,0) ELSE 0 END AS carry_settled_cents,
  CASE WHEN t.record_classification='PROTECTED' THEN COALESCE(t.pricing_fee_residual_micros,0) ELSE 0 END AS fee_residual_generated_micros,
  t.created_at
FROM transactions t;
