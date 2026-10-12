PRAGMA foreign_keys = ON;

-- Provider objects such as payouts can relate to many transactions. Normalize provider identity
-- separately from transaction links so the graph is many-to-many instead of accidentally one-to-one.

DROP TRIGGER IF EXISTS transaction_source_objects_no_update;
DROP TRIGGER IF EXISTS transaction_source_objects_no_delete;
ALTER TABLE transaction_source_objects RENAME TO transaction_source_objects_legacy;

CREATE TABLE IF NOT EXISTS source_objects (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_parent_id TEXT,
  metadata_json TEXT,
  first_observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  UNIQUE (merchant_id, source_system, object_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_source_objects_merchant ON source_objects(merchant_id, source_system, object_type);

CREATE TABLE IF NOT EXISTS transaction_source_object_links (
  transaction_id TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT 'RELATED' CHECK (relationship_type IN ('CREATED_BY','PAYMENT','FEE','REFUND','DISPUTE','PAYOUT','EVIDENCE','RELATED')),
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (transaction_id, source_object_id, relationship_type),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (source_object_id) REFERENCES source_objects(id)
);
CREATE INDEX IF NOT EXISTS idx_source_object_links_object ON transaction_source_object_links(source_object_id, relationship_type);

INSERT OR IGNORE INTO source_objects
(id, merchant_id, source_system, object_type, external_id, external_parent_id, metadata_json, first_observed_at, created_at)
SELECT MIN(id), merchant_id, source_system, object_type, external_id,
       MAX(external_parent_id), MAX(metadata_json), MIN(observed_at), MIN(created_at)
FROM transaction_source_objects_legacy
GROUP BY merchant_id, source_system, object_type, external_id;

INSERT OR IGNORE INTO transaction_source_object_links (transaction_id, source_object_id, relationship_type, linked_at)
SELECT l.transaction_id, s.id,
       CASE l.object_type
         WHEN 'PAYMENT_INTENT' THEN 'PAYMENT'
         WHEN 'CHARGE' THEN 'PAYMENT'
         WHEN 'APPLICATION_FEE' THEN 'FEE'
         WHEN 'DISPUTE' THEN 'DISPUTE'
         WHEN 'PAYOUT' THEN 'PAYOUT'
         ELSE 'RELATED'
       END,
       l.observed_at
FROM transaction_source_objects_legacy l
JOIN source_objects s
  ON s.merchant_id = l.merchant_id
 AND s.source_system = l.source_system
 AND s.object_type = l.object_type
 AND s.external_id = l.external_id;

DROP TABLE transaction_source_objects_legacy;

CREATE TRIGGER IF NOT EXISTS source_objects_no_update BEFORE UPDATE ON source_objects
BEGIN SELECT RAISE(ABORT, 'source_objects are append-only; evolving provider facts belong in events/components'); END;
CREATE TRIGGER IF NOT EXISTS source_objects_no_delete BEFORE DELETE ON source_objects
BEGIN SELECT RAISE(ABORT, 'source_objects are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_object_links_no_update BEFORE UPDATE ON transaction_source_object_links
BEGIN SELECT RAISE(ABORT, 'transaction_source_object_links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_object_links_no_delete BEFORE DELETE ON transaction_source_object_links
BEGIN SELECT RAISE(ABORT, 'transaction_source_object_links are append-only'); END;

INSERT OR IGNORE INTO id_counters (prefix, next_value) VALUES ('OBJ',1);
