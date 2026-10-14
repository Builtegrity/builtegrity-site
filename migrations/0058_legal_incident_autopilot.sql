PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Legal Incident Autopilot
-- Goal: legal work should be detected, preserved, routed and deadline-controlled without
-- requiring routine owner involvement. The system may automate process; it may NOT practice law,
-- admit liability, waive rights, settle claims, ignore service, or invent legal conclusions.
-- -----------------------------------------------------------------------------

ALTER TABLE platform_compliance_controls ADD COLUMN legal_response_program_status TEXT NOT NULL DEFAULT 'UNCONFIGURED'
  CHECK (legal_response_program_status IN ('UNCONFIGURED','READY','NEEDS_REVIEW','EXPIRED'));

CREATE TABLE IF NOT EXISTS legal_response_policy (
  id TEXT PRIMARY KEY CHECK (id='GLOBAL'),
  auto_intake_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_intake_enabled IN (0,1)),
  auto_preserve_evidence INTEGER NOT NULL DEFAULT 1 CHECK (auto_preserve_evidence IN (0,1)),
  auto_dispatch_counsel INTEGER NOT NULL DEFAULT 1 CHECK (auto_dispatch_counsel IN (0,1)),
  auto_notify_insurer INTEGER NOT NULL DEFAULT 0 CHECK (auto_notify_insurer IN (0,1)),
  auto_reply_to_sender INTEGER NOT NULL DEFAULT 0 CHECK (auto_reply_to_sender IN (0,1)),
  substantive_response_requires_counsel INTEGER NOT NULL DEFAULT 1 CHECK (substantive_response_requires_counsel=1),
  settlement_requires_authority INTEGER NOT NULL DEFAULT 1 CHECK (settlement_requires_authority=1),
  admission_requires_authority INTEGER NOT NULL DEFAULT 1 CHECK (admission_requires_authority=1),
  owner_notification_mode TEXT NOT NULL DEFAULT 'MATERIAL_ONLY'
    CHECK (owner_notification_mode IN ('MATERIAL_ONLY','ALL','NONE')),
  owner_operational_touch_target_ppm INTEGER NOT NULL DEFAULT 0 CHECK (owner_operational_touch_target_ppm=0),
  counsel_ack_target_minutes INTEGER NOT NULL DEFAULT 60 CHECK (counsel_ack_target_minutes BETWEEN 5 AND 1440),
  deadline_warning_hours INTEGER NOT NULL DEFAULT 168 CHECK (deadline_warning_hours BETWEEN 1 AND 720),
  deadline_critical_hours INTEGER NOT NULL DEFAULT 72 CHECK (deadline_critical_hours BETWEEN 1 AND 720),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO legal_response_policy(id) VALUES('GLOBAL');

CREATE TABLE IF NOT EXISTS legal_response_providers (
  id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('COUNSEL','REGISTERED_AGENT','INSURER','REGULATORY_FILING')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (status IN ('CANDIDATE','APPROVED','PAUSED','RETIRED')),
  engagement_status TEXT NOT NULL DEFAULT 'NOT_ENGAGED'
    CHECK (engagement_status IN ('NOT_ENGAGED','ACTIVE','EXPIRED','TERMINATED')),
  intake_mode TEXT NOT NULL DEFAULT 'EMAIL' CHECK (intake_mode IN ('EMAIL','WEBHOOK')),
  intake_email TEXT,
  intake_endpoint TEXT,
  intake_secret_env_key TEXT,
  claims_or_matter_reference TEXT,
  privilege_relationship_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (privilege_relationship_confirmed IN (0,1)),
  auto_dispatch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_dispatch_enabled IN (0,1)),
  jurisdiction_scope TEXT NOT NULL DEFAULT 'US',
  matter_scope_json TEXT,
  effective_at TEXT,
  expires_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO legal_response_providers
