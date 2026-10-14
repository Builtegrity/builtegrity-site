const SIGNATURE_TOLERANCE_SECONDS = 300;

export async function handleLegalProviderWebhook(request, env, providerId) {
  if (!providerId) return json({ error: 'Missing provider ID' }, 400);
  const provider = await env.DB.prepare(`
    SELECT * FROM legal_response_providers
    WHERE id=? AND status='APPROVED' AND engagement_status='ACTIVE' AND callback_enabled=1
  `).bind(providerId).first();
  if (!provider) return json({ error: 'Legal provider callback is not active' }, 404);

  const secret = provider.callback_secret_env_key ? env[provider.callback_secret_env_key] : null;
  if (!secret) return json({ error: 'Legal provider callback secret is unavailable' }, 503);

  const rawBody = await request.text();
  const timestamp = request.headers.get('X-Builtegrity-Timestamp');
  const signature = request.headers.get('X-Builtegrity-Signature');
  if (!await verifyHmac(rawBody, timestamp, signature, secret)) return json({ error: 'Invalid callback signature' }, 401);

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const externalEventId = String(payload.external_event_id || '').trim();
  const eventType = String(payload.event_type || '').trim().toUpperCase();
  if (!externalEventId || !eventType) return json({ error: 'external_event_id and event_type are required' }, 400);

  const payloadHash = await sha256Hex(new TextEncoder().encode(rawBody));
  const receiptId = `LCB-${crypto.randomUUID()}`;
  try {
    await env.DB.prepare(`
      INSERT INTO legal_provider_callback_receipts
        (id,provider_id,external_event_id,event_type,payload_sha256,status,incident_id)
      VALUES (?,?,?,?,?,'PROCESSING',?)
    `).bind(receiptId,provider.id,externalEventId,eventType,payloadHash,payload.incident_id || null).run();
  } catch (error) {
    const existing = await env.DB.prepare(`
      SELECT * FROM legal_provider_callback_receipts WHERE provider_id=? AND external_event_id=?
    `).bind(provider.id,externalEventId).first();
    if (existing?.status === 'PROCESSED') return json({ received: true, duplicate: true, incident_id: existing.incident_id });
    if (!existing) throw error;
  }

  try {
    let result;
    if (provider.provider_type === 'COUNSEL') result = await handleCounselEvent(env, provider, eventType, payload);
    else if (provider.provider_type === 'REGISTERED_AGENT') result = await handleRegisteredAgentEvent(env, provider, eventType, payload);
    else if (provider.provider_type === 'INSURER') result = await handleInsurerEvent(env, provider, eventType, payload);
    else throw new Error(`Unsupported callback provider type ${provider.provider_type}`);

    await env.DB.prepare(`
      UPDATE legal_provider_callback_receipts
         SET status='PROCESSED',incident_id=?,processed_at=CURRENT_TIMESTAMP,error_text=NULL
       WHERE provider_id=? AND external_event_id=?
    `).bind(result.incident_id || payload.incident_id || null,provider.id,externalEventId).run();
    return json({ received: true, ...result });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE legal_provider_callback_receipts
         SET status='FAILED',error_text=?,processed_at=CURRENT_TIMESTAMP
       WHERE provider_id=? AND external_event_id=?
    `).bind(errorText(error),provider.id,externalEventId).run().catch(()=>null);
    await upsertLegalAlert(env,{
      key:`legal:provider-callback-failed:${provider.id}:${externalEventId}`,
      severity:'CRITICAL',incidentId:payload.incident_id || provider.id,
      message:`Authenticated legal provider callback failed safely: ${errorText(error)}`,
    });
    return json({ error: 'Legal provider callback failed' }, 409);
  }
}

async function handleCounselEvent(env, provider, eventType, payload) {
  const incidentId = requiredString(payload.incident_id,'incident_id');
  const incident = await env.DB.prepare(`SELECT * FROM legal_incidents WHERE id=?`).bind(incidentId).first();
  if (!incident) throw new Error(`Legal incident ${incidentId} not found`);

  if (eventType === 'COUNSEL_ACKNOWLEDGED' || eventType === 'COUNSEL_UPDATE') {
    const deadline = normalizeOptionalDate(payload.response_deadline_at);
    const deadlineVerified = deadline ? 1 : Number(incident.deadline_verified_by_counsel || 0);
    const classification = payload.counsel_classification ? String(payload.counsel_classification).slice(0,1000) : incident.counsel_classification;
    const insurerRequired = payload.insurer_notice_required === undefined
      ? Number(incident.insurer_notice_required || 0)
      : (payload.insurer_notice_required ? 1 : 0);
    const insurerStatus = insurerRequired && incident.insurer_notice_status === 'NOT_REQUIRED' ? 'PENDING' : incident.insurer_notice_status;
    const ownerRequired = payload.owner_authority_required === undefined
      ? Number(incident.owner_authority_required || 0)
      : (payload.owner_authority_required ? 1 : 0);
    const ownerReason = payload.owner_authority_reason === undefined
      ? incident.owner_authority_reason
      : String(payload.owner_authority_reason || '').slice(0,2000) || null;

    await env.DB.prepare(`
      UPDATE legal_incidents
         SET status='COUNSEL_ACKNOWLEDGED',counsel_provider_id=?,counsel_acknowledged_at=COALESCE(counsel_acknowledged_at,CURRENT_TIMESTAMP),
             counsel_classification=?,response_deadline_at=COALESCE(?,response_deadline_at),
             deadline_source=CASE WHEN ? IS NULL THEN deadline_source ELSE 'COUNSEL_VERIFIED' END,
             deadline_verified_by_counsel=?,insurer_notice_required=?,insurer_notice_status=?,
             owner_authority_required=?,owner_authority_reason=?,next_action_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).bind(provider.id,classification,deadline,deadline,deadlineVerified,insurerRequired,insurerStatus,ownerRequired,ownerReason,incidentId).run();

    await appendEvent(env,incidentId,eventType === 'COUNSEL_ACKNOWLEDGED' ? 'COUNSEL_ACKNOWLEDGED' : 'DEADLINE_VERIFIED','COUNSEL',provider.id,{
      counsel_classification:classification,response_deadline_at:deadline,insurer_notice_required:Boolean(insurerRequired),owner_authority_required:Boolean(ownerRequired),
    });
    await resolveLegalAlert(env,`legal:deadline-unverified:${incidentId}`);
    await resolveLegalAlert(env,`legal:counsel-unavailable:${incidentId}`);
    await resolveLegalAlert(env,`legal:counsel-dispatch-failed:${incidentId}`);
    return { incident_id:incidentId,status:'COUNSEL_ACKNOWLEDGED' };
  }

  if (eventType === 'COUNSEL_RESOLVED' || eventType === 'COUNSEL_DISMISSED_NONLEGAL') {
    const clearance = requiredString(payload.counsel_clearance_reference,'counsel_clearance_reference');
    const summary = requiredString(payload.resolution_summary,'resolution_summary').slice(0,4000);
    const newStatus = eventType === 'COUNSEL_RESOLVED' ? 'RESOLVED' : 'DISMISSED_NONLEGAL';
    await env.DB.prepare(`
      UPDATE legal_incidents
         SET status=?,counsel_provider_id=?,counsel_acknowledged_at=COALESCE(counsel_acknowledged_at,CURRENT_TIMESTAMP),
             counsel_clearance_reference=?,resolution_summary=?,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).bind(newStatus,provider.id,clearance,summary,incidentId).run();
    await appendEvent(env,incidentId,'RESOLVED','COUNSEL',provider.id,{clearance_reference:clearance,status:newStatus});

    if (payload.release_holds === true) {
      await env.DB.prepare(`
        UPDATE legal_preservation_holds
           SET status='RELEASED',released_at=CURRENT_TIMESTAMP,release_counsel_reference=?
         WHERE incident_id=? AND status='ACTIVE'
      `).bind(clearance,incidentId).run();
      await appendEvent(env,incidentId,'HOLD_RELEASED','COUNSEL',provider.id,{clearance_reference:clearance});
    }
    await resolveIncidentAlerts(env,incidentId);
    return { incident_id:incidentId,status:newStatus };
  }

  if (eventType === 'COUNSEL_OWNER_AUTHORITY_REQUIRED') {
    const reason = requiredString(payload.owner_authority_reason,'owner_authority_reason').slice(0,2000);
    await env.DB.prepare(`
      UPDATE legal_incidents SET owner_authority_required=1,owner_authority_reason=?,status='ACTION_REQUIRED',updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(reason,incidentId).run();
    await appendEvent(env,incidentId,'OWNER_AUTHORITY_REQUESTED','COUNSEL',provider.id,{reason});
    return { incident_id:incidentId,status:'ACTION_REQUIRED' };
  }

  throw new Error(`Unsupported counsel event_type ${eventType}`);
}

