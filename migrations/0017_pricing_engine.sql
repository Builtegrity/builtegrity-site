PRAGMA foreign_keys = ON;

-- Builtegrity pricing is infrastructure pricing, not merchant plans.
-- The server selects one active global pricing version per currency and snapshots the result on each transaction.
-- Merchant-supplied fee amounts are never authoritative.

CREATE TABLE IF NOT EXISTS pricing_versions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  currency TEXT NOT NULL,
  percentage_bps INTEGER NOT NULL CHECK (percentage_bps >= 0),
  minimum_cents INTEGER NOT NULL CHECK (minimum_cents >= 0),
  maximum_cents INTEGER NOT NULL CHECK (maximum_cents >= minimum_cents),
  density_mode TEXT NOT NULL DEFAULT 'FLAT' CHECK (density_mode IN ('FLAT','BANDS')),
  effective_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_one_active_currency
  ON pricing_versions(currency)
  WHERE status = 'ACTIVE';

-- PRICE-V1: same rule for every merchant. 15 bps = 0.15%, 5-cent minimum, $10 maximum.
INSERT OR IGNORE INTO pricing_versions (
  id, status, currency, percentage_bps, minimum_cents, maximum_cents,
  density_mode, effective_from, notes
) VALUES (
  'PRICE-2026-10-V1', 'ACTIVE', 'USD', 15, 5, 1000,
  'FLAT', '2026-10-12T00:00:00Z',
  'Universal V1 infrastructure price. No merchant plans. Density escalation intentionally disabled pending observed retention and willingness-to-pay data.'
);

-- Preserve the economics of records created before versioned pricing existed.
INSERT OR IGNORE INTO pricing_versions (
  id, status, currency, percentage_bps, minimum_cents, maximum_cents,
  density_mode, effective_from, retired_at, notes
) VALUES (
  'PRICE-LEGACY-UNVERSIONED', 'RETIRED', 'USD', 0, 0, 100000000,
  'FLAT', '2026-01-01T00:00:00Z', '2026-10-12T00:00:00Z',
  'Historical placeholder only. Existing transaction fee amounts remain authoritative for records created before PRICE-2026-10-V1.'
);

