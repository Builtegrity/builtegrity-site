ALTER TABLE company_books_settings ADD COLUMN settlement_lag_days INTEGER NOT NULL DEFAULT 7 CHECK (settlement_lag_days BETWEEN 0 AND 31);
