PRAGMA foreign_keys = ON;

ALTER TABLE legal_response_providers ADD COLUMN callback_enabled INTEGER NOT NULL DEFAULT 0 CHECK (callback_enabled IN (0,1));
ALTER TABLE legal_response_providers ADD COLUMN callback_secret_env_key TEXT;

CREATE TRIGGER IF NOT EXISTS legal_provider_callback_guard_insert
BEFORE INSERT ON legal_response_providers
WHEN NEW.callback_enabled=1 AND (
  NEW.status<>'APPROVED' OR NEW.engagement_status<>'ACTIVE' OR
  NEW.callback_secret_env_key IS NULL OR NEW.callback_secret_env_key=''
)
BEGIN SELECT RAISE(ABORT,'legal provider callback requires approved active provider and callback secret env key'); END;

CREATE TRIGGER IF NOT EXISTS legal_provider_callback_guard_update
BEFORE UPDATE OF callback_enabled,callback_secret_env_key,status,engagement_status ON legal_response_providers
WHEN NEW.callback_enabled=1 AND (
  NEW.status<>'APPROVED' OR NEW.engagement_status<>'ACTIVE' OR
  NEW.callback_secret_env_key IS NULL OR NEW.callback_secret_env_key=''
)
BEGIN SELECT RAISE(ABORT,'legal provider callback requires approved active provider and callback secret env key'); END;

