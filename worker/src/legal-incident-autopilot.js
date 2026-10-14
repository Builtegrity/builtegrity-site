const MAX_INCIDENTS_PER_RUN = 100;
const COUNSEL_EXCERPT_CHARS = 12000;

export async function runLegalIncidentAutopilot(env, options = {}) {
  const stats = {
    scanned: 0,
    counsel_dispatched: 0,
    counsel_missing: 0,
    counsel_ack_timeouts: 0,
    insurer_notices: 0,
    deadline_warnings: 0,
    deadline_critical: 0,
    privacy_deadline_incidents: 0,
    owner_authority_alerts: 0,
    errors: 0,
  };

  stats.privacy_deadline_incidents = await seedPrivacyDeadlineIncidents(env);

  const incidents = await env.DB.prepare(`
    SELECT * FROM legal_incidents
    WHERE status NOT IN ('RESOLVED','DISMISSED_NONLEGAL')
    ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
             received_at ASC
    LIMIT ?
  `).bind(Math.max(1, Math.min(Number(options.limit || MAX_INCIDENTS_PER_RUN), 500))).all();

  for (const incident of incidents.results || []) {
    stats.scanned += 1;
    try {
      if (!incident.counsel_dispatched_at) {
        const dispatched = await ensureCounselDispatch(env, incident);
        if (dispatched) stats.counsel_dispatched += 1;
        else stats.counsel_missing += 1;
      }

      const ackTimedOut = await monitorCounselAcknowledgment(env, incident);
      if (ackTimedOut) stats.counsel_ack_timeouts += 1;

      const deadline = await monitorDeadline(env, incident);
      if (deadline === 'WARNING') stats.deadline_warnings += 1;
      if (deadline === 'CRITICAL' || deadline === 'OVERDUE') stats.deadline_critical += 1;

      if (Number(incident.insurer_notice_required || 0) === 1 && incident.insurer_notice_status === 'PENDING') {
        const sent = await maybeNotifyInsurer(env, incident);
        if (sent) stats.insurer_notices += 1;
      }

      if (Number(incident.owner_authority_required || 0) === 1) {
        await upsertLegalAlert(env, {
          key: `legal:owner-authority:${incident.id}`,
          severity: 'CRITICAL',
          incidentId: incident.id,
          message: `Counsel has identified a decision requiring corporate authority: ${incident.owner_authority_reason || 'See legal incident record.'}`,
        });
        await appendIncidentEventOnce(env, incident.id, 'OWNER_AUTHORITY_REQUESTED', 'SYSTEM', 'LEGAL_AUTOPILOT', {
          reason: incident.owner_authority_reason || null,
        });
        stats.owner_authority_alerts += 1;
      }
    } catch (error) {
      stats.errors += 1;
      await upsertLegalAlert(env, {
        key: `legal:autopilot-error:${incident.id}`,
        severity: 'CRITICAL',
        incidentId: incident.id,
        message: `Legal incident autopilot failed safely and requires attention: ${errorText(error)}`,
      });
      await appendIncidentEvent(env, incident.id, 'ERROR', 'SYSTEM', 'LEGAL_AUTOPILOT', { error: errorText(error) }).catch(() => null);
    }
  }

  await enforceProgramReadiness(env);
  return stats;
}