async function handleRegisteredAgentEvent(env, provider, eventType, payload) {
  if (eventType !== 'REGISTERED_AGENT_NOTICE') throw new Error(`Unsupported registered-agent event_type ${eventType}`);
  const sourceExternalId = requiredString(payload.source_external_id,'source_external_id');
  const receivedAt = normalizeRequiredDate(payload.received_at,'received_at');
  const incidentId = `LEGAL-RA-${provider.id}-${safeKey(sourceExternalId)}`.slice(0,240);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO legal_incidents(
      id,incident_type,severity,status,source_channel,source_provider_id,source_external_id,
      sender_identity,recipient_identity,subject,received_at,machine_classification,machine_confidence_ppm,
      next_action_at,preservation_hold_active
    ) VALUES (?,?,?,?, 'REGISTERED_AGENT',?,?,?,?,?,?,?,1000000,CURRENT_TIMESTAMP,1)
  `).bind(
    incidentId,String(payload.incident_type || 'SUMMONS_COMPLAINT').toUpperCase(),String(payload.severity || 'CRITICAL').toUpperCase(),
    'PRESERVED',provider.id,sourceExternalId,String(payload.sender_identity || '').slice(0,1000),String(payload.recipient_identity || '').slice(0,1000),
    String(payload.subject || 'Registered agent legal notice').slice(0,2000),receivedAt,'Authenticated registered-agent callback; legal characterization remains subject to counsel.',
  ).run();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO legal_preservation_holds(id,incident_id,scope_type,scope_id,reason)
    VALUES (?,?, 'PLATFORM','GLOBAL','Registered-agent service/process notice requires preservation until counsel release.')
  `).bind(`LHOLD-RA-${safeKey(sourceExternalId)}`.slice(0,240),incidentId).run();
  await appendEventOnce(env,incidentId,'RECEIVED','REGISTERED_AGENT',provider.id,{external_reference:sourceExternalId,document_reference:payload.document_reference || null});
  await upsertLegalAlert(env,{key:`legal:registered-agent:${incidentId}`,severity:'CRITICAL',incidentId,message:'Authenticated registered-agent legal notice received; standing counsel routing is required immediately.'});
  return { incident_id:incidentId,status:'PRESERVED' };
}