-- Future capability only. V1 intentionally has no escalating density bands.
-- A later global pricing version may opt into BANDS after real merchant data justifies it.
CREATE TABLE IF NOT EXISTS pricing_density_bands (
  id TEXT PRIMARY KEY,
  pricing_version_id TEXT NOT NULL,
  start_ordinal INTEGER NOT NULL CHECK (start_ordinal >= 1),
  end_ordinal INTEGER CHECK (end_ordinal IS NULL OR end_ordinal >= start_ordinal),
  minimum_cents INTEGER NOT NULL CHECK (minimum_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pricing_version_id) REFERENCES pricing_versions(id),
  UNIQUE (pricing_version_id, start_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_pricing_density_version
  ON pricing_density_bands(pricing_version_id, start_ordinal);

ALTER TABLE transactions ADD COLUMN pricing_version_id TEXT;
ALTER TABLE transactions ADD COLUMN pricing_percentage_bps INTEGER;
ALTER TABLE transactions ADD COLUMN pricing_minimum_cents INTEGER;
ALTER TABLE transactions ADD COLUMN pricing_maximum_cents INTEGER;
ALTER TABLE transactions ADD COLUMN pricing_density_band_id TEXT;
ALTER TABLE transactions ADD COLUMN pricing_calculated_cents INTEGER;
ALTER TABLE transactions ADD COLUMN pricing_locked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_pricing_version
  ON transactions(pricing_version_id);

-- Existing production records keep their historical fee exactly as recorded.
UPDATE transactions
SET pricing_version_id = 'PRICE-LEGACY-UNVERSIONED',
    pricing_percentage_bps = 0,
    pricing_minimum_cents = 0,
    pricing_maximum_cents = 100000000,
    pricing_calculated_cents = integrity_fee_earned_cents,
    pricing_locked_at = COALESCE(created_at, CURRENT_TIMESTAMP)
WHERE pricing_version_id IS NULL;

-- A versioned transaction must snapshot a complete internally consistent price.
CREATE TRIGGER IF NOT EXISTS transactions_validate_pricing_insert
BEFORE INSERT ON transactions
WHEN NEW.pricing_version_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.pricing_locked_at IS NULL
    THEN RAISE(ABORT, 'versioned transaction pricing must be locked at creation') END;
  SELECT CASE WHEN NEW.pricing_percentage_bps IS NULL OR NEW.pricing_minimum_cents IS NULL OR
                   NEW.pricing_maximum_cents IS NULL OR NEW.pricing_calculated_cents IS NULL
    THEN RAISE(ABORT, 'versioned transaction pricing snapshot is incomplete') END;
  SELECT CASE WHEN NEW.pricing_calculated_cents <> NEW.integrity_fee_earned_cents
    THEN RAISE(ABORT, 'integrity fee must equal server-calculated pricing snapshot') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pricing_versions p
    WHERE p.id = NEW.pricing_version_id
      AND p.currency = NEW.currency
      AND p.percentage_bps = NEW.pricing_percentage_bps
      AND p.minimum_cents = NEW.pricing_minimum_cents
      AND p.maximum_cents = NEW.pricing_maximum_cents
  ) THEN RAISE(ABORT, 'transaction pricing snapshot does not match pricing version') END;
END;

-- Once a transaction is priced, history is immutable even if a later global pricing version is introduced.
CREATE TRIGGER IF NOT EXISTS transactions_pricing_no_mutation
BEFORE UPDATE OF pricing_version_id, pricing_percentage_bps, pricing_minimum_cents,
                 pricing_maximum_cents, pricing_density_band_id,
                 pricing_calculated_cents, pricing_locked_at, integrity_fee_earned_cents
ON transactions
WHEN OLD.pricing_locked_at IS NOT NULL AND (
  COALESCE(NEW.pricing_version_id,'') <> COALESCE(OLD.pricing_version_id,'') OR
  COALESCE(NEW.pricing_percentage_bps,-1) <> COALESCE(OLD.pricing_percentage_bps,-1) OR
  COALESCE(NEW.pricing_minimum_cents,-1) <> COALESCE(OLD.pricing_minimum_cents,-1) OR
  COALESCE(NEW.pricing_maximum_cents,-1) <> COALESCE(OLD.pricing_maximum_cents,-1) OR
  COALESCE(NEW.pricing_density_band_id,'') <> COALESCE(OLD.pricing_density_band_id,'') OR
  COALESCE(NEW.pricing_calculated_cents,-1) <> COALESCE(OLD.pricing_calculated_cents,-1) OR
  COALESCE(NEW.pricing_locked_at,'') <> COALESCE(OLD.pricing_locked_at,'') OR
  NEW.integrity_fee_earned_cents <> OLD.integrity_fee_earned_cents
)
BEGIN
  SELECT RAISE(ABORT, 'transaction pricing is immutable once locked');
END;

-- Longevity assumptions are explicit, measurable, and replaceable with observed data over time.
-- $1.00 = 1,000,000 micros. Rates use parts-per-million (ppm): 500 ppm = 0.05%.
CREATE TABLE IF NOT EXISTS pricing_economic_guardrails (
  id TEXT PRIMARY KEY,
  pricing_version_id TEXT NOT NULL,
  technical_reserve_micros INTEGER NOT NULL CHECK (technical_reserve_micros >= 0),
  human_case_cost_reserve_micros INTEGER NOT NULL CHECK (human_case_cost_reserve_micros >= 0),
  human_touch_target_ppm INTEGER NOT NULL CHECK (human_touch_target_ppm >= 0),
  human_touch_mature_ppm INTEGER NOT NULL CHECK (human_touch_mature_ppm >= 0),
  fee_reversal_reserve_ppm INTEGER NOT NULL CHECK (fee_reversal_reserve_ppm >= 0),
  human_touch_warn_ppm INTEGER NOT NULL CHECK (human_touch_warn_ppm >= 0),
  human_touch_critical_ppm INTEGER NOT NULL CHECK (human_touch_critical_ppm >= human_touch_warn_ppm),
  effective_rate_warn_bps INTEGER NOT NULL CHECK (effective_rate_warn_bps >= 0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pricing_version_id) REFERENCES pricing_versions(id)
);

INSERT OR IGNORE INTO pricing_economic_guardrails (
  id, pricing_version_id, technical_reserve_micros, human_case_cost_reserve_micros,
  human_touch_target_ppm, human_touch_mature_ppm, fee_reversal_reserve_ppm,
  human_touch_warn_ppm, human_touch_critical_ppm, effective_rate_warn_bps, notes
) VALUES (
  'GUARD-PRICE-V1', 'PRICE-2026-10-V1',
  6170, 15000000, 500, 100, 20000,
  1000, 1500, 100,
  'Planning reserves: $0.00617 technical lifecycle reserve, $15 outsourced case reserve, 0.05% human-touch target, 0.01% mature target, 2% fee-reversal reserve. Warn if human touch exceeds 0.10%, critical at 0.15%. Effective merchant rate watch threshold is 1.00% of protected volume.'
);

-- At the 5-cent floor under the conservative planning assumptions:
-- revenue 50,000 micros - technical 6,170 - human 7,500 - reversal reserve 1,000 = 35,330 micros contribution.
CREATE VIEW IF NOT EXISTS pricing_floor_health AS
SELECT
  p.id AS pricing_version_id,
  p.currency,
  p.minimum_cents,
  p.percentage_bps,
  p.maximum_cents,
  g.technical_reserve_micros,
  g.human_case_cost_reserve_micros,
  g.human_touch_target_ppm,
  g.human_touch_mature_ppm,
  g.fee_reversal_reserve_ppm,
  (p.minimum_cents * 10000) AS floor_revenue_micros,
  CAST((g.human_case_cost_reserve_micros * g.human_touch_target_ppm) / 1000000 AS INTEGER) AS target_human_reserve_micros,
  CAST((p.minimum_cents * 10000 * g.fee_reversal_reserve_ppm) / 1000000 AS INTEGER) AS floor_reversal_reserve_micros,
  (p.minimum_cents * 10000)
    - g.technical_reserve_micros
    - CAST((g.human_case_cost_reserve_micros * g.human_touch_target_ppm) / 1000000 AS INTEGER)
    - CAST((p.minimum_cents * 10000 * g.fee_reversal_reserve_ppm) / 1000000 AS INTEGER) AS floor_planning_contribution_micros,
  CAST(1000000.0 * (
    (p.minimum_cents * 10000)
      - g.technical_reserve_micros
      - CAST((g.human_case_cost_reserve_micros * g.human_touch_target_ppm) / 1000000 AS INTEGER)
      - CAST((p.minimum_cents * 10000 * g.fee_reversal_reserve_ppm) / 1000000 AS INTEGER)
  ) / NULLIF((p.minimum_cents * 10000),0) AS INTEGER) AS floor_planning_margin_ppm
FROM pricing_versions p
JOIN pricing_economic_guardrails g ON g.pricing_version_id = p.id
WHERE p.status = 'ACTIVE';

-- Monthly merchant economics: used to measure whether the universal floor feels too expensive for low-ticket merchants.
-- payment_at, rather than current payment_status, preserves successful-payment counts after later refunds.
CREATE VIEW IF NOT EXISTS merchant_pricing_monthly_summary AS
SELECT
  merchant_id,
  strftime('%Y-%m', payment_at) AS month,
  COUNT(*) AS successful_protected_transactions,
  SUM(COALESCE(customer_paid_cents, amount_cents)) AS protected_volume_cents,
  SUM(COALESCE(pricing_calculated_cents, integrity_fee_earned_cents)) AS earned_fee_cents,
  SUM(integrity_fee_collected_cents) AS collected_fee_cents,
  ROUND(1.0 * SUM(COALESCE(customer_paid_cents, amount_cents)) / COUNT(*), 2) AS average_ticket_cents,
  ROUND(
    10000.0 * SUM(COALESCE(pricing_calculated_cents, integrity_fee_earned_cents)) /
    NULLIF(SUM(COALESCE(customer_paid_cents, amount_cents)),0),
    2
  ) AS effective_fee_bps
FROM transactions
WHERE payment_at IS NOT NULL
GROUP BY merchant_id, strftime('%Y-%m', payment_at);

-- Shadow-test the previously considered 5/6/7/8-cent progressive density floor without charging it.
-- This gives Builtegrity evidence before any future global pricing version changes.
CREATE VIEW IF NOT EXISTS pricing_density_shadow_transactions AS
WITH ranked AS (
  SELECT
    t.id AS transaction_id,
    t.merchant_id,
    strftime('%Y-%m', t.payment_at) AS month,
    COALESCE(t.customer_paid_cents, t.amount_cents) AS amount_cents,
    ROW_NUMBER() OVER (
      PARTITION BY t.merchant_id, strftime('%Y-%m', t.payment_at)
      ORDER BY t.payment_at, t.id
    ) AS monthly_ordinal
  FROM transactions t
  WHERE t.payment_at IS NOT NULL
)
SELECT
  transaction_id,
  merchant_id,
  month,
  amount_cents,
  monthly_ordinal,
  CASE
    WHEN monthly_ordinal <= 25000 THEN 5
    WHEN monthly_ordinal <= 100000 THEN 6
    WHEN monthly_ordinal <= 500000 THEN 7
    ELSE 8
  END AS shadow_minimum_cents,
  MIN(
    1000,
    MAX(
      CAST((amount_cents * 15 + 5000) / 10000 AS INTEGER),
      CASE
        WHEN monthly_ordinal <= 25000 THEN 5
        WHEN monthly_ordinal <= 100000 THEN 6
        WHEN monthly_ordinal <= 500000 THEN 7
        ELSE 8
      END
    )
  ) AS shadow_fee_cents
FROM ranked;

CREATE VIEW IF NOT EXISTS pricing_density_shadow_monthly AS
SELECT
  merchant_id,
  month,
  COUNT(*) AS successful_protected_transactions,
  SUM(amount_cents) AS protected_volume_cents,
  SUM(shadow_fee_cents) AS shadow_fee_cents,
  ROUND(10000.0 * SUM(shadow_fee_cents) / NULLIF(SUM(amount_cents),0), 2) AS shadow_effective_fee_bps
FROM pricing_density_shadow_transactions
GROUP BY merchant_id, month;
