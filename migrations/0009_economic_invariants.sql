PRAGMA foreign_keys = ON;

-- Permanent V1 economic invariants.
-- Builtegrity is paid by the merchant from transaction proceeds, never by the consumer.
-- Stripe Connect V1 must collect the Builtegrity fee as a Stripe application fee on a direct charge.

CREATE TRIGGER IF NOT EXISTS transactions_require_stripe_application_fee_on_insert
BEFORE INSERT ON transactions
WHEN EXISTS (
  SELECT 1
  FROM merchants m
  WHERE m.id = NEW.merchant_id
    AND m.integration_mode = 'STRIPE_CONNECT'
)
AND COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
BEGIN
  SELECT RAISE(ABORT, 'STRIPE_CONNECT transactions must collect the Builtegrity fee from merchant proceeds via STRIPE_APPLICATION_FEE');
END;

CREATE TRIGGER IF NOT EXISTS transactions_require_stripe_application_fee_on_update
BEFORE UPDATE OF fee_collection_method, merchant_id ON transactions
WHEN EXISTS (
  SELECT 1
  FROM merchants m
  WHERE m.id = NEW.merchant_id
    AND m.integration_mode = 'STRIPE_CONNECT'
)
AND COALESCE(NEW.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
BEGIN
  SELECT RAISE(ABORT, 'STRIPE_CONNECT transactions must collect the Builtegrity fee from merchant proceeds via STRIPE_APPLICATION_FEE');
END;

-- Guard against changing a merchant to Stripe Connect while existing transactions use
-- a different fee collection method.
CREATE TRIGGER IF NOT EXISTS merchants_require_compatible_fee_collection
BEFORE UPDATE OF integration_mode ON merchants
WHEN NEW.integration_mode = 'STRIPE_CONNECT'
AND EXISTS (
  SELECT 1
  FROM transactions t
  WHERE t.merchant_id = NEW.id
    AND COALESCE(t.fee_collection_method, '') <> 'STRIPE_APPLICATION_FEE'
)
BEGIN
  SELECT RAISE(ABORT, 'Merchant cannot use STRIPE_CONNECT while transactions use a non-application-fee collection method');
END;