async function handleInsurerEvent(env, provider, eventType, payload) {
  const incidentId = requiredString(payload.incident_id,'incident_id');
  if (eventType !== 'INSURER_ACKNOWLEDGED') throw new Error(`Unsupported insurer event_type ${eventType}`);
  const incident = await env.DB.prepare(`SELECT id FROM legal_incidents WHERE id=?`).bind(incidentId).first();
  if (!incident) throw new Error(`Legal incident ${incidentId} not found`);
  await env.DB.prepare(`UPDATE legal_incidents SET insurer_notice_status='SENT',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(incidentId).run();
  await appendEvent(env,incidentId,'EXTERNAL_ACTION','INSURER',provider.id,{claim_reference:payload.claim_reference || null});
  await resolveLegalAlert(env,`legal:insurer-notice-failed:${incidentId}`);
  return { incident_id:incidentId,status:'INSURER_ACKNOWLEDGED' };
}

async function verifyHmac(body,timestamp,signature,secret) {
  if(!timestamp||!signature||!secret) return false;
  const seconds=Number(timestamp);
  if(!Number.isFinite(seconds)||Math.abs(Math.floor(Date.now()/1000)-seconds)>SIGNATURE_TOLERANCE_SECONDS) return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${body}`));
  const expected=[...new Uint8Array(digest)].map((b)=>b.toString(16).padStart(2,'0')).join('');
  return timingSafeEqual(expected,String(signature).replace(/^sha256=/i,'').toLowerCase());
}

function timingSafeEqual(a,b){if(a.length!==b.length)return false;let mismatch=0;for(let i=0;i<a.length;i+=1)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);return mismatch===0;}
async function sha256Hex(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(digest)].map((b)=>b.toString(16).padStart(2,'0')).join('');}
function requiredString(v,name){const s=String(v||'').trim();if(!s)throw new Error(`${name} is required`);return s;}
function normalizeRequiredDate(v,name){const d=normalizeOptionalDate(v);if(!d)throw new Error(`${name} must be a valid date`);return d;}
function normalizeOptionalDate(v){if(!v)return null;const d=new Date(v);return Number.isFinite(d.getTime())?d.toISOString():null;}
function safeKey(v){return String(v||'').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100)||crypto.randomUUID();}
function errorText(error){return String(error?.message||error||'Unknown error').slice(0,2000);}

async function appendEvent(env,incidentId,type,actorType,actorRef,details){await env.DB.prepare(`INSERT INTO legal_incident_events(incident_id,event_type,actor_type,actor_ref,details_json) VALUES (?,?,?,?,?)`).bind(incidentId,type,actorType,actorRef||null,JSON.stringify(details||{})).run();}
async function appendEventOnce(env,incidentId,type,actorType,actorRef,details){const x=await env.DB.prepare(`SELECT 1 FROM legal_incident_events WHERE incident_id=? AND event_type=? LIMIT 1`).bind(incidentId,type).first();if(!x)await appendEvent(env,incidentId,type,actorType,actorRef,details);}
async function upsertLegalAlert(env,{key,severity,incidentId,message}){await env.DB.prepare(`INSERT INTO system_alerts(alert_key,category,severity,status,subject_type,subject_id,message) VALUES (?,'LEGAL',?,'OPEN','LEGAL_INCIDENT',?,?) ON CONFLICT(alert_key) DO UPDATE SET status='OPEN',severity=excluded.severity,message=excluded.message,last_seen_at=CURRENT_TIMESTAMP,occurrences=system_alerts.occurrences+1,resolved_at=NULL`).bind(key,severity,incidentId,String(message).slice(0,2000)).run();}
async function resolveLegalAlert(env,key){await env.DB.prepare(`UPDATE system_alerts SET status='RESOLVED',resolved_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP WHERE alert_key=? AND status='OPEN'`).bind(key).run();}
async function resolveIncidentAlerts(env,incidentId){await env.DB.prepare(`UPDATE system_alerts SET status='RESOLVED',resolved_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP WHERE category='LEGAL' AND subject_id=? AND status='OPEN'`).bind(incidentId).run();}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});}
