PRAGMA foreign_keys = ON;

-- Keep cumulative processor truth so repeated/out-of-order application-fee refund events
-- can be converted into append-only deltas without double counting.
ALTER TABLE transactions ADD COLUMN application_fee_refunded_cents INTEGER NOT NULL DEFAULT 0
  CHECK (application_fee_refunded_cents >= 0);

CREATE TRIGGER IF NOT EXISTS transactions_application_fee_refund_not_over_gross_insert
BEFORE INSERT ON transactions
WHEN NEW.application_fee_gross_confirmed_cents > 0
 AND NEW.application_fee_refunded_cents > NEW.application_fee_gross_confirmed_cents
BEGIN
  SELECT RAISE(ABORT, 'application-fee refunds cannot exceed confirmed gross application fee');
END;

CREATE TRIGGER IF NOT EXISTS transactions_application_fee_refund_not_over_gross_update
BEFORE UPDATE OF application_fee_refunded_cents, application_fee_gross_confirmed_cents ON transactions
WHEN NEW.application_fee_gross_confirmed_cents > 0
 AND NEW.application_fee_refunded_cents > NEW.application_fee_gross_confirmed_cents
BEGIN
  SELECT RAISE(ABORT, 'application-fee refunds cannot exceed confirmed gross application fee');
END;
