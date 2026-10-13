PRAGMA foreign_keys = ON;

-- Every merchant gets a tax/documentation profile at creation time, even before application code touches it.
CREATE TRIGGER IF NOT EXISTS merchants_create_tax_profile_after_insert
AFTER INSERT ON merchants
BEGIN
  INSERT OR IGNORE INTO merchant_tax_profiles
    (merchant_id,federal_tax_classification,tax_home_country,tax_home_state,has_employees,profile_status,source,updated_at)
  VALUES
    (NEW.id,NEW.federal_tax_classification,NEW.tax_home_country,NEW.tax_home_state,NEW.has_employees,NEW.tax_profile_status,'MERCHANT',CURRENT_TIMESTAMP);
END;

-- Keep canonical merchant summary fields and the dedicated tax profile aligned when older/internal code updates merchants directly.
CREATE TRIGGER IF NOT EXISTS merchants_sync_tax_profile_after_update
AFTER UPDATE OF federal_tax_classification,tax_home_country,tax_home_state,has_employees,tax_profile_status ON merchants
BEGIN
  INSERT INTO merchant_tax_profiles
    (merchant_id,federal_tax_classification,tax_home_country,tax_home_state,has_employees,profile_status,source,updated_at)
  VALUES
    (NEW.id,NEW.federal_tax_classification,NEW.tax_home_country,NEW.tax_home_state,NEW.has_employees,NEW.tax_profile_status,'MERCHANT',CURRENT_TIMESTAMP)
  ON CONFLICT(merchant_id) DO UPDATE SET
    federal_tax_classification=excluded.federal_tax_classification,
    tax_home_country=excluded.tax_home_country,
    tax_home_state=excluded.tax_home_state,
    has_employees=excluded.has_employees,
    profile_status=excluded.profile_status,
    updated_at=CURRENT_TIMESTAMP;
END;
