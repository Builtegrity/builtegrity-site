PRAGMA foreign_keys = ON;

-- Stripe Checkout Sessions can remain payable for at most 24 hours. A previously earned carry
-- cent embedded in a Checkout application fee must therefore remain exclusively reserved until
-- the associated Session is certainly dead; otherwise the same carry could be reused on a second
-- checkout and later collected twice if the first checkout also succeeds.
ALTER TABLE transactions ADD COLUMN stripe_checkout_session_attached_at TEXT;

CREATE TRIGGER IF NOT EXISTS transactions_stamp_checkout_session_attachment
AFTER UPDATE OF stripe_checkout_session_id ON transactions
WHEN OLD.stripe_checkout_session_id IS NULL AND NEW.stripe_checkout_session_id IS NOT NULL
BEGIN
  UPDATE transactions
     SET stripe_checkout_session_attached_at=COALESCE(stripe_checkout_session_attached_at,CURRENT_TIMESTAMP)
   WHERE id=NEW.id;
END;

-- Replace the earlier release guard with a Checkout-aware version. The extra one-hour buffer
-- deliberately exceeds Stripe's documented 24-hour maximum session lifetime.
DROP TRIGGER IF EXISTS transactions_release_fee_carry;
CREATE TRIGGER transactions_release_fee_carry
BEFORE UPDATE OF pricing_carry_reserved_cents ON transactions
WHEN NEW.pricing_carry_reserved_cents < OLD.pricing_carry_reserved_cents
BEGIN
  SELECT CASE WHEN OLD.pricing_carry_settled_cents > 0 OR OLD.payment_at IS NOT NULL
    THEN RAISE(ABORT, 'earned/settled carry cannot be released') END;
  SELECT CASE WHEN NEW.pricing_carry_reserved_cents <> 0
    THEN RAISE(ABORT, 'carry release must release the full reservation') END;
  SELECT CASE WHEN OLD.stripe_checkout_session_id IS NOT NULL AND (
      OLD.stripe_checkout_session_attached_at IS NULL OR
      datetime(OLD.stripe_checkout_session_attached_at,'+25 hours') > CURRENT_TIMESTAMP
    ) THEN RAISE(ABORT, 'carry remains locked while its Stripe Checkout session may still be payable') END;

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

CREATE INDEX IF NOT EXISTS idx_transactions_abandoned_carry
  ON transactions(payment_at,pricing_carry_settled_cents,pricing_carry_reserved_cents,stripe_checkout_session_attached_at);
