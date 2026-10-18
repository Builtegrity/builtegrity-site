import {authenticateClerkSession} from './clerk-auth.js';
import {requireMerchantMembership} from './authorization.js';

const choices=new Set(['INTEGRATION','FIELD_MAPPING','IMPORT_ISSUE','BANK_ACCESS','OTHER']);
const clean=v=>String(v??'').trim();
const json=(data,status=200)=>new Response(JSON.stringify(data),{
  status,headers:{'content-type':'application/json','cache-control':'no-store',
    'x-content-type-options':'nosniff'}});
function bad(message,status=400){const e=new Error(message);e.status=status;return e;}
function validateRequest(input){
  const request_type=clean(input.request_type).toUpperCase();
  const service_name=clean(input.service_name);
  const details=clean(input.details);
  const desired_fields=clean(input.desired_fields);
  if(!choices.has(request_type))throw bad('Select a request type.');
  if(!service_name||service_name.length>100)throw bad('Enter a software or service name (up to 100 characters).');
  if(details.length<15||details.length>3000)throw bad('Tell us what you want to connect in 15–3000 characters.');
  if(desired_fields.length>500)throw bad('Field list must be under 500 characters.');
  const combined=[service_name,details,desired_fields].join(' ');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk_live_|rk_live_|bg_sync_[a-f0-9]{30,}|access_token\s*[:=]|password\s*[:=]/i.test(combined))
    throw bad('Do not include API keys, passwords, bank credentials or private tokens in help requests.');
  return {request_type,service_name,details,desired_fields:desired_fields||null};
}
function sameOrigin(request){
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)throw bad('Request must come from this merchant portal',403);
  if(['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')))
    throw bad('Cross-site submission refused',403);
}
export async function handleMerchantHelpRoute(request,env){
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/merchant/help/'))return null;
  if(request.method!=='POST'&&request.method!=='GET')return json({error:'Method not allowed'},405);
  const principal=await authenticateClerkSession(request,env);
  if(!principal?.sub||principal.claims?.act)return json({error:'Merchant sign-in required'},401);
  let data;
  if(request.method==='POST'){
    sameOrigin(request);
    const raw=await request.text();
    if(raw.length>5500)return json({error:'Request exceeds maximum form size'},413);
    try{data=JSON.parse(raw);}catch{return json({error:'Valid form data required'},400);}
  }else data=Object.fromEntries(url.searchParams);
  const merchantId=clean(data.merchant_id);
  if(!/^MER-[A-Za-z0-9-]+$/.test(merchantId))return json({error:'Merchant is required'},400);
  await requireMerchantMembership(env,principal,merchantId,request.method==='POST'?'OWNER':'VIEWER');
  if(url.pathname==='/api/merchant/help/requests'&&request.method==='GET'){
    const rows=await env.DB.prepare(`SELECT id,request_type,service_name,desired_fields,status,
      email_status,created_at FROM merchant_help_requests
      WHERE merchant_id=? ORDER BY created_at DESC,id DESC LIMIT 50`)
      .bind(merchantId).all();
    return json({requests:rows.results||[],staff_involvement_required:false,
      description:'Most setup steps are self-service. Unsupported connectors can be requested.'});
  }
  if(url.pathname==='/api/merchant/help/submit'&&request.method==='POST'){
    const count=await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM merchant_help_requests WHERE merchant_id=?
      AND datetime(created_at)>=datetime('now','-24 hours')`).bind(merchantId).first();
    if(Number(count?.count)>=5)return json({error:'Maximum 5 requests per merchant per 24 hours. Review your existing requests first.'},429);
    let payload;try{payload=validateRequest(data);}catch(e){return json({error:e.message},e.status||400);}
    const id='HELP-'+crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO merchant_help_requests
      (id,merchant_id,created_by,request_type,service_name,details,desired_fields)
      VALUES(?,?,?,?,?,?,?)`).bind(id,merchantId,principal.sub,
        payload.request_type,payload.service_name,payload.details,payload.desired_fields).run();
    // Background delivery is handled by the 10-minute scheduled dispatcher.
    // The response never claims a support email was delivered prematurely.
    return json({id,status:'RECEIVED',email_delivery:'PENDING',
      guidance:'Request saved. No credentials are needed; ordinary integration configuration remains self-service.'},201);
  }
  return json({error:'Unknown merchant help action'},404);
}
async function sendSupportEmail(env,record){
  if(env.MERCHANT_HELP_EMAILS_ENABLED!=='true'||!env.RESEND_API_KEY||
    !env.MERCHANT_HELP_EMAIL_FROM||!env.MERCHANT_HELP_EMAIL_TO)return {sent:false,reason:'not_configured'};
  const sender=String(env.MERCHANT_HELP_EMAIL_FROM),recipient=String(env.MERCHANT_HELP_EMAIL_TO);
  if(!/^\S+@\S+\.\S+$/.test(recipient)||!sender.includes('@'))
    return {sent:false,reason:'email_addresses_invalid'};
  const text=[
    'Merchant-requested Builtegrity integration assistance (not a payment action)',
    'Ticket: '+record.id,
    'Merchant: '+record.merchant_name+' ('+record.merchant_id+')',
    'Category: '+record.request_type,
    'External service: '+record.service_name,
    'Requested custom fields: '+(record.desired_fields||'not specified'),
    'Details:',record.details,
    'Submitted: '+record.created_at,
    'Do not ask the merchant to email bank passwords, API secrets, or private keys.'
  ].join('\n');
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,
      'content-type':'application/json','Idempotency-Key':record.id},
    body:JSON.stringify({from:sender,to:[recipient],
      subject:'Builtegrity request '+record.id+' · '+record.request_type,
      text})
  });
  return {sent:response.ok,reason:response.ok?'sent':String(response.status)};
}
export async function dispatchMerchantHelpRequests(env,{limit=10}={}){
  if(env.MERCHANT_HELP_EMAILS_ENABLED!=='true')return {configured:false,sent:0};
  const rows=await env.DB.prepare(`SELECT r.*,m.name AS merchant_name
   FROM merchant_help_requests r JOIN merchants m ON m.id=r.merchant_id
   WHERE r.email_status IN('NOT_SENT','ERROR') AND r.notification_attempts<3
   ORDER BY r.created_at ASC LIMIT ?`)
  .bind(Math.min(Math.max(Number(limit)||10,1),20)).all();
  let sent=0,failed=0;
  for(const r of rows.results||[]){
    // Claim before network sending; idempotency key on outbound provider suppresses duplicates.
    const lock=await env.DB.prepare(`UPDATE merchant_help_requests SET
      notification_attempts=notification_attempts+1,last_notification_at=CURRENT_TIMESTAMP
      WHERE id=? AND email_status IN('NOT_SENT','ERROR') AND notification_attempts<3
      RETURNING id`).bind(r.id).first();
    if(!lock)continue;
    try{
      const result=await sendSupportEmail(env,r);
      await env.DB.prepare(`UPDATE merchant_help_requests
       SET email_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(result.sent?'SENT':'ERROR',r.id).run();
      if(result.sent)sent++;else failed++;
    }catch(e){
      failed++;
      console.error('Support request email delivery failed',r.id,String(e.message));
      await env.DB.prepare(`UPDATE merchant_help_requests SET email_status='ERROR',
       updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(r.id).run().catch(()=>{});
    }
  }
  return {configured:true,sent,failed};
}
