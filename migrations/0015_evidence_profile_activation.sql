PRAGMA foreign_keys = ON;

-- Evidence discovered from any adapter automatically activates the merchant's EVIDENCE module.
CREATE TRIGGER IF NOT EXISTS transaction_artifacts_profile_learning
AFTER INSERT ON transaction_artifacts
BEGIN
  INSERT INTO merchant_profile_modules
    (merchant_id, module_code, activation_state, occurrence_count, first_seen_at, last_seen_at)
  VALUES
    (NEW.merchant_id, 'EVIDENCE', 'AUTO_DISCOVERED', 1, NEW.observed_at, NEW.observed_at)
  ON CONFLICT(merchant_id, module_code) DO UPDATE SET
    occurrence_count = occurrence_count + 1,
    last_seen_at = excluded.last_seen_at;

  UPDATE merchant_transaction_profiles
     SET last_discovered_at = NEW.observed_at,
         updated_at = CURRENT_TIMESTAMP
   WHERE merchant_id = NEW.merchant_id;
END;
