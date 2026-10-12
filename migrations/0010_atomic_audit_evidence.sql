PRAGMA foreign_keys = ON;

-- These are minimal system-proof events. Richer customer/Stripe events may be
-- appended by application code, but these records are committed in the same D1
-- statement as the state transition so evidence cannot be lost after the update.
CREATE TRIGGER IF NOT EXISTS transactions_consent_audit_evidence
AFTER UPDATE OF consent_accepted ON transactions
WHEN OLD.consent_accepted = 0 AND NEW.consent_accepted = 1
BEGIN
  INSERT OR IGNORE INTO transaction_events
    (id, transaction_id, event_type, source, source_event_id, event_data_json)
  VALUES (
    'AUD-CONSENT-' || NEW.id,
    NEW.id,
    'CONSENT_COMMITTED',
    'SYSTEM',
    'consent:' || NEW.id || ':' || COALESCE(NEW.terms_snapshot_sha256, ''),
    json_object(
      'terms_version', NEW.terms_version,
      'terms_snapshot_sha256', NEW.terms_snapshot_sha256,
      'consent_method', NEW.consent_method
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS transactions_checkout_audit_evidence
AFTER UPDATE OF stripe_checkout_session_id ON transactions
WHEN NEW.stripe_checkout_session_id IS NOT NULL
  AND NEW.stripe_checkout_session_id IS NOT OLD.stripe_checkout_session_id
BEGIN
  INSERT OR IGNORE INTO transaction_events
    (id, transaction_id, event_type, source, source_event_id, event_data_json)
  VALUES (
    'AUD-CHECKOUT-' || NEW.id || '-' || NEW.stripe_checkout_session_id,
    NEW.id,
    'CHECKOUT_SESSION_LINKED',
    'SYSTEM',
    'checkout:' || NEW.stripe_checkout_session_id,
    json_object('checkout_session_id', NEW.stripe_checkout_session_id)
  );
END;
