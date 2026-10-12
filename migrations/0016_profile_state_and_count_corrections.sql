PRAGMA foreign_keys = ON;

-- Correct module-level occurrence count for the temporary payout projection removed in 0013.
UPDATE merchant_profile_modules
SET occurrence_count = MAX(0, occurrence_count - COALESCE((
  SELECT COUNT(*) FROM transactions t
  WHERE t.merchant_id = merchant_profile_modules.merchant_id
    AND t.actual_merchant_net_cents IS NOT NULL
),0))
WHERE module_code = 'CORE_PAYMENT';

-- A connected source moves a new merchant profile from LEARNING to ACTIVE. Discovery can later
-- move it to REVIEW_REQUIRED when an unknown component appears.
CREATE TRIGGER IF NOT EXISTS merchant_transaction_source_activates_profile
AFTER INSERT ON merchant_transaction_sources
BEGIN
  UPDATE merchant_transaction_profiles
     SET status = CASE WHEN status = 'LEARNING' THEN 'ACTIVE' ELSE status END,
         last_discovered_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
   WHERE merchant_id = NEW.merchant_id;
END;

-- Once the merchant/operator teaches Builtegrity the final unresolved component classification,
-- the profile can return to ACTIVE automatically.
CREATE TRIGGER IF NOT EXISTS merchant_component_rule_confirmation_clears_review
AFTER UPDATE OF rule_status, component_type_code ON merchant_component_rules
WHEN NEW.rule_status = 'CONFIRMED'
BEGIN
  UPDATE merchant_transaction_profiles
     SET status = CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM merchant_component_rules r
         WHERE r.merchant_id = NEW.merchant_id AND r.rule_status = 'NEEDS_REVIEW'
       ) THEN 'ACTIVE'
       ELSE 'REVIEW_REQUIRED'
     END,
     updated_at = CURRENT_TIMESTAMP
   WHERE merchant_id = NEW.merchant_id;
END;