(id,provider_type,name,status,engagement_status,intake_mode,privilege_relationship_confirmed,auto_dispatch_enabled,jurisdiction_scope,notes) VALUES
('LEGAL-COUNSEL-PRIMARY','COUNSEL','Primary Outside Counsel','CANDIDATE','NOT_ENGAGED','EMAIL',0,0,'US','Configure only after an engagement letter is active. This record is intentionally not approved by migration.'),
('LEGAL-REGISTERED-AGENT','REGISTERED_AGENT','Registered Agent','CANDIDATE','NOT_ENGAGED','EMAIL',0,0,'US-RI','Configure the actual Rhode Island registered agent/service-of-process forwarding route before live use.'),
('LEGAL-INSURER-PRIMARY','INSURER','Primary Liability/Cyber Carrier','CANDIDATE','NOT_ENGAGED','EMAIL',0,0,'US','Configure only after a policy exists and counsel/carrier-approved claim-notice procedure is documented.');

CREATE TRIGGER IF NOT EXISTS legal_provider_auto_dispatch_guard_insert
BEFORE INSERT ON legal_response_providers
WHEN NEW.auto_dispatch_enabled=1 AND (
  NEW.status<>'APPROVED' OR NEW.engagement_status<>'ACTIVE' OR
  (NEW.intake_mode='EMAIL' AND (NEW.intake_email IS NULL OR NEW.intake_email='')) OR
  (NEW.intake_mode='WEBHOOK' AND (NEW.intake_endpoint IS NULL OR NEW.intake_endpoint='' OR NEW.intake_secret_env_key IS NULL OR NEW.intake_secret_env_key='')) OR
  (NEW.provider_type='COUNSEL' AND NEW.privilege_relationship_confirmed<>1)
)
BEGIN SELECT RAISE(ABORT,'legal response provider cannot auto-dispatch until approved, actively engaged, addressable, and privilege-confirmed where applicable'); END;

CREATE TRIGGER IF NOT EXISTS legal_provider_auto_dispatch_guard_update
BEFORE UPDATE OF auto_dispatch_enabled,status,engagement_status,intake_email,intake_endpoint,intake_secret_env_key,privilege_relationship_confirmed
ON legal_response_providers
WHEN NEW.auto_dispatch_enabled=1 AND (
  NEW.status<>'APPROVED' OR NEW.engagement_status<>'ACTIVE' OR
  (NEW.intake_mode='EMAIL' AND (NEW.intake_email IS NULL OR NEW.intake_email='')) OR
  (NEW.intake_mode='WEBHOOK' AND (NEW.intake_endpoint IS NULL OR NEW.intake_endpoint='' OR NEW.intake_secret_env_key IS NULL OR NEW.intake_secret_env_key='')) OR
  (NEW.provider_type='COUNSEL' AND NEW.privilege_relationship_confirmed<>1)
)
BEGIN SELECT RAISE(ABORT,'legal response provider cannot auto-dispatch until approved, actively engaged, addressable, and privilege-confirmed where applicable'); END;

CREATE TABLE IF NOT EXISTS legal_incidents (
  id TEXT PRIMARY KEY,
  incident_type TEXT NOT NULL CHECK (incident_type IN (
    'UNCLASSIFIED','DEMAND_LETTER','SUMMONS_COMPLAINT','SUBPOENA','REGULATORY_INQUIRY',
    'ATTORNEY_GENERAL','PRIVACY_COMPLAINT','DATA_BREACH_NOTICE','IP_CLAIM','CONTRACT_DISPUTE',
    'TAX_NOTICE','PROCESSOR_LEGAL_NOTICE','EMPLOYMENT','OTHER'
  )),
  severity TEXT NOT NULL DEFAULT 'HIGH' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','PRESERVED','COUNSEL_DISPATCHED','COUNSEL_ACKNOWLEDGED','ACTION_REQUIRED',
    'WAITING_EXTERNAL','RESOLVED','DISMISSED_NONLEGAL'
  )),
  source_channel TEXT NOT NULL CHECK (source_channel IN ('RESEND_INBOUND','REGISTERED_AGENT','PROVIDER_WEBHOOK','OPERATOR','SECURITY_INCIDENT','SYSTEM')),
  source_provider_id TEXT,
  source_external_id TEXT NOT NULL,
  source_message_id TEXT,
  sender_identity TEXT,
  recipient_identity TEXT,
  subject TEXT,
  received_at TEXT NOT NULL,
  machine_classification TEXT,
  machine_confidence_ppm INTEGER CHECK (machine_confidence_ppm IS NULL OR machine_confidence_ppm BETWEEN 0 AND 1000000),
  counsel_classification TEXT,
  response_deadline_at TEXT,
  deadline_source TEXT,
  deadline_verified_by_counsel INTEGER NOT NULL DEFAULT 0 CHECK (deadline_verified_by_counsel IN (0,1)),
  next_action_at TEXT,
  merchant_id TEXT,
  customer_id TEXT,
  transaction_id TEXT,
  security_incident_id TEXT,
  evidence_object_key TEXT,
  evidence_sha256 TEXT,
  preservation_hold_active INTEGER NOT NULL DEFAULT 1 CHECK (preservation_hold_active IN (0,1)),
  insurer_notice_required INTEGER NOT NULL DEFAULT 0 CHECK (insurer_notice_required IN (0,1)),
  insurer_notice_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED'
    CHECK (insurer_notice_status IN ('NOT_REQUIRED','PENDING','SENT','FAILED','WAIVED_BY_COUNSEL')),
  counsel_provider_id TEXT,
  counsel_dispatched_at TEXT,
  counsel_acknowledged_at TEXT,
  counsel_clearance_reference TEXT,
  owner_authority_required INTEGER NOT NULL DEFAULT 0 CHECK (owner_authority_required IN (0,1)),
  owner_authority_reason TEXT,
  resolution_summary TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_provider_id) REFERENCES legal_response_providers(id),
  FOREIGN KEY (counsel_provider_id) REFERENCES legal_response_providers(id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (security_incident_id) REFERENCES security_incidents(id),
  UNIQUE(source_channel,source_external_id)
);
CREATE INDEX IF NOT EXISTS idx_legal_incidents_active
  ON legal_incidents(status,severity,next_action_at,response_deadline_at);
