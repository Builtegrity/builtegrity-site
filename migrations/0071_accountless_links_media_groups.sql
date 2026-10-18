PRAGMA foreign_keys=ON;
-- Merchant transaction links do not require an app account; only a pre-existing
-- verified merchant recipient is eligible. Never store clear-text bearer tokens.
CREATE TABLE IF NOT EXISTS merchant_transaction_email_links (
 transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 recipient_email TEXT NOT NULL,
 token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 email_state TEXT NOT NULL DEFAULT 'QUEUED'
  CHECK(email_state IN('QUEUED','SENT','RETRY','DISABLED')),
 email_attempts INTEGER NOT NULL DEFAULT 0 CHECK(email_attempts>=0),
 next_attempt_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 emailed_at TEXT,
 last_error TEXT,
 claimed_by TEXT,
 claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_merchant_link_pending
 ON merchant_transaction_email_links(email_state,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS idx_merchant_link_tenant ON merchant_transaction_email_links(merchant_id,created_at DESC);

-- Merchant's own customer/group/transaction display metadata never changes payment truth.
CREATE TABLE IF NOT EXISTS merchant_record_groups (
 id TEXT PRIMARY KEY,
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 field_key TEXT NOT NULL,
 group_value TEXT NOT NULL CHECK(length(group_value) BETWEEN 1 AND 256),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
 description TEXT CHECK(description IS NULL OR length(description)<=800),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (merchant_id,field_key)
  REFERENCES merchant_custom_field_definitions(merchant_id,field_key),
 UNIQUE(merchant_id,field_key,group_value)
);
CREATE TABLE IF NOT EXISTS merchant_record_display (
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 target_type TEXT NOT NULL CHECK(target_type IN ('CUSTOMER','TRANSACTION','GROUP')),
 target_id TEXT NOT NULL,
 display_title TEXT CHECK(display_title IS NULL OR length(display_title)<=100),
 display_note TEXT CHECK(display_note IS NULL OR length(display_note)<=800),
 updated_by TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(merchant_id,target_type,target_id)
);
CREATE TABLE IF NOT EXISTS merchant_record_media (
 id TEXT PRIMARY KEY,
 merchant_id TEXT NOT NULL REFERENCES merchants(id),
 target_type TEXT NOT NULL CHECK(target_type IN('CUSTOMER','TRANSACTION','GROUP')),
 target_id TEXT NOT NULL,
 filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 120),
 mime_type TEXT NOT NULL CHECK(mime_type IN('image/jpeg','image/png','image/webp','application/pdf')),
 role TEXT NOT NULL CHECK(role IN('COVER','ATTACHMENT')),
 object_key TEXT NOT NULL UNIQUE,
 byte_count INTEGER NOT NULL CHECK(byte_count>0 AND byte_count<=5242880),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 caption TEXT CHECK(caption IS NULL OR length(caption)<=400),
 uploaded_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_record_media_target
 ON merchant_record_media(merchant_id,target_type,target_id,deleted_at,created_at DESC);
