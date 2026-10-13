PRAGMA foreign_keys = ON;

ALTER TABLE builtegrity_tax_workpapers ADD COLUMN accounting_snapshot_id TEXT;
ALTER TABLE builtegrity_tax_workpapers ADD COLUMN books_state_snapshot TEXT;
ALTER TABLE builtegrity_tax_workpapers ADD COLUMN book_net_income_micros INTEGER;

CREATE TRIGGER IF NOT EXISTS builtegrity_tax_profile_books_verified_gate
BEFORE UPDATE OF accounting_data_status ON builtegrity_tax_profile
WHEN NEW.accounting_data_status='COMPLETE_VERIFIED'
 AND COALESCE((SELECT state FROM company_books_state WHERE id='GLOBAL'),'NOT_CONNECTED')<>'COMPLETE_VERIFIED'
BEGIN SELECT RAISE(ABORT,'tax profile cannot mark books complete until company books reconcile'); END;

CREATE TRIGGER IF NOT EXISTS company_books_state_degrade_tax_profile
AFTER UPDATE OF state ON company_books_state
WHEN NEW.state<>'COMPLETE_VERIFIED'
BEGIN
  UPDATE builtegrity_tax_profile
     SET accounting_data_status='PARTIAL',updated_at=CURRENT_TIMESTAMP
   WHERE id='GLOBAL' AND accounting_data_status<>'PARTIAL';
END;