CREATE INDEX IF NOT EXISTS idx_legal_incidents_entities
  ON legal_incidents(merchant_id,customer_id,transaction_id);

CREATE TRIGGER IF NOT EXISTS legal_incident_source_evidence_immutable
BEFORE UPDATE OF source_channel,source_provider_id,source_external_id,source_message_id,sender_identity,
                 recipient_identity,received_at,evidence_object_key,evidence_sha256
ON legal_incidents
WHEN NEW.source_channel<>OLD.source_channel OR
     COALESCE(NEW.source_provider_id,'')<>COALESCE(OLD.source_provider_id,'') OR
     NEW.source_external_id<>OLD.source_external_id OR
     COALESCE(NEW.source_message_id,'')<>COALESCE(OLD.source_message_id,'') OR
     COALESCE(NEW.sender_identity,'')<>COALESCE(OLD.sender_identity,'') OR
     COALESCE(NEW.recipient_identity,'')<>COALESCE(OLD.recipient_identity,'') OR
     NEW.received_at<>OLD.received_at OR
     COALESCE(NEW.evidence_object_key,'')<>COALESCE(OLD.evidence_object_key,'') OR
     COALESCE(NEW.evidence_sha256,'')<>COALESCE(OLD.evidence_sha256,'')
BEGIN SELECT RAISE(ABORT,'legal incident source evidence is immutable'); END;

CREATE TRIGGER IF NOT EXISTS legal_incident_no_close_without_counsel
BEFORE UPDATE OF status,resolved_at,counsel_clearance_reference ON legal_incidents
WHEN NEW.status IN ('RESOLVED','DISMISSED_NONLEGAL')
 AND (NEW.counsel_clearance_reference IS NULL OR NEW.counsel_clearance_reference='')
BEGIN SELECT RAISE(ABORT,'legal incident cannot close without counsel clearance reference'); END;

