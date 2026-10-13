PRAGMA foreign_keys = ON;

-- Reject future-dated evidence. Otherwise a mistaken or malicious timestamp could make stale evidence appear fresh indefinitely.
CREATE TRIGGER IF NOT EXISTS financial_position_reject_future_insert
BEFORE INSERT ON financial_position_snapshots
WHEN datetime(NEW.captured_at) > datetime('now', '+5 minutes')
BEGIN
  SELECT RAISE(ABORT, 'financial position captured_at cannot be materially future-dated');
END;

CREATE TRIGGER IF NOT EXISTS processor_balance_reject_future_insert
BEFORE INSERT ON processor_platform_balance_snapshots
WHEN datetime(NEW.captured_at) > datetime('now', '+5 minutes')
BEGIN
  SELECT RAISE(ABORT, 'processor balance captured_at cannot be materially future-dated');
END;

CREATE TRIGGER IF NOT EXISTS financial_model_review_reject_future_insert
BEFORE INSERT ON financial_model_reviews
WHEN datetime(NEW.reviewed_at) > datetime('now', '+5 minutes')
BEGIN
  SELECT RAISE(ABORT, 'financial model review reviewed_at cannot be materially future-dated');
END;

-- Defense in depth for new commitments. Runtime authorization is the first gate;
-- D1 rejects a new transaction if enforced financial state says no or if the machine decision is stale.
CREATE TRIGGER IF NOT EXISTS transactions_require_fresh_financial_safety
BEFORE INSERT ON transactions
WHEN EXISTS (
  SELECT 1 FROM financial_safety_state s
  WHERE s.id='GLOBAL'
    AND s.enforcement_active=1
    AND (
      s.transaction_creation_allowed<>1 OR
      datetime(s.evaluated_at) < datetime('now', '-30 minutes')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'transaction rejected by enforced financial safety state');
END;

-- A merchant cannot become ACTIVE while growth is financially braked or the safety decision is stale.
CREATE TRIGGER IF NOT EXISTS merchants_require_financial_safety_on_active_insert
BEFORE INSERT ON merchants
WHEN NEW.status='ACTIVE' AND EXISTS (
  SELECT 1 FROM financial_safety_state s
  WHERE s.id='GLOBAL'
    AND s.enforcement_active=1
    AND (
      s.merchant_onboarding_allowed<>1 OR
      datetime(s.evaluated_at) < datetime('now', '-30 minutes')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'merchant activation rejected by enforced financial safety state');
END;

CREATE TRIGGER IF NOT EXISTS merchants_require_financial_safety_on_active_update
BEFORE UPDATE OF status ON merchants
WHEN NEW.status='ACTIVE' AND OLD.status<>'ACTIVE' AND EXISTS (
  SELECT 1 FROM financial_safety_state s
  WHERE s.id='GLOBAL'
    AND s.enforcement_active=1
    AND (
      s.merchant_onboarding_allowed<>1 OR
      datetime(s.evaluated_at) < datetime('now', '-30 minutes')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'merchant activation rejected by enforced financial safety state');
END;
