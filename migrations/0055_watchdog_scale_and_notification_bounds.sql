PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Time-sensitive transaction watchdogs must not depend on a "latest N transactions" scan.
-- This view is the indexed source of currently observable anomalies. Persistent old anomalies do
-- not block discovery of newer anomalies because the runtime excludes already-open alert keys.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_transactions_payment_pending_age
  ON transactions(lifecycle_status, payment_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_transactions_payment_processor_audit
  ON transactions(payment_status, payment_at, stripe_payment_intent_id, stripe_charge_id, stripe_balance_transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_fee_audit
  ON transactions(payment_status, payment_at, fee_collection_method, application_fee_gross_confirmed_cents);
CREATE INDEX IF NOT EXISTS idx_transactions_payout_audit
  ON transactions(processor_payout_status, expected_payout_arrival, payment_at, stripe_payout_id);
CREATE INDEX IF NOT EXISTS idx_transactions_integrity_audit
  ON transactions(lifecycle_status, exception_status, integrity_status);
CREATE INDEX IF NOT EXISTS idx_merchants_active_processor
  ON merchants(status, processor, processor_account_id, id);

DROP VIEW IF EXISTS watchdog_transaction_anomalies;
CREATE VIEW watchdog_transaction_anomalies AS
SELECT
  'tx:stale-payment-pending:'||t.id AS alert_key,
  'STALE_PAYMENT_PENDING' AS anomaly_code,
  'TRANSACTION' AS category,
  'WARN' AS severity,
  'TRANSACTION' AS subject_type,
  t.id AS subject_id,
  NULL AS exception_type,
  NULL AS exception_summary,
  datetime(t.updated_at,'+24 hours') AS due_at,
  t.id||' has remained PAYMENT_PENDING for more than 24 hours.' AS message
FROM transactions t
WHERE t.lifecycle_status='PAYMENT_PENDING'
  AND lower(COALESCE(t.payment_status,''))<>'succeeded'
  AND datetime(t.updated_at) <= datetime('now','-24 hours')

UNION ALL

SELECT
  'tx:complete-not-accounted:'||t.id,
  'COMPLETE_NOT_ACCOUNTED',
  'TRANSACTION',
  'CRITICAL',
  'TRANSACTION',
  t.id,
  NULL,
  NULL,
  datetime(t.updated_at),
  t.id||' is COMPLETE with no open exception but is not ACCOUNTED.'
FROM transactions t
WHERE t.lifecycle_status='COMPLETE'
  AND t.exception_status='NONE'
  AND t.integrity_status<>'ACCOUNTED'

UNION ALL

SELECT
  'tx:missing-processor-records:'||t.id,
  'MISSING_PROCESSOR_RECORDS',
  'TRANSACTION',
  'CRITICAL',
  'TRANSACTION',
  t.id,
  NULL,
  NULL,
  datetime(t.payment_at,'+1 hour'),
  t.id||' is marked paid but required Stripe processor records are still incomplete after one hour.'
FROM transactions t
WHERE lower(COALESCE(t.payment_status,''))='succeeded'
  AND t.payment_at IS NOT NULL
  AND datetime(t.payment_at) <= datetime('now','-1 hour')
  AND (t.stripe_payment_intent_id IS NULL OR t.stripe_charge_id IS NULL OR t.stripe_balance_transaction_id IS NULL)

UNION ALL

SELECT
  'tx:fee-shortfall:'||t.id,
  'FEE_SHORTFALL',
  'ECONOMICS',
  'ERROR',
  'TRANSACTION',
  t.id,
  'UNEXPECTED_FEE',
  'Expected gross Builtegrity application fee has not been fully confirmed after payment success.',
  datetime(t.payment_at,'+1 hour'),
  t.id||' has a gross application-fee shortfall after successful payment.'
FROM transactions t
WHERE lower(COALESCE(t.payment_status,''))='succeeded'
  AND t.payment_at IS NOT NULL
  AND datetime(t.payment_at) <= datetime('now','-1 hour')
  AND t.fee_collection_method='STRIPE_APPLICATION_FEE'
  AND COALESCE(t.application_fee_gross_confirmed_cents,0) <
      (COALESCE(t.integrity_fee_earned_cents,0)+COALESCE(t.pricing_carry_reserved_cents,0))

UNION ALL

SELECT
  'tx:payout-failed:'||t.id,
  'PAYOUT_FAILED',
  'PAYOUT',
  'CRITICAL',
  'TRANSACTION',
  t.id,
  'PAYOUT_FAILED',
  'Processor payout is marked failed; watchdog ensured the transaction exception exists.',
  datetime(COALESCE(t.updated_at,t.created_at)),
  t.id||' is attached to a failed processor payout.'
FROM transactions t
WHERE lower(COALESCE(t.processor_payout_status,''))='failed'

UNION ALL

SELECT
  'tx:payout-overdue:'||t.id,
  'PAYOUT_OVERDUE',
  'PAYOUT',
  'ERROR',
  'TRANSACTION',
  t.id,
  'EXPECTED_PAYOUT_NOT_FOUND',
  'Expected automatic payout has not been reconciled within the watchdog tolerance window.',
  CASE
    WHEN t.expected_payout_arrival IS NOT NULL THEN datetime(t.expected_payout_arrival,'+12 hours')
    ELSE datetime(t.payment_at,'+72 hours')
  END,
  t.id||' has not reconciled to the expected automatic payout on time.'
FROM transactions t
JOIN merchants m ON m.id=t.merchant_id
WHERE lower(COALESCE(t.processor_payout_status,''))<>'paid'
  AND (
    (t.expected_payout_arrival IS NOT NULL AND datetime(t.expected_payout_arrival) <= datetime('now','-12 hours'))
    OR
    (t.expected_payout_arrival IS NULL AND t.stripe_payout_id IS NULL AND m.automatic_payouts_required=1
      AND t.payment_at IS NOT NULL AND datetime(t.payment_at) <= datetime('now','-72 hours'))
  );

DROP VIEW IF EXISTS watchdog_merchant_anomalies;
CREATE VIEW watchdog_merchant_anomalies AS
SELECT
  'merchant:processor-account:'||m.id AS alert_key,
  'MERCHANT' AS category,
  'CRITICAL' AS severity,
  'MERCHANT' AS subject_type,
  m.id AS subject_id,
  m.id||' is ACTIVE but has no Stripe connected account ID.' AS message
FROM merchants m
WHERE m.status='ACTIVE' AND m.processor='STRIPE' AND m.processor_account_id IS NULL;

-- Cursor state is intentionally tiny and mutable: it exists only to make deep provider probes
-- eventually cover every merchant rather than probing the first N forever.
CREATE TABLE IF NOT EXISTS watchdog_cursors (
  cursor_name TEXT PRIMARY KEY,
  cursor_value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO watchdog_cursors(cursor_name,cursor_value) VALUES ('STRIPE_ACCOUNT_PROBE',NULL);

-- Stale payment is a customer follow-up, not an excuse for infinite email spend. The first stale
-- alert may send one actionable reminder; the link remains usable/re-creatable through the normal
-- payment flow, while the watchdog continues observing the underlying condition without daily mail.
UPDATE resolution_playbooks
SET repeat_notice_minutes=52560000
WHERE code='CUSTOMER_PAYMENT_INCOMPLETE';