CREATE TABLE IF NOT EXISTS legal_incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'RECEIVED','EVIDENCE_PRESERVED','CLASSIFIED','COUNSEL_DISPATCHED','COUNSEL_ACKNOWLEDGED',
    'DEADLINE_RECORDED','DEADLINE_VERIFIED','INSURER_NOTICE_SENT','HOLD_APPLIED','HOLD_RELEASED',
    'OWNER_AUTHORITY_REQUESTED','EXTERNAL_ACTION','RESOLVED','ERROR'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','COUNSEL','INSURER','REGISTERED_AGENT','OPERATOR','EXTERNAL_AUTHORITY')),
  actor_ref TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (incident_id) REFERENCES legal_incidents(id)
);
CREATE INDEX IF NOT EXISTS idx_legal_incident_events ON legal_incident_events(incident_id,created_at);
CREATE TRIGGER IF NOT EXISTS legal_incident_events_no_update BEFORE UPDATE ON legal_incident_events
BEGIN SELECT RAISE(ABORT,'legal incident events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS legal_incident_events_no_delete BEFORE DELETE ON legal_incident_events
BEGIN SELECT RAISE(ABORT,'legal incident events are append-only'); END;

CREATE TABLE IF NOT EXISTS legal_preservation_holds (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('PLATFORM','MERCHANT','CUSTOMER','TRANSACTION','SECURITY_INCIDENT','EVIDENCE_OBJECT')),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  reason TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  release_counsel_reference TEXT,
  FOREIGN KEY (incident_id) REFERENCES legal_incidents(id),
  UNIQUE(incident_id,scope_type,scope_id)
);
CREATE INDEX IF NOT EXISTS idx_legal_holds_active ON legal_preservation_holds(status,scope_type,scope_id);

CREATE TRIGGER IF NOT EXISTS legal_hold_release_requires_counsel
BEFORE UPDATE OF status,released_at,release_counsel_reference ON legal_preservation_holds
WHEN NEW.status='RELEASED' AND (NEW.release_counsel_reference IS NULL OR NEW.release_counsel_reference='')
BEGIN SELECT RAISE(ABORT,'legal preservation hold requires counsel reference before release'); END;

CREATE TABLE IF NOT EXISTS legal_outbound_actions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'COUNSEL_INTAKE','INSURER_NOTICE','REGISTERED_AGENT_ACK','PROCEDURAL_ACKNOWLEDGMENT',
    'SUBSTANTIVE_RESPONSE','SETTLEMENT','ADMISSION','WAIVER','PUBLIC_STATEMENT'
  )),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AUTHORIZED','SENT','FAILED','CANCELLED')),
  destination TEXT,
  counsel_authorization_reference TEXT,
  corporate_authority_reference TEXT,
  content_sha256 TEXT,
  external_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  FOREIGN KEY (incident_id) REFERENCES legal_incidents(id)
);
CREATE INDEX IF NOT EXISTS idx_legal_outbound_pending ON legal_outbound_actions(status,action_type,created_at);

CREATE TRIGGER IF NOT EXISTS legal_substantive_action_guard_insert
BEFORE INSERT ON legal_outbound_actions
WHEN NEW.action_type IN ('SUBSTANTIVE_RESPONSE','SETTLEMENT','ADMISSION','WAIVER','PUBLIC_STATEMENT') AND (
  NEW.counsel_authorization_reference IS NULL OR NEW.counsel_authorization_reference='' OR
  (NEW.action_type IN ('SETTLEMENT','ADMISSION','WAIVER') AND (NEW.corporate_authority_reference IS NULL OR NEW.corporate_authority_reference=''))
)
BEGIN SELECT RAISE(ABORT,'substantive legal action requires counsel authorization and corporate authority where applicable'); END;

CREATE TRIGGER IF NOT EXISTS legal_substantive_action_guard_update
BEFORE UPDATE OF status,counsel_authorization_reference,corporate_authority_reference ON legal_outbound_actions
WHEN NEW.status IN ('AUTHORIZED','SENT')
 AND NEW.action_type IN ('SUBSTANTIVE_RESPONSE','SETTLEMENT','ADMISSION','WAIVER','PUBLIC_STATEMENT') AND (
  NEW.counsel_authorization_reference IS NULL OR NEW.counsel_authorization_reference='' OR
  (NEW.action_type IN ('SETTLEMENT','ADMISSION','WAIVER') AND (NEW.corporate_authority_reference IS NULL OR NEW.corporate_authority_reference=''))
)
BEGIN SELECT RAISE(ABORT,'substantive legal action requires counsel authorization and corporate authority where applicable'); END;

CREATE TABLE IF NOT EXISTS legal_intake_receipts (
  external_email_id TEXT PRIMARY KEY,
  message_id TEXT,
  sender TEXT,
  recipient_json TEXT,
  subject TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count>=0),
  evidence_object_key TEXT,
  evidence_sha256 TEXT,
  incident_id TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PRESERVED','INCIDENT_CREATED','FAILED')),
  error_text TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (incident_id) REFERENCES legal_incidents(id)
);

