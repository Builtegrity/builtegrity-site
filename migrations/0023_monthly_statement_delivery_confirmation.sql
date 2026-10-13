PRAGMA foreign_keys = ON;

-- A successful Resend API submission is not proof of mailbox delivery.
-- The runtime currently transitions a submitted delivery through DELIVERED after the API call;
-- this trigger immediately holds it in SENDING until a verified email.delivered webhook exists.
CREATE TRIGGER IF NOT EXISTS statement_delivery_requires_provider_confirmation
AFTER UPDATE OF status ON monthly_statement_deliveries
WHEN NEW.status = 'DELIVERED'
 AND NEW.provider_message_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM monthly_statement_email_events e
    WHERE e.provider_message_id = NEW.provider_message_id
      AND e.event_type = 'email.delivered'
 )
BEGIN
  UPDATE monthly_statement_deliveries
     SET status = 'SENDING',
         provider_status = COALESCE(provider_status, 'accepted'),
         delivered_at = NULL,
         next_attempt_at = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.id;
END;

-- Once Resend has accepted a specific message, Builtegrity never creates a duplicate merely
-- because the delivery webhook is slow. Provider delivery events decide the final outcome.
CREATE TRIGGER IF NOT EXISTS statement_accepted_email_no_duplicate_retry
AFTER UPDATE OF status ON monthly_statement_deliveries
WHEN OLD.status = 'SENDING'
 AND NEW.status = 'RETRY'
 AND OLD.provider_message_id IS NOT NULL
BEGIN
  UPDATE monthly_statement_deliveries
     SET status = 'SENDING',
         next_attempt_at = NULL,
         provider_status = COALESCE(provider_status, 'accepted'),
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.id;
END;
