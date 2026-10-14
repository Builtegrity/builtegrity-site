PRAGMA foreign_keys = ON;

-- BG_STANDARD_V1
-- Merchant-facing rule:
--   $0.01-$1.00   = $0.01 base + 0.10%
--   $1.01-$5.00   = $0.02 base + 0.10%
--   $5.01-$10.00  = $0.03 base + 0.10%
--   $10.01+        = $0.05 base + 0.10%
-- No subscription. No setup fee. No upper pricing cap.
-- Fractional cents are never rounded up against a merchant. They accrue in micros and
-- are settled from later successful payments. $1.00 = 1,000,000 micros; 1 cent = 10,000 micros.

ALTER TABLE pricing_versions ADD COLUMN pricing_model TEXT NOT NULL DEFAULT 'LEGACY_FLOOR'
  CHECK (pricing_model IN ('LEGACY_FLOOR','AMOUNT_BANDS'));
ALTER TABLE pricing_versions ADD COLUMN uncapped INTEGER NOT NULL DEFAULT 0
  CHECK (uncapped IN (0,1));

CREATE TABLE IF NOT EXISTS pricing_amount_bands (
  id TEXT PRIMARY KEY,
  pricing_version_id TEXT NOT NULL,
  min_amount_cents INTEGER NOT NULL CHECK (min_amount_cents >= 1),
  max_amount_cents INTEGER CHECK (max_amount_cents IS NULL OR max_amount_cents >= min_amount_cents),
  base_fee_cents INTEGER NOT NULL CHECK (base_fee_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pricing_version_id) REFERENCES pricing_versions(id),
  UNIQUE (pricing_version_id, min_amount_cents)
);
CREATE INDEX IF NOT EXISTS idx_pricing_amount_bands_lookup
  ON pricing_amount_bands(pricing_version_id, min_amount_cents, max_amount_cents);

-- Preserve historical PRICE-2026-10-V1 exactly as charged; activate the pricing structure
-- approved after the low-ticket and uncapped-upside pressure tests.
UPDATE pricing_versions
SET status='RETIRED', retired_at=COALESCE(retired_at, CURRENT_TIMESTAMP)
WHERE status='ACTIVE' AND currency='USD';

INSERT INTO pricing_versions (
  id, status, currency, percentage_bps, minimum_cents, maximum_cents,
  density_mode, effective_from, notes, pricing_model, uncapped
) VALUES (
  'BG_STANDARD_V1', 'ACTIVE', 'USD', 10, 0, 9007199254740991,
  'FLAT', '2026-10-13T20:43:00-04:00',
  'Progressive base fee plus 0.10%. Uncapped. Fractional-cent percentage amounts accrue exactly in micros and are never rounded upward per transaction.',
  'AMOUNT_BANDS', 1
);

INSERT INTO pricing_amount_bands (id, pricing_version_id, min_amount_cents, max_amount_cents, base_fee_cents) VALUES
  ('BGV1-BAND-001','BG_STANDARD_V1',1,100,1),
  ('BGV1-BAND-002','BG_STANDARD_V1',101,500,2),
  ('BGV1-BAND-003','BG_STANDARD_V1',501,1000,3),
  ('BGV1-BAND-004','BG_STANDARD_V1',1001,NULL,5);

ALTER TABLE transactions ADD COLUMN pricing_base_cents INTEGER NOT NULL DEFAULT 0 CHECK (pricing_base_cents >= 0);
ALTER TABLE transactions ADD COLUMN pricing_fee_micros INTEGER CHECK (pricing_fee_micros IS NULL OR pricing_fee_micros >= 0);
ALTER TABLE transactions ADD COLUMN integrity_fee_earned_micros INTEGER CHECK (integrity_fee_earned_micros IS NULL OR integrity_fee_earned_micros >= 0);
ALTER TABLE transactions ADD COLUMN pricing_fee_residual_micros INTEGER NOT NULL DEFAULT 0
  CHECK (pricing_fee_residual_micros >= 0 AND pricing_fee_residual_micros < 10000);
ALTER TABLE transactions ADD COLUMN pricing_uncapped INTEGER NOT NULL DEFAULT 0 CHECK (pricing_uncapped IN (0,1));
ALTER TABLE transactions ADD COLUMN pricing_carry_reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK (pricing_carry_reserved_cents >= 0);
ALTER TABLE transactions ADD COLUMN pricing_carry_settled_cents INTEGER NOT NULL DEFAULT 0 CHECK (pricing_carry_settled_cents >= 0);
ALTER TABLE transactions ADD COLUMN pricing_carry_released_at TEXT;

