// Provider timestamps are event-creation times. We cannot know or schedule an exact
// provider publication instant; compare these timestamps to verified webhook receipt.
export function normalizeProviderEvent(processor,event,receivedAt=new Date().toISOString()) {
  if(!['STRIPE','SQUARE'].includes(processor))throw Error('Unsupported processor');
  const id=processor==='STRIPE'?event?.id:event?.event_id;
  if(!id||typeof id!=='string'||id.length>255)throw Error('Invalid provider event ID');
  const raw=processor==='STRIPE'&&typeof event?.created==='number'
    ?new Date(event.created*1000).toISOString():event?.created_at;
  const providerTime=raw&&Number.isFinite(Date.parse(raw))
    ?new Date(raw).toISOString():null;
  return {
    processor,id,eventType:String(event?.type||'unknown').slice(0,100),
    providerAccount:String(processor==='STRIPE'?event?.account||'':event?.merchant_id||'').slice(0,255),
    providerTime,receivedAt
  };
}
export async function recordProviderReceipt(env,data){
  await env.DB.prepare(`
    INSERT INTO processor_event_delivery_audit
      (processor,provider_event_id,event_type,provider_account_id,provider_event_created_at,received_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(processor,provider_event_id) DO UPDATE SET
      attempts=processor_event_delivery_audit.attempts+1,
      last_delivery_at=CURRENT_TIMESTAMP
  `).bind(data.processor,data.id,data.eventType,data.providerAccount,
    data.providerTime,data.receivedAt).run();
}
export async function recordProviderResult(env,data,error=null){
  await env.DB.prepare(`
    UPDATE processor_event_delivery_audit SET
      outcome=?,processed_at=CURRENT_TIMESTAMP,last_error=?
    WHERE processor=? AND provider_event_id=?
  `).bind(error?'FAILED':'PROCESSED',
    error?String(error?.message||error).slice(0,300):null,data.processor,data.id).run();
}
export async function webhookTimingSummary(env){
  const result=await env.DB.prepare(`
    SELECT processor,COUNT(*) AS tracked_events,
      SUM(CASE WHEN outcome='PROCESSED' THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN outcome='FAILED' THEN 1 ELSE 0 END) AS failed,
      ROUND(AVG(CASE
        WHEN provider_event_created_at IS NOT NULL
         AND julianday(received_at)>=julianday(provider_event_created_at)
        THEN (julianday(received_at)-julianday(provider_event_created_at))*86400000
        ELSE NULL END)) AS average_delivery_lag_ms,
      MAX(received_at) AS last_received_at
    FROM processor_event_delivery_audit
    WHERE datetime(received_at)>=datetime('now','-24 hours')
    GROUP BY processor ORDER BY processor
  `).all();
  return {window:'24h',timestamp_definition:'processor event created -> signed webhook received',
    timing_is_guaranteed:false,results:result.results||[]};
}