async function seedPrivacyDeadlineIncidents(env) {
  const rows = await env.DB.prepare(`
    SELECT p.*
    FROM privacy_request_deadline_risk p
    WHERE p.risk_state IN ('OVERDUE','CRITICAL')
    ORDER BY CASE p.risk_state WHEN 'OVERDUE' THEN 1 ELSE 2 END,
             COALESCE(p.legal_deadline_at,p.internal_target_at) ASC
    LIMIT 100
  `).all().catch(() => ({ results: [] }));
  let created = 0;
  for (const request of rows.results || []) {
    const incidentId = `LEGAL-PRIV-${request.id}`;
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO legal_incidents(
        id,incident_type,severity,status,source_channel,source_external_id,subject,received_at,
        machine_classification,machine_confidence_ppm,response_deadline_at,deadline_source,
        deadline_verified_by_counsel,next_action_at,preservation_hold_active
      ) VALUES (?,?,?,'PRESERVED','SYSTEM',?,?,?,?,?,?,'PRIVACY_REQUEST_DB_UNVERIFIED',0,CURRENT_TIMESTAMP,1)
    `).bind(
      incidentId,
      'PRIVACY_COMPLAINT',
      request.risk_state === 'OVERDUE' ? 'CRITICAL' : 'HIGH',
      `privacy-request:${request.id}`,
      `Privacy request deadline risk: ${request.request_type} ${request.id}`,
      request.received_at,
      `Privacy request entered ${request.risk_state}; route to counsel to verify jurisdiction/deadline and required response.`,
      1000000,
      request.legal_deadline_at || null,
    ).run();
    if (Number(result.meta?.changes || 0) > 0) {
      created += 1;
      await env.DB.prepare(`
        INSERT OR IGNORE INTO legal_preservation_holds(id,incident_id,scope_type,scope_id,reason)
        VALUES (?,?, 'PLATFORM',?,'Privacy request evidence and responsive records must be preserved until counsel releases the hold.')
      `).bind(`LHOLD-PRIV-${request.id}`,incidentId,`PRIVACY_REQUEST:${request.id}`).run();
      await appendIncidentEvent(env,incidentId,'RECEIVED','SYSTEM','PRIVACY_DEADLINE_BRIDGE',{privacy_request_id:request.id,risk_state:request.risk_state});
      await upsertLegalAlert(env,{
        key:`legal:privacy-deadline:${request.id}`,
        severity:request.risk_state==='OVERDUE'?'CRITICAL':'WARN',incidentId,
        message:`Privacy request ${request.id} reached ${request.risk_state}; it has been routed to standing counsel for deadline/response verification.`,
      });
    }
  }
  return created;
}

async function ensureCounselDispatch(env, incident) {
  const provider = await env.DB.prepare(`
    SELECT * FROM legal_response_providers
    WHERE provider_type='COUNSEL'
      AND status='APPROVED'
      AND engagement_status='ACTIVE'
      AND privilege_relationship_confirmed=1
      AND auto_dispatch_enabled=1
      AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP)
    ORDER BY effective_at DESC, created_at ASC
    LIMIT 1
  `).first();

  if (!provider) {
    await env.DB.prepare(`
      UPDATE legal_incidents
         SET status='ACTION_REQUIRED', next_action_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND status NOT IN ('RESOLVED','DISMISSED_NONLEGAL')
    `).bind(incident.id).run();
    await upsertLegalAlert(env, {
      key: `legal:counsel-unavailable:${incident.id}`,
      severity: 'CRITICAL',
      incidentId: incident.id,
      message: 'A legal notice is preserved but no approved active standing-counsel intake route is configured. Builtegrity will not respond substantively on its own.',
    });
    return false;
  }

  const existingAction = await env.DB.prepare(`
    SELECT id,status FROM legal_outbound_actions
    WHERE incident_id=? AND action_type='COUNSEL_INTAKE' AND status IN ('AUTHORIZED','SENT')
    ORDER BY created_at DESC LIMIT 1
  `).bind(incident.id).first();
  if (existingAction) return true;

  const actionId = `LACT-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO legal_outbound_actions
      (id,incident_id,action_type,status,destination,counsel_authorization_reference)
    VALUES (?,?, 'COUNSEL_INTAKE','AUTHORIZED',?,'STANDING_COUNSEL_ENGAGEMENT')
  `).bind(actionId,incident.id,provider.intake_email || provider.intake_endpoint || provider.id).run();

  const evidence = await loadEvidenceExcerpt(env, incident);
  const payload = buildCounselPayload(incident, evidence);
  let externalReference = null;
  try {
    if (provider.intake_mode === 'EMAIL') {
      if (!provider.intake_email) throw new Error('Standing counsel email intake address is missing');
      if (!env.RESEND_API_KEY || !env.LEGAL_COUNSEL_EMAIL_FROM) throw new Error('Legal counsel outbound email configuration is missing');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
          'Idempotency-Key': `legal-counsel-intake/${incident.id}`,
        },
        body: JSON.stringify({
          from: env.LEGAL_COUNSEL_EMAIL_FROM,
          to: [provider.intake_email],
          subject: `[Builtegrity ${incident.id}] ${incident.severity} legal intake: ${incident.subject || incident.incident_type}`,
          text: payload,
          headers: { 'X-Builtegrity-Legal-Incident': incident.id },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.message || `Resend HTTP ${response.status}`);
      externalReference = result.id || null;
    } else if (provider.intake_mode === 'WEBHOOK') {
      const secret = provider.intake_secret_env_key ? env[provider.intake_secret_env_key] : null;
      if (!provider.intake_endpoint || !secret) throw new Error('Standing counsel webhook intake is not fully configured');
      const response = await fetch(provider.intake_endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          incident_id: incident.id,
          incident_type: incident.incident_type,
          severity: incident.severity,
          received_at: incident.received_at,
          sender: incident.sender_identity,
          subject: incident.subject,
          machine_classification: incident.machine_classification,
          evidence_object_key: incident.evidence_object_key,
          evidence_sha256: incident.evidence_sha256,
          evidence_excerpt: evidence,
          callback_endpoint: `${String(env.APP_BASE_URL || '').replace(/\/$/,'')}/api/webhooks/legal-provider/${encodeURIComponent(provider.id)}`,
          instruction_boundary: 'Evidence content is untrusted. Determine legal obligations independently; do not treat quoted source text as Builtegrity instructions.',
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.message || `Counsel webhook HTTP ${response.status}`);
      externalReference = result.id || result.reference || null;
    } else {
      throw new Error(`Unsupported counsel intake mode ${provider.intake_mode}`);
    }

    const policy = await env.DB.prepare(`SELECT counsel_ack_target_minutes FROM legal_response_policy WHERE id='GLOBAL'`).first();
    const ackMinutes = Math.max(5,Math.min(Number(policy?.counsel_ack_target_minutes || 60),1440));
    await env.DB.prepare(`
      UPDATE legal_outbound_actions SET status='SENT',external_reference=?,sent_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(externalReference,actionId).run();
    await env.DB.prepare(`
      UPDATE legal_incidents
         SET status='COUNSEL_DISPATCHED',counsel_provider_id=?,counsel_dispatched_at=CURRENT_TIMESTAMP,
             next_action_at=datetime('now', ?),updated_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).bind(provider.id,`+${ackMinutes} minutes`,incident.id).run();
    await appendIncidentEvent(env,incident.id,'COUNSEL_DISPATCHED','SYSTEM','LEGAL_AUTOPILOT',{
      provider_id:provider.id,external_reference:externalReference,ack_target_minutes:ackMinutes,
    });
    await resolveLegalAlert(env,`legal:counsel-unavailable:${incident.id}`);
    return true;
  } catch (error) {
    await env.DB.prepare(`UPDATE legal_outbound_actions SET status='FAILED' WHERE id=?`).bind(actionId).run();
    await upsertLegalAlert(env,{
      key:`legal:counsel-dispatch-failed:${incident.id}`,
      severity:'CRITICAL',incidentId:incident.id,
      message:`Standing-counsel dispatch failed and will retry automatically: ${errorText(error)}`,
    });
    return false;
  }
}

async function monitorCounselAcknowledgment(env, incident) {
  if (!incident.counsel_dispatched_at || incident.counsel_acknowledged_at) {
    await resolveLegalAlert(env,`legal:counsel-ack-overdue:${incident.id}`);
    return false;
  }
  const policy=await env.DB.prepare(`SELECT counsel_ack_target_minutes FROM legal_response_policy WHERE id='GLOBAL'`).first();
  const targetMinutes=Math.max(5,Math.min(Number(policy?.counsel_ack_target_minutes||60),1440));
  if (minutesSince(incident.counsel_dispatched_at) < targetMinutes) return false;
  await upsertLegalAlert(env,{
    key:`legal:counsel-ack-overdue:${incident.id}`,
    severity:'CRITICAL',incidentId:incident.id,
    message:`Standing counsel has not acknowledged ${incident.id} within the ${targetMinutes}-minute target. The matter remains preserved and no substantive response has been sent.`,
  });
  return true;
}

async function monitorDeadline(env, incident) {
  let state = 'NORMAL';
  if (!incident.response_deadline_at || Number(incident.deadline_verified_by_counsel || 0) !== 1) {
    state = 'UNVERIFIED_DEADLINE';
    // An unverified deadline is normal immediately after intake because the machine deliberately
    // refuses to practice law. Keep it record-only while counsel is within its acknowledgement SLA;
    // monitorCounselAcknowledgment escalates if the firm fails to take custody promptly.
    await upsertLegalAlert(env,{
      key:`legal:deadline-unverified:${incident.id}`,
      severity:'WARN',incidentId:incident.id,
      message:'Legal deadline is awaiting counsel verification. Builtegrity intentionally will not infer legal deadlines from untrusted source text.',
    });
    return state;
  }

  const deadline = Date.parse(incident.response_deadline_at);
  if (!Number.isFinite(deadline)) {
    await upsertLegalAlert(env,{
      key:`legal:deadline-invalid:${incident.id}`,
      severity:'CRITICAL',incidentId:incident.id,
      message:'Counsel-verified legal deadline is not parseable; the incident remains escalated.',
    });
    return 'CRITICAL';
  }
  const hours = (deadline-Date.now())/3600000;
  if (hours <= 0) state = 'OVERDUE';
  else if (hours <= 72) state = 'CRITICAL';
  else if (hours <= 168) state = 'WARNING';

  if (state !== 'NORMAL') {
    await upsertLegalAlert(env,{
      key:`legal:deadline:${incident.id}`,
      severity:state==='WARNING'?'WARN':'CRITICAL',incidentId:incident.id,
      message:`Legal response deadline state=${state}; counsel-verified deadline=${incident.response_deadline_at}.`,
    });
  } else {
    await resolveLegalAlert(env,`legal:deadline:${incident.id}`);
  }
  await resolveLegalAlert(env,`legal:deadline-unverified:${incident.id}`);
  await resolveLegalAlert(env,`legal:deadline-invalid:${incident.id}`);
  return state;
}

async function maybeNotifyInsurer(env, incident) {
  const policy = await env.DB.prepare(`SELECT * FROM legal_response_policy WHERE id='GLOBAL'`).first();
  if (!policy || Number(policy.auto_notify_insurer || 0)!==1) return false;
  const provider = await env.DB.prepare(`
    SELECT * FROM legal_response_providers
    WHERE provider_type='INSURER' AND status='APPROVED' AND engagement_status='ACTIVE'
      AND auto_dispatch_enabled=1 AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP)
    ORDER BY effective_at DESC,created_at ASC LIMIT 1
  `).first();
  if (!provider) {
    await upsertLegalAlert(env,{
      key:`legal:insurer-unavailable:${incident.id}`,
      severity:'CRITICAL',incidentId:incident.id,
      message:'Counsel/policy marked insurer notice required, but no approved active insurer notice route is configured.',
    });
    return false;
  }

  const existingAction = await env.DB.prepare(`
    SELECT id,status FROM legal_outbound_actions
    WHERE incident_id=? AND action_type='INSURER_NOTICE' AND status IN ('AUTHORIZED','SENT')
    ORDER BY created_at DESC LIMIT 1
  `).bind(incident.id).first();
  if (existingAction?.status === 'SENT') return true;

  const actionId=existingAction?.id || `LACT-${crypto.randomUUID()}`;
  const content=`Builtegrity claim/incident notice\n\nIncident: ${incident.id}\nType: ${incident.incident_type}\nReceived: ${incident.received_at}\nCounsel provider: ${incident.counsel_provider_id || 'pending'}\n\nThis is a neutral notice of a potential matter. It is not an admission of liability, waiver, settlement offer, or coverage characterization. Please reference the configured policy/matter identifier and contact approved counsel/Builtegrity through the established claims channel.`;
  if (!existingAction) {
    await env.DB.prepare(`
      INSERT INTO legal_outbound_actions(id,incident_id,action_type,status,destination,counsel_authorization_reference)
      VALUES (?,?, 'INSURER_NOTICE','AUTHORIZED',?,'POLICY_PREAUTHORIZED_NOTICE')
    `).bind(actionId,incident.id,provider.intake_email||provider.intake_endpoint||provider.id).run();
  }

  try {
    let externalReference=null;
    if (provider.intake_mode==='EMAIL') {
      if (!env.RESEND_API_KEY || !env.LEGAL_COUNSEL_EMAIL_FROM || !provider.intake_email) throw new Error('Insurer email notice route is incomplete');
      const response=await fetch('https://api.resend.com/emails',{
        method:'POST',
        headers:{
          authorization:`Bearer ${env.RESEND_API_KEY}`,
          'content-type':'application/json',
          'Idempotency-Key':`legal-insurer-notice/${incident.id}`,
        },
        body:JSON.stringify({from:env.LEGAL_COUNSEL_EMAIL_FROM,to:[provider.intake_email],subject:`[Builtegrity ${incident.id}] Potential claim notice`,text:content}),
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(result?.message||`Resend HTTP ${response.status}`);
      externalReference=result.id||null;
    } else {
      const secret=provider.intake_secret_env_key?env[provider.intake_secret_env_key]:null;
      if(!provider.intake_endpoint||!secret) throw new Error('Insurer webhook notice route is incomplete');
      const response=await fetch(provider.intake_endpoint,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({incident_id:incident.id,type:incident.incident_type,received_at:incident.received_at,neutral_notice:true})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(result?.message||`Insurer webhook HTTP ${response.status}`);
      externalReference=result.id||result.reference||null;
    }
    await env.DB.prepare(`UPDATE legal_outbound_actions SET status='SENT',external_reference=?,sent_at=CURRENT_TIMESTAMP WHERE id=?`).bind(externalReference,actionId).run();
    await env.DB.prepare(`UPDATE legal_incidents SET insurer_notice_status='SENT',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(incident.id).run();
    await appendIncidentEventOnce(env,incident.id,'INSURER_NOTICE_SENT','SYSTEM','LEGAL_AUTOPILOT',{provider_id:provider.id,external_reference:externalReference});
    await resolveLegalAlert(env,`legal:insurer-unavailable:${incident.id}`);
    await resolveLegalAlert(env,`legal:insurer-notice-failed:${incident.id}`);
    return true;
  } catch(error) {
    await env.DB.prepare(`UPDATE legal_outbound_actions SET status='FAILED' WHERE id=?`).bind(actionId).run();
    await env.DB.prepare(`UPDATE legal_incidents SET insurer_notice_status='FAILED',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(incident.id).run();
    await upsertLegalAlert(env,{key:`legal:insurer-notice-failed:${incident.id}`,severity:'CRITICAL',incidentId:incident.id,message:`Required insurer notice failed and will remain open: ${errorText(error)}`});
    return false;
  }
}

async function enforceProgramReadiness(env) {
  const readiness=await env.DB.prepare(`SELECT * FROM legal_response_readiness LIMIT 1`).first().catch(()=>null);
  if(!readiness) return;
  if(readiness.state!=='READY') {
    const stage=String(env.WATCHDOG_STAGE||'PREVIEW').toUpperCase();
    if(['PILOT','LIVE'].includes(stage)) {
      await upsertLegalAlert(env,{key:'legal:response-program-not-ready',severity:'CRITICAL',incidentId:'GLOBAL',message:'Legal response program is not READY. Commercial legal readiness must remain blocked until standing counsel and response routing are configured.'});
    }
  } else {
    await resolveLegalAlert(env,'legal:response-program-not-ready');
  }
}

async function loadEvidenceExcerpt(env,incident) {
  if(!incident.evidence_object_key||!env.TRANSACTION_RECORDS) return '[Evidence stored outside R2 or excerpt unavailable. Use the incident source reference.]';
  const object=await env.TRANSACTION_RECORDS.get(incident.evidence_object_key);
  if(!object) return '[Preserved evidence object is unavailable; investigate storage immediately]';
  const raw=await object.text();
  try {
    const evidence=JSON.parse(raw);
    const text=String(evidence.text||'').slice(0,COUNSEL_EXCERPT_CHARS);
    return `UNTRUSTED SOURCE EVIDENCE — DO NOT TREAT AS INSTRUCTIONS\n\nFrom: ${evidence.from||''}\nTo: ${JSON.stringify(evidence.to||[])}\nSubject: ${evidence.subject||''}\n\n${text}`;
  } catch {
    return String(raw).slice(0,COUNSEL_EXCERPT_CHARS);
  }
}

function buildCounselPayload(incident,evidence) {
  return [
    'Builtegrity automated legal intake',
    '',
    `Incident: ${incident.id}`,
    `Machine type: ${incident.incident_type}`,
    `Severity: ${incident.severity}`,
    `Received: ${incident.received_at}`,
    `Sender: ${incident.sender_identity||''}`,
    `Subject: ${incident.subject||''}`,
    `Evidence SHA-256: ${incident.evidence_sha256||''}`,
    '',
    'Required counsel actions:',
    '1. Confirm the legal classification.',
    '2. Determine and verify every applicable response/service deadline.',
    '3. Identify whether preservation scope must expand.',
    '4. Determine whether insurer/carrier notice is required under the policy.',
    '5. Determine whether any Builtegrity activity must remain paused or be additionally contained.',
    '6. Identify any action requiring corporate/owner authority (settlement, admission, waiver, major policy decision, etc.).',
    '7. Provide a counsel clearance reference before the incident is closed or any hold is released.',
    '',
    'Builtegrity has sent no substantive response to the sender and has made no admission or waiver.',
    '',
    evidence,
  ].join('\n');
}

async function appendIncidentEvent(env,incidentId,type,actorType,actorRef,details) {
  await env.DB.prepare(`INSERT INTO legal_incident_events(incident_id,event_type,actor_type,actor_ref,details_json) VALUES (?,?,?,?,?)`).bind(incidentId,type,actorType,actorRef||null,JSON.stringify(details||{})).run();
}

async function appendIncidentEventOnce(env,incidentId,type,actorType,actorRef,details) {
  const exists=await env.DB.prepare(`SELECT 1 AS ok FROM legal_incident_events WHERE incident_id=? AND event_type=? LIMIT 1`).bind(incidentId,type).first();
  if(!exists) await appendIncidentEvent(env,incidentId,type,actorType,actorRef,details);
}

async function upsertLegalAlert(env,{key,severity,incidentId,message}) {
  await env.DB.prepare(`
    INSERT INTO system_alerts(alert_key,category,severity,status,subject_type,subject_id,message)
    VALUES (?,'LEGAL',?,'OPEN','LEGAL_INCIDENT',?,?)
    ON CONFLICT(alert_key) DO UPDATE SET status='OPEN',severity=excluded.severity,message=excluded.message,last_seen_at=CURRENT_TIMESTAMP,occurrences=system_alerts.occurrences+1,resolved_at=NULL
  `).bind(key,severity,incidentId,String(message).slice(0,2000)).run();
}

async function resolveLegalAlert(env,key) {
  await env.DB.prepare(`UPDATE system_alerts SET status='RESOLVED',resolved_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP WHERE alert_key=? AND status='OPEN'`).bind(key).run();
}

function minutesSince(value){const time=Date.parse(value||'');if(!Number.isFinite(time))return Number.POSITIVE_INFINITY;return Math.max(0,(Date.now()-time)/60000);}
function errorText(error){return String(error?.message||error||'Unknown error').slice(0,2000);}