-- Historical rows get an exact-micros representation of the already immutable historical cent fee.
UPDATE transactions
SET pricing_fee_micros = COALESCE(pricing_fee_micros, integrity_fee_earned_cents * 10000),
    integrity_fee_earned_micros = COALESCE(integrity_fee_earned_micros, integrity_fee_earned_cents * 10000)
WHERE pricing_fee_micros IS NULL OR integrity_fee_earned_micros IS NULL;

CREATE TABLE IF NOT EXISTS merchant_fee_carry (
  merchant_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  available_micros INTEGER NOT NULL DEFAULT 0 CHECK (available_micros >= 0),
  lifetime_accrued_micros INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_accrued_micros >= 0),
  lifetime_reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_reserved_micros >= 0),
  lifetime_released_micros INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_released_micros >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (merchant_id, currency),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);

CREATE TABLE IF NOT EXISTS merchant_fee_carry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('ACCRUED','RESERVED','SETTLED','RELEASED')),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  balance_after_micros INTEGER NOT NULL CHECK (balance_after_micros >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_fee_carry_events_merchant
  ON merchant_fee_carry_events(merchant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_carry_event_once
  ON merchant_fee_carry_events(transaction_id, event_type)
  WHERE event_type IN ('ACCRUED','SETTLED');
CREATE TRIGGER IF NOT EXISTS merchant_fee_carry_events_no_update BEFORE UPDATE ON merchant_fee_carry_events
BEGIN SELECT RAISE(ABORT, 'merchant fee carry events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS merchant_fee_carry_events_no_delete BEFORE DELETE ON merchant_fee_carry_events
BEGIN SELECT RAISE(ABORT, 'merchant fee carry events are append-only'); END;

-- Exact residual revenue is earned only when the protected payment actually succeeds.
-- payment_at is set once, so this trigger is naturally idempotent.
CREATE TRIGGER IF NOT EXISTS transactions_accrue_fractional_fee_on_success
AFTER UPDATE OF payment_at ON transactions
WHEN OLD.payment_at IS NULL
 AND NEW.payment_at IS NOT NULL
 AND NEW.pricing_fee_residual_micros > 0
BEGIN
  INSERT INTO merchant_fee_carry (
    merchant_id, currency, available_micros, lifetime_accrued_micros, updated_at
  ) VALUES (
    NEW.merchant_id, NEW.currency, NEW.pricing_fee_residual_micros, NEW.pricing_fee_residual_micros, CURRENT_TIMESTAMP
  )
  ON CONFLICT(merchant_id, currency) DO UPDATE SET
    available_micros = merchant_fee_carry.available_micros + excluded.available_micros,
    lifetime_accrued_micros = merchant_fee_carry.lifetime_accrued_micros + excluded.lifetime_accrued_micros,
    updated_at = CURRENT_TIMESTAMP;

  INSERT INTO merchant_fee_carry_events (
    merchant_id, transaction_id, event_type, amount_micros, balance_after_micros
  )
  SELECT NEW.merchant_id, NEW.id, 'ACCRUED', NEW.pricing_fee_residual_micros, available_micros
  FROM merchant_fee_carry
  WHERE merchant_id=NEW.merchant_id AND currency=NEW.currency;
END;

-- A carry reservation is an atomic DB operation. The trigger rejects any attempt to reserve
-- more previously-earned fractional revenue than exists. This prevents concurrent checkouts
-- from collecting the same carry twice.
CREATE TRIGGER IF NOT EXISTS transactions_reserve_fee_carry
BEFORE UPDATE OF pricing_carry_reserved_cents ON transactions
WHEN NEW.pricing_carry_reserved_cents > OLD.pricing_carry_reserved_cents
BEGIN
  SELECT CASE WHEN NEW.pricing_carry_settled_cents > 0
    THEN RAISE(ABORT, 'settled carry cannot be increased') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM merchant_fee_carry c
    WHERE c.merchant_id=NEW.merchant_id AND c.currency=NEW.currency
      AND c.available_micros >= ((NEW.pricing_carry_reserved_cents - OLD.pricing_carry_reserved_cents) * 10000)
  ) THEN RAISE(ABORT, 'insufficient merchant fee carry') END;

  UPDATE merchant_fee_carry
     SET available_micros = available_micros - ((NEW.pricing_carry_reserved_cents - OLD.pricing_carry_reserved_cents) * 10000),
         lifetime_reserved_micros = lifetime_reserved_micros + ((NEW.pricing_carry_reserved_cents - OLD.pricing_carry_reserved_cents) * 10000),
         updated_at=CURRENT_TIMESTAMP
   WHERE merchant_id=NEW.merchant_id AND currency=NEW.currency;
END;

CREATE TRIGGER IF NOT EXISTS transactions_log_fee_carry_reservation
AFTER UPDATE OF pricing_carry_reserved_cents ON transactions
WHEN NEW.pricing_carry_reserved_cents > OLD.pricing_carry_reserved_cents
BEGIN
  INSERT INTO merchant_fee_carry_events (
    merchant_id, transaction_id, event_type, amount_micros, balance_after_micros
  )
  SELECT NEW.merchant_id, NEW.id, 'RESERVED',
         (NEW.pricing_carry_reserved_cents - OLD.pricing_carry_reserved_cents) * 10000,
         available_micros
    FROM merchant_fee_carry
   WHERE merchant_id=NEW.merchant_id AND currency=NEW.currency;
END;

-- If an abandoned/failed checkout is released before payment succeeds, its carry returns to
-- the merchant's available carry balance. Settled carry is immutable and cannot be released.
CREATE TRIGGER IF NOT EXISTS transactions_release_fee_carry
BEFORE UPDATE OF pricing_carry_reserved_cents ON transactions
WHEN NEW.pricing_carry_reserved_cents < OLD.pricing_carry_reserved_cents
BEGIN
  SELECT CASE WHEN OLD.pricing_carry_settled_cents > 0 OR OLD.payment_at IS NOT NULL
    THEN RAISE(ABORT, 'earned/settled carry cannot be released') END;
  SELECT CASE WHEN NEW.pricing_carry_reserved_cents <> 0
    THEN RAISE(ABORT, 'carry release must release the full reservation') END;

  INSERT INTO merchant_fee_carry (merchant_id, currency, available_micros, lifetime_released_micros, updated_at)
  VALUES (
    NEW.merchant_id, NEW.currency,
    OLD.pricing_carry_reserved_cents * 10000,
    OLD.pricing_carry_reserved_cents * 10000,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(merchant_id, currency) DO UPDATE SET
    available_micros = merchant_fee_carry.available_micros + excluded.available_micros,
    lifetime_released_micros = merchant_fee_carry.lifetime_released_micros + excluded.lifetime_released_micros,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS transactions_log_fee_carry_release
AFTER UPDATE OF pricing_carry_reserved_cents ON transactions
WHEN NEW.pricing_carry_reserved_cents < OLD.pricing_carry_reserved_cents
BEGIN
  INSERT INTO merchant_fee_carry_events (
    merchant_id, transaction_id, event_type, amount_micros, balance_after_micros
  )
  SELECT NEW.merchant_id, NEW.id, 'RELEASED',
         (OLD.pricing_carry_reserved_cents - NEW.pricing_carry_reserved_cents) * 10000,
         available_micros
    FROM merchant_fee_carry
   WHERE merchant_id=NEW.merchant_id AND currency=NEW.currency;
END;

CREATE TRIGGER IF NOT EXISTS transactions_settle_reserved_carry
AFTER UPDATE OF payment_at ON transactions
WHEN OLD.payment_at IS NULL
 AND NEW.payment_at IS NOT NULL
 AND NEW.pricing_carry_reserved_cents > 0
BEGIN
  UPDATE transactions
     SET pricing_carry_settled_cents = pricing_carry_reserved_cents
   WHERE id=NEW.id AND pricing_carry_settled_cents=0;

  INSERT OR IGNORE INTO merchant_fee_carry_events (
    merchant_id, transaction_id, event_type, amount_micros, balance_after_micros
  )
  SELECT NEW.merchant_id, NEW.id, 'SETTLED', NEW.pricing_carry_reserved_cents * 10000,
         COALESCE((SELECT available_micros FROM merchant_fee_carry WHERE merchant_id=NEW.merchant_id AND currency=NEW.currency),0);
END;

-- New pricing records must carry the exact fee representation as well as the processor-cent amount.
CREATE TRIGGER IF NOT EXISTS transactions_validate_bg_standard_v1_insert
BEFORE INSERT ON transactions
WHEN NEW.pricing_version_id='BG_STANDARD_V1'
BEGIN
  SELECT CASE WHEN NEW.pricing_fee_micros IS NULL OR NEW.integrity_fee_earned_micros IS NULL
    THEN RAISE(ABORT, 'BG_STANDARD_V1 exact-micros pricing snapshot is required') END;
  SELECT CASE WHEN NEW.pricing_fee_micros <> NEW.integrity_fee_earned_micros
    THEN RAISE(ABORT, 'BG_STANDARD_V1 earned micros must equal calculated micros') END;
  SELECT CASE WHEN NEW.pricing_calculated_cents <> CAST(NEW.pricing_fee_micros / 10000 AS INTEGER)
    THEN RAISE(ABORT, 'BG_STANDARD_V1 processor-cent fee must round down from exact micros') END;
  SELECT CASE WHEN NEW.pricing_fee_residual_micros <> (NEW.pricing_fee_micros % 10000)
    THEN RAISE(ABORT, 'BG_STANDARD_V1 residual micros are inconsistent') END;
  SELECT CASE WHEN NEW.pricing_uncapped <> 1
    THEN RAISE(ABORT, 'BG_STANDARD_V1 must remain uncapped') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pricing_amount_bands b
    WHERE b.pricing_version_id='BG_STANDARD_V1'
      AND NEW.amount_cents >= b.min_amount_cents
      AND (b.max_amount_cents IS NULL OR NEW.amount_cents <= b.max_amount_cents)
      AND b.base_fee_cents=NEW.pricing_base_cents
  ) THEN RAISE(ABORT, 'BG_STANDARD_V1 amount band snapshot is invalid') END;
END;

CREATE TRIGGER IF NOT EXISTS transactions_bg_standard_v1_pricing_no_mutation
BEFORE UPDATE OF pricing_base_cents, pricing_fee_micros, integrity_fee_earned_micros,
                 pricing_fee_residual_micros, pricing_uncapped
ON transactions
WHEN OLD.pricing_version_id='BG_STANDARD_V1' AND (
  NEW.pricing_base_cents <> OLD.pricing_base_cents OR
  NEW.pricing_fee_micros <> OLD.pricing_fee_micros OR
  NEW.integrity_fee_earned_micros <> OLD.integrity_fee_earned_micros OR
  NEW.pricing_fee_residual_micros <> OLD.pricing_fee_residual_micros OR
  NEW.pricing_uncapped <> OLD.pricing_uncapped
)
BEGIN SELECT RAISE(ABORT, 'BG_STANDARD_V1 exact pricing is immutable once created'); END;

-- Economics guardrails: the lowest possible band must remain self-sustaining.
INSERT INTO pricing_economic_guardrails (
  id, pricing_version_id, technical_reserve_micros, human_case_cost_reserve_micros,
  human_touch_target_ppm, human_touch_mature_ppm, fee_reversal_reserve_ppm,
  human_touch_warn_ppm, human_touch_critical_ppm, effective_rate_warn_bps, notes
) VALUES (
  'GUARD-BG-STANDARD-V1', 'BG_STANDARD_V1',
  400, 15000000, 100, 50, 5000,
  200, 500, 150,
  'Hard low-end guardrail. Plan for <=0.04 cent technical variable cost, <=1 in 10,000 transactions requiring a $15 human case, and 0.5% platform-error credit reserve. Merchant refunds do not reverse an earned integrity fee. Warn on low-ticket effective rates above 1.50%.'
);

UPDATE financial_safety_policy
SET minimum_floor_margin_ppm=800000,
    human_touch_orange_ppm=200,
    human_touch_red_ppm=500,
    updated_at=CURRENT_TIMESTAMP
WHERE id='GLOBAL';

DROP VIEW IF EXISTS pricing_floor_health;
CREATE VIEW pricing_floor_health AS
WITH active AS (
  SELECT p.* FROM pricing_versions p WHERE p.status='ACTIVE'
), floor_band AS (
  SELECT b.*
  FROM pricing_amount_bands b
  JOIN active p ON p.id=b.pricing_version_id
  WHERE b.min_amount_cents=(
    SELECT MIN(x.min_amount_cents) FROM pricing_amount_bands x WHERE x.pricing_version_id=b.pricing_version_id
  )
), base AS (
  SELECT
    p.id AS pricing_version_id,
    p.currency,
    CASE WHEN p.pricing_model='AMOUNT_BANDS' THEN COALESCE(b.base_fee_cents,0) ELSE p.minimum_cents END AS minimum_cents,
    p.percentage_bps,
    p.maximum_cents,
    p.uncapped,
    g.technical_reserve_micros,
    g.human_case_cost_reserve_micros,
    g.human_touch_target_ppm,
    g.human_touch_mature_ppm,
    g.fee_reversal_reserve_ppm,
    g.human_touch_warn_ppm,
    g.human_touch_critical_ppm,
    g.effective_rate_warn_bps,
    CASE WHEN p.pricing_model='AMOUNT_BANDS'
      THEN (COALESCE(b.base_fee_cents,0) * 10000) + (COALESCE(b.min_amount_cents,1) * p.percentage_bps)
      ELSE p.minimum_cents * 10000
    END AS floor_revenue_micros
  FROM active p
  JOIN pricing_economic_guardrails g ON g.pricing_version_id=p.id
  LEFT JOIN floor_band b ON b.pricing_version_id=p.id
)
SELECT
  base.*,
  CAST((human_case_cost_reserve_micros * human_touch_target_ppm) / 1000000 AS INTEGER) AS target_human_reserve_micros,
  CAST((floor_revenue_micros * fee_reversal_reserve_ppm) / 1000000 AS INTEGER) AS floor_reversal_reserve_micros,
  floor_revenue_micros
    - technical_reserve_micros
    - CAST((human_case_cost_reserve_micros * human_touch_target_ppm) / 1000000 AS INTEGER)
    - CAST((floor_revenue_micros * fee_reversal_reserve_ppm) / 1000000 AS INTEGER) AS floor_planning_contribution_micros,
  CAST(1000000.0 * (
    floor_revenue_micros
      - technical_reserve_micros
      - CAST((human_case_cost_reserve_micros * human_touch_target_ppm) / 1000000 AS INTEGER)
      - CAST((floor_revenue_micros * fee_reversal_reserve_ppm) / 1000000 AS INTEGER)
  ) / NULLIF(floor_revenue_micros,0) AS INTEGER) AS floor_planning_margin_ppm
FROM base;

DROP VIEW IF EXISTS merchant_pricing_monthly_summary;
CREATE VIEW merchant_pricing_monthly_summary AS
SELECT
  merchant_id,
  strftime('%Y-%m', payment_at) AS month,
  COUNT(*) AS successful_protected_transactions,
  SUM(COALESCE(customer_paid_cents, amount_cents)) AS protected_volume_cents,
  SUM(COALESCE(integrity_fee_earned_micros, integrity_fee_earned_cents * 10000)) AS earned_fee_micros,
  ROUND(SUM(COALESCE(integrity_fee_earned_micros, integrity_fee_earned_cents * 10000)) / 10000.0, 2) AS earned_fee_cents,
  SUM(integrity_fee_collected_cents) AS collected_fee_cents,
  ROUND(1.0 * SUM(COALESCE(customer_paid_cents, amount_cents)) / COUNT(*), 2) AS average_ticket_cents,
  ROUND(
    10000.0 * (SUM(COALESCE(integrity_fee_earned_micros, integrity_fee_earned_cents * 10000)) / 10000.0) /
    NULLIF(SUM(COALESCE(customer_paid_cents, amount_cents)),0),
    2
  ) AS effective_fee_bps
FROM transactions
WHERE payment_at IS NOT NULL
GROUP BY merchant_id, strftime('%Y-%m', payment_at);

-- The model review is version-specific. A pricing change may never inherit an old attestation silently.
INSERT INTO financial_model_reviews (
  id, pricing_version_id, cost_model_id,
  reviewed_provider_pricing, reviewed_processor_responsibility,
  actor_ref, notes, reviewed_at
)
SELECT
  'FMR-2026-10-13-BG-STANDARD-V1', 'BG_STANDARD_V1', c.id,
  1, 1,
  'SYSTEM:BG-STANDARD-V1-PRESSURE-TEST',
  'BG_STANDARD_V1 low-ticket, high-volume, uncapped upside and processor-responsibility review. Merchant refunds do not reverse earned Builtegrity integrity fees; platform-error credits are reserved separately.',
  '2026-10-13T20:43:00-04:00'
FROM transaction_cost_models c
WHERE c.status='ACTIVE'
ORDER BY c.created_at DESC, c.id DESC
LIMIT 1;
