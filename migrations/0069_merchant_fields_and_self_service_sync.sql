PRAGMA foreign_keys=ON;
-- Merchant-owned context, never part of Stripe/Square canonical financial facts.
CREATE TABLE IF NOT EXISTS merchant_custom_field_definitions (
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  field_key TEXT NOT NULL CHECK(length(field_key) BETWEEN 2 AND 40),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 90),
  group_title TEXT NOT NULL DEFAULT 'General' CHECK(length(group_title)<=60),
  record_scope TEXT NOT NULL CHECK(record_scope IN ('CUSTOMER','TRANSACTION')),
  value_type TEXT NOT NULL DEFAULT 'TEXT' CHECK(value_type IN ('TEXT','NUMBER','BOOLEAN','DATE')),
  visible_in_pdf INTEGER NOT NULL DEFAULT 1 CHECK(visible_in_pdf IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(merchant_id,field_key)
);
CREATE INDEX IF NOT EXISTS idx_custom_def_by_group
 ON merchant_custom_field_definitions(merchant_id,record_scope,group_title,active);

-- Append-only revisions preserve what arrived, when and from which source.
CREATE TABLE IF NOT EXISTS merchant_custom_field_observations (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  record_scope TEXT NOT NULL CHECK(record_scope IN ('CUSTOMER','TRANSACTION')),
  record_id TEXT NOT NULL,
  value_text TEXT NOT NULL CHECK(length(value_text)<=1024),
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL CHECK(length(source_event_id)<=128),
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(merchant_id,field_key)
    REFERENCES merchant_custom_field_definitions(merchant_id,field_key),
  UNIQUE(merchant_id,source_id,source_event_id,record_scope,record_id,field_key)
);
CREATE INDEX IF NOT EXISTS idx_custom_values_history ON merchant_custom_field_observations
 (merchant_id,record_scope,record_id,field_key,observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_custom_values_groups ON merchant_custom_field_observations
 (merchant_id,field_key,value_text,observed_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_custom_value_immutable_update
 BEFORE UPDATE ON merchant_custom_field_observations
 BEGIN SELECT RAISE(ABORT,'Custom field revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_custom_value_immutable_delete
 BEFORE DELETE ON merchant_custom_field_observations
 BEGIN SELECT RAISE(ABORT,'Custom field revisions are append-only'); END;

CREATE TABLE IF NOT EXISTS merchant_custom_sync_sources (
 id TEXT PRIMARY KEY,
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 90),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('FILE','WEBHOOK','DATABASE_PUSH','APP_PUSH')),
 key_hash TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK(status IN ('ACTIVE','PAUSED','REVOKED','ERROR')),
 last_success_at TEXT,last_error TEXT,
 created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_custom_source_merchant
 ON merchant_custom_sync_sources(merchant_id,status);

CREATE TABLE IF NOT EXISTS merchant_custom_sync_deliveries (
 source_id TEXT NOT NULL REFERENCES merchant_custom_sync_sources(id),
 delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 128),
 received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 result_count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(source_id,delivery_id)
);
CREATE TABLE IF NOT EXISTS merchant_setup_notices (
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 notice_key TEXT NOT NULL,
 notice_state TEXT NOT NULL DEFAULT 'OPEN' CHECK(notice_state IN ('OPEN','RESOLVED')),
 first_detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_emailed_at TEXT, email_attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(merchant_id,notice_key)
);
