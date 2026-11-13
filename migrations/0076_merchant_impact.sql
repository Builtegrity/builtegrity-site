-- Optional merchant-funded Builtegrity Impact. Deliberately independent of
-- transaction pricing, fee entitlements, platform receipts and customer checkout.
-- No automatic donation/payment or provider API call is authorized by this schema.
CREATE TABLE IF NOT EXISTS merchant_impact_policies (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  cause_code TEXT NOT NULL CHECK (cause_code IN ('REFORESTATION','CARBON_REMOVAL','COMMUNITY_RELIEF')),
  contribution_mode TEXT NOT NULL CHECK (contribution_mode IN ('BPS','FLAT_CENTS')),
  contribution_value INTEGER NOT NULL CHECK (contribution_value BETWEEN 1 AND 100000),
  effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  created_by TEXT NOT NULL,
  CHECK (contribution_mode <> 'BPS' OR contribution_value <= 1000),
  CHECK (ended_at IS NULL OR datetime(ended_at)>=datetime(effective_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_impact_one_active_policy
  ON merchant_impact_policies(merchant_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_impact_policy_history
  ON merchant_impact_policies(merchant_id,effective_at DESC);

-- Historical paid transactions are not opted in retroactively: policy selection
-- compares the processor payment timestamp to the merchant's policy window.
CREATE TABLE IF NOT EXISTS merchant_impact_commitments (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  policy_id TEXT NOT NULL REFERENCES merchant_impact_policies(id),
  transaction_amount_cents INTEGER NOT NULL CHECK (transaction_amount_cents>0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  payment_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_impact_commitments_merchant
  ON merchant_impact_commitments(merchant_id,recorded_at DESC);

-- Append-only valuation snapshots keyed by monotonically increasing cumulative
-- customer refunds. The highest refund snapshot is authoritative; late/duplicate
-- webhook deliveries cannot double-count amounts or restore pre-refund valuations.
-- These are unfunded estimates until separate, verified provider receipts exist.
CREATE TABLE IF NOT EXISTS merchant_impact_valuations (
  transaction_id TEXT NOT NULL REFERENCES merchant_impact_commitments(transaction_id),
  cumulative_refunded_cents INTEGER NOT NULL CHECK (cumulative_refunded_cents>=0),
  eligible_amount_cents INTEGER NOT NULL CHECK (eligible_amount_cents>=0),
  commitment_cents INTEGER NOT NULL CHECK (commitment_cents>=0),
  calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(transaction_id,cumulative_refunded_cents)
);
CREATE VIEW IF NOT EXISTS merchant_impact_current_valuations AS
 SELECT v.transaction_id,v.cumulative_refunded_cents,v.eligible_amount_cents,
        v.commitment_cents,v.calculated_at
 FROM merchant_impact_valuations v
 WHERE v.cumulative_refunded_cents=(
   SELECT MAX(v2.cumulative_refunded_cents)
   FROM merchant_impact_valuations v2 WHERE v2.transaction_id=v.transaction_id
 );

-- Reserved for future provider integration. Only confirmed external funding
-- evidence should be inserted; no merchant-facing endpoint can create receipts.
CREATE TABLE IF NOT EXISTS merchant_impact_funding_receipts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  cause_code TEXT NOT NULL CHECK (cause_code IN ('REFORESTATION','CARBON_REMOVAL','COMMUNITY_RELIEF')),
  provider TEXT NOT NULL,
  external_reference TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents>0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  verified_at TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider,external_reference)
);
CREATE INDEX IF NOT EXISTS idx_impact_funding_merchant
 ON merchant_impact_funding_receipts(merchant_id,verified_at DESC);

CREATE TRIGGER IF NOT EXISTS impact_commitments_no_update
 BEFORE UPDATE ON merchant_impact_commitments BEGIN
 SELECT RAISE(ABORT,'impact commitments are append-only');
 END;
CREATE TRIGGER IF NOT EXISTS impact_commitments_no_delete
 BEFORE DELETE ON merchant_impact_commitments BEGIN
 SELECT RAISE(ABORT,'impact commitments are append-only');
 END;
CREATE TRIGGER IF NOT EXISTS impact_valuations_no_update
 BEFORE UPDATE ON merchant_impact_valuations BEGIN
 SELECT RAISE(ABORT,'impact valuations are append-only');
 END;
CREATE TRIGGER IF NOT EXISTS impact_valuations_no_delete
 BEFORE DELETE ON merchant_impact_valuations BEGIN
 SELECT RAISE(ABORT,'impact valuations are append-only');
 END;
CREATE TRIGGER IF NOT EXISTS impact_funding_no_update
 BEFORE UPDATE ON merchant_impact_funding_receipts BEGIN
 SELECT RAISE(ABORT,'verified impact funding receipts are append-only');
 END;
CREATE TRIGGER IF NOT EXISTS impact_funding_no_delete
 BEFORE DELETE ON merchant_impact_funding_receipts BEGIN
 SELECT RAISE(ABORT,'verified impact funding receipts are append-only');
 END;