CREATE TABLE IF NOT EXISTS legal_provider_callback_receipts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROCESSING','PROCESSED','REJECTED','FAILED')),
  incident_id TEXT,
  error_text TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  FOREIGN KEY (provider_id) REFERENCES legal_response_providers(id),
  FOREIGN KEY (incident_id) REFERENCES legal_incidents(id),
  UNIQUE(provider_id,external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_legal_provider_callbacks_status ON legal_provider_callback_receipts(status,received_at);
CREATE TRIGGER IF NOT EXISTS legal_provider_callback_receipts_no_delete BEFORE DELETE ON legal_provider_callback_receipts
BEGIN SELECT RAISE(ABORT,'legal provider callback receipts are durable audit evidence'); END;

-- A security incident that is high/critical, reaches notification review, or is confirmed as a
-- breach automatically opens a legal incident. The legal system still does not decide whether
-- notification is legally required; standing counsel does that through the verified callback path.
CREATE TRIGGER IF NOT EXISTS security_incident_open_legal_case_insert
AFTER INSERT ON security_incidents
WHEN NEW.severity IN ('HIGH','CRITICAL') OR NEW.status='NOTIFICATION_REVIEW' OR NEW.confirmed_breach_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO legal_incidents (
    id,incident_type,severity,status,source_channel,source_external_id,subject,received_at,
    machine_classification,machine_confidence_ppm,response_deadline_at,deadline_source,
    deadline_verified_by_counsel,next_action_at,security_incident_id,preservation_hold_active
  ) VALUES (
    'LEGAL-SEC-'||NEW.id,
    'DATA_BREACH_NOTICE',
    NEW.severity,
    'PRESERVED',
    'SECURITY_INCIDENT',
    NEW.id,
    'Security incident requiring legal review: '||NEW.id,
    NEW.discovered_at,
    'Security incident met automatic counsel-routing threshold; legal conclusion not inferred.',
    1000000,
    NEW.ri_notice_deadline_at,
    CASE WHEN NEW.ri_notice_deadline_at IS NULL THEN NULL ELSE 'SECURITY_INCIDENT_RI_NOTICE_FIELD_UNVERIFIED' END,
    0,
    CURRENT_TIMESTAMP,
    NEW.id,
    1
  );

  INSERT OR IGNORE INTO legal_preservation_holds(id,incident_id,scope_type,scope_id,reason)
  VALUES ('LHOLD-SEC-'||NEW.id,'LEGAL-SEC-'||NEW.id,'SECURITY_INCIDENT',NEW.id,'Security incident evidence is under legal preservation until counsel authorizes release.');

  INSERT INTO legal_incident_events(incident_id,event_type,actor_type,actor_ref,details_json)
  SELECT 'LEGAL-SEC-'||NEW.id,'RECEIVED','SYSTEM','SECURITY_BRIDGE',json_object('security_incident_id',NEW.id)
  WHERE EXISTS (SELECT 1 FROM legal_incidents WHERE id='LEGAL-SEC-'||NEW.id)
    AND NOT EXISTS (SELECT 1 FROM legal_incident_events WHERE incident_id='LEGAL-SEC-'||NEW.id AND event_type='RECEIVED');

  INSERT INTO system_alerts(alert_key,category,severity,status,subject_type,subject_id,message)
  VALUES ('legal:security-incident:'||NEW.id,'LEGAL','CRITICAL','OPEN','LEGAL_INCIDENT','LEGAL-SEC-'||NEW.id,
          'Security incident automatically routed for legal review. Notification deadlines remain unverified until counsel confirms them.')
  ON CONFLICT(alert_key) DO UPDATE SET status='OPEN',last_seen_at=CURRENT_TIMESTAMP,occurrences=system_alerts.occurrences+1,resolved_at=NULL;
END;

CREATE TRIGGER IF NOT EXISTS security_incident_open_legal_case_update
AFTER UPDATE OF severity,status,confirmed_breach_at,ri_notice_deadline_at ON security_incidents
WHEN NEW.severity IN ('HIGH','CRITICAL') OR NEW.status='NOTIFICATION_REVIEW' OR NEW.confirmed_breach_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO legal_incidents (
    id,incident_type,severity,status,source_channel,source_external_id,subject,received_at,
    machine_classification,machine_confidence_ppm,response_deadline_at,deadline_source,
    deadline_verified_by_counsel,next_action_at,security_incident_id,preservation_hold_active
  ) VALUES (
    'LEGAL-SEC-'||NEW.id,'DATA_BREACH_NOTICE',NEW.severity,'PRESERVED','SECURITY_INCIDENT',NEW.id,
    'Security incident requiring legal review: '||NEW.id,NEW.discovered_at,
    'Security incident met automatic counsel-routing threshold; legal conclusion not inferred.',1000000,
    NEW.ri_notice_deadline_at,
    CASE WHEN NEW.ri_notice_deadline_at IS NULL THEN NULL ELSE 'SECURITY_INCIDENT_RI_NOTICE_FIELD_UNVERIFIED' END,
    0,CURRENT_TIMESTAMP,NEW.id,1
  );

  UPDATE legal_incidents
     SET severity=NEW.severity,
         response_deadline_at=CASE WHEN deadline_verified_by_counsel=1 THEN response_deadline_at ELSE COALESCE(NEW.ri_notice_deadline_at,response_deadline_at) END,
         updated_at=CURRENT_TIMESTAMP
   WHERE id='LEGAL-SEC-'||NEW.id AND status NOT IN ('RESOLVED','DISMISSED_NONLEGAL');

  INSERT OR IGNORE INTO legal_preservation_holds(id,incident_id,scope_type,scope_id,reason)
  VALUES ('LHOLD-SEC-'||NEW.id,'LEGAL-SEC-'||NEW.id,'SECURITY_INCIDENT',NEW.id,'Security incident evidence is under legal preservation until counsel authorizes release.');
END;

-- Privacy requests already have legal deadlines. The machine does not auto-open counsel matters for
-- every ordinary request, but it creates an alert when a deadline is due/overdue so a missed privacy
-- response cannot remain invisible.
CREATE VIEW IF NOT EXISTS privacy_request_deadline_risk AS
SELECT
  id,subject_type,subject_ref,request_type,jurisdiction_code,status,received_at,
  internal_target_at,legal_deadline_at,
  CASE
    WHEN status IN ('COMPLETED','DENIED','WITHDRAWN') THEN 'CLOSED'
    WHEN legal_deadline_at IS NOT NULL AND datetime(legal_deadline_at)<=CURRENT_TIMESTAMP THEN 'OVERDUE'
    WHEN legal_deadline_at IS NOT NULL AND datetime(legal_deadline_at)<=datetime('now','+72 hours') THEN 'CRITICAL'
    WHEN datetime(internal_target_at)<=CURRENT_TIMESTAMP THEN 'INTERNAL_TARGET_MISSED'
    ELSE 'NORMAL'
  END AS risk_state
FROM privacy_requests;