CREATE TABLE IF NOT EXISTS legal_intake_attachments (
  id TEXT PRIMARY KEY,
  external_email_id TEXT NOT NULL,
  external_attachment_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  evidence_object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes>=0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (external_email_id) REFERENCES legal_intake_receipts(external_email_id),
  UNIQUE(external_email_id,external_attachment_id)
);
CREATE TRIGGER IF NOT EXISTS legal_intake_attachments_no_update BEFORE UPDATE ON legal_intake_attachments
BEGIN SELECT RAISE(ABORT,'legal intake attachment evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legal_intake_attachments_no_delete BEFORE DELETE ON legal_intake_attachments
BEGIN SELECT RAISE(ABORT,'legal intake attachment evidence is immutable'); END;

-- Legal incident e-mail is untrusted input. It may create/preserve/route a case, but its contents
-- can never directly authorize money movement, production configuration, data deletion, credentials,
-- merchant activation, legal clearance, or substantive outbound legal responses.
CREATE TABLE IF NOT EXISTS legal_intake_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_email_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('SIGNATURE_INVALID','RATE_LIMITED','PROCESSING_FAILED','UNTRUSTED_CONTENT_STORED')),
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Platform cannot declare itself legally READY for commercial launch unless standing counsel is
-- actually engaged and an automatic intake/dispatch route exists. This does not certify legality;
-- it ensures an issue has somewhere competent to go the moment it appears.
CREATE TRIGGER IF NOT EXISTS legal_launch_requires_response_program
BEFORE UPDATE OF legal_launch_state ON platform_compliance_controls
WHEN NEW.legal_launch_state='READY' AND (
  NEW.legal_response_program_status<>'READY' OR
  NOT EXISTS (
    SELECT 1 FROM legal_response_providers p
    WHERE p.provider_type='COUNSEL'
      AND p.status='APPROVED'
      AND p.engagement_status='ACTIVE'
      AND p.privilege_relationship_confirmed=1
      AND p.auto_dispatch_enabled=1
      AND (p.expires_at IS NULL OR datetime(p.expires_at)>CURRENT_TIMESTAMP)
  )
)
BEGIN SELECT RAISE(ABORT,'legal launch requires an approved active standing-counsel response program'); END;

CREATE VIEW IF NOT EXISTS legal_incident_deadline_queue AS
SELECT
  i.id,
  i.incident_type,
  i.severity,
  i.status,
  i.received_at,
  i.response_deadline_at,
  i.deadline_verified_by_counsel,
  i.next_action_at,
  i.counsel_provider_id,
  i.counsel_dispatched_at,
  i.counsel_acknowledged_at,
  CASE
    WHEN i.response_deadline_at IS NULL THEN 'UNVERIFIED_DEADLINE'
    WHEN datetime(i.response_deadline_at)<=CURRENT_TIMESTAMP THEN 'OVERDUE'
    WHEN datetime(i.response_deadline_at)<=datetime('now','+72 hours') THEN 'CRITICAL'
    WHEN datetime(i.response_deadline_at)<=datetime('now','+168 hours') THEN 'WARNING'
    ELSE 'NORMAL'
  END AS deadline_state
FROM legal_incidents i
WHERE i.status NOT IN ('RESOLVED','DISMISSED_NONLEGAL');

CREATE VIEW IF NOT EXISTS legal_response_readiness AS
SELECT
  CASE WHEN
    p.legal_response_program_status='READY'
    AND EXISTS (
      SELECT 1 FROM legal_response_providers r
      WHERE r.provider_type='COUNSEL' AND r.status='APPROVED' AND r.engagement_status='ACTIVE'
        AND r.privilege_relationship_confirmed=1 AND r.auto_dispatch_enabled=1
        AND (r.expires_at IS NULL OR datetime(r.expires_at)>CURRENT_TIMESTAMP)
    )
    THEN 'READY' ELSE 'BLOCKED' END AS state,
  p.legal_response_program_status,
  (SELECT COUNT(*) FROM legal_incidents i WHERE i.status NOT IN ('RESOLVED','DISMISSED_NONLEGAL')) AS open_incidents,
  (SELECT COUNT(*) FROM legal_incident_deadline_queue q WHERE q.deadline_state IN ('OVERDUE','CRITICAL')) AS urgent_incidents
FROM platform_compliance_controls p
WHERE p.id='GLOBAL';
