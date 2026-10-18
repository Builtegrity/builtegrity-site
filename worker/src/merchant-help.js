import { authenticateClerkSession } from './clerk-auth.js';
import { requireMerchantMembership } from './authorization.js';

const TOPICS=new Set(['CONNECT_SOURCE','CUSTOM_FIELDS','BANK_ACCESS','TRANSACTION','BILLING','OTHER']);
const danger=/\b(?:sk_test_|sk_live_|pk_live_|bg_sync_[a-f0-9]{20,}|Bearer\s+[A-Za-z0-9_.-]{15,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:routing|account|card)\s*(?:number|#)?\s*[:=]\s*\d{8,})/i;
function response(payload,status=200){
 return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json',
  'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
function error(message,status=400){const e=new Error(message);e.status=status;return e;}
function requireSameOrigin(request){
 const origin=request.headers.get('origin');
 if(origin&&origin!==new URL(request.url).origin)throw error('Cross-origin request denied',403);
 const site=request.headers.get('sec-fetch-site');
 if(site&&site!=='same-origin'&&site!=='none')throw error('Cross-site request denied',403);
}
function cleaned(x,max,min=0){
 const text=String(x??'').trim();
 if(text.length<min||text.length>max)throw error('Please check the length of the submitted details');
 if(danger.test(text))throw error('Do not submit secret keys, banking credentials, or full account/card numbers');
 return text;
}
export function validateHelpRequest(body) {
 if(!TOPICS.has(body?.topic))throw error('Select a support topic');
 return {
  topic:body.topic,
  subject:cleaned(body.subject,140,5),
  description:cleaned(body.description,4000,20),
  source_system:cleaned(body.source_system,100),
  desired_outcome:cleaned(body.desired_outcome,500),
  example_reference:cleaned(body.example_reference,120)
 };
}
export async function handleMerchantHelpRoute(request,env){
 const url=new URL(request.url);
 if(url.pathname!=='/api/merchant/help')return null;
 if(!['POST','GET'].includes(request.method))return response({error:'Unsupported request method'},405);
 if(request.method==='POST')requireSameOrigin(request);
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub||principal.claims?.act)return response({error:'Merchant sign-in required'},401);
 let body={};
 if(request.method==='POST'){
  const size=Number(request.headers.get('content-length')||0);
  if(size>7000)return response({error:'Support request is too large'},413);
  const text=await request.text();
  if(new TextEncoder().encode(text).byteLength>7000)return response({error:'Support request is too large'},413);
  try{body=JSON.parse(text);}catch{return response({error:'Valid form JSON is required'},400);}
 }
 const merchantId=request.method==='POST'?body.merchant_id:url.searchParams.get('merchant_id');
 if(!/^MER-[A-Za-z0-9-]+$/.test(String(merchantId||'')))
  return response({error:'Choose a merchant account'},400);
 const member=await requireMerchantMembership(env,principal,merchantId,'VIEWER');
 if(request.method==='GET'){
  const rows=await env.DB.prepare(`
   SELECT id,topic,subject,request_status,delivery_state,created_at,emailed_at
   FROM merchant_help_requests WHERE merchant_id=?
    AND (?='OWNER' OR created_by=?)
   ORDER BY created_at DESC,id DESC LIMIT 40
  `).bind(merchantId,member.role,principal.sub).all();
  return response({requests:rows.results||[],email_delivery_configured:Boolean(
   env.MERCHANT_HELP_EMAILS_ENABLED==='true'&&env.HELP_REQUEST_EMAIL_TO&&env.RESEND_API_KEY)});
 }
 const submission=validateHelpRequest(body);
 const quota=await env.DB.prepare(`
  SELECT COUNT(*) AS count FROM merchant_help_requests
  WHERE merchant_id=? AND created_by=? AND datetime(created_at)>=datetime('now','-1 day')
 `).bind(merchantId,principal.sub).first();
 if(Number(quota?.count)>=8)return response({error:'Daily request limit reached. Review your previous requests.'},429);
 const id='HELP-'+crypto.randomUUID();
 await env.DB.prepare(`
  INSERT INTO merchant_help_requests
   (id,merchant_id,created_by,topic,subject,description,source_system,desired_outcome,
    example_reference)
  VALUES(?,?,?,?,?,?,?,?,?)
 `).bind(id,merchantId,principal.sub,submission.topic,submission.subject,
  submission.description,submission.source_system,submission.desired_outcome,
  submission.example_reference).run();
 return response({id,status:'OPEN',
   delivery:'QUEUED',
   message:'Your request is saved in your account. Builtegrity will notify the help inbox when notification delivery is configured.'},201);
}
export async function deliverMerchantHelpRequests(env,{limit=5}={}){
 if(env.MERCHANT_HELP_EMAILS_ENABLED!=='true'||!env.RESEND_API_KEY||
  !env.HELP_REQUEST_EMAIL_FROM||!env.HELP_REQUEST_EMAIL_TO)
  return {email_enabled:false,sent:0,queued:0};
 const rows=await env.DB.prepare(`
   SELECT h.*,m.name AS merchant_name FROM merchant_help_requests h
   JOIN merchants m ON m.id=h.merchant_id
   WHERE h.delivery_state IN ('QUEUED','ERROR') AND h.email_attempts<5
     AND (h.last_attempt_at IS NULL
       OR datetime(h.last_attempt_at)<=datetime('now','-30 minutes'))
   ORDER BY h.created_at ASC LIMIT ?
 `).bind(Math.max(1,Math.min(10,limit))).all();
 let sent=0,failed=0;
 for(const row of rows.results||[]){
  const details=[
   'Builtegrity merchant help request '+row.id,
   'Merchant: '+row.merchant_name+' ('+row.merchant_id+')',
   'Topic: '+row.topic,
   'Subject: '+row.subject,
   'Source: '+(row.source_system||'Not supplied'),
   'Example reference: '+(row.example_reference||'Not supplied'),
   'Desired integration: '+(row.desired_outcome||'Not supplied'),
   'Details:\n'+row.description,
   'Submitted: '+row.created_at,
   'Request status is tracked in the merchant Help page.'
  ].join('\n\n');
  let state='ERROR',issue=null;
  try{
   const result=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{
      Authorization:'Bearer '+env.RESEND_API_KEY,
      'content-type':'application/json',
      'Idempotency-Key':row.id
    },
    body:JSON.stringify({
      from:env.HELP_REQUEST_EMAIL_FROM,to:[env.HELP_REQUEST_EMAIL_TO],
      subject:'Builtegrity request '+row.id+': '+row.subject,
      text:details
    })
   });
   if(result.ok){state='SENT';sent++;}
   else {issue='Resend returned '+result.status;failed++;}
  }catch(e){issue=String(e.message||e).slice(0,250);failed++;}
  await env.DB.prepare(`
   UPDATE merchant_help_requests SET delivery_state=?,email_attempts=email_attempts+1,
     last_attempt_at=CURRENT_TIMESTAMP,last_email_error=?,
     emailed_at=CASE WHEN ?='SENT' THEN CURRENT_TIMESTAMP ELSE emailed_at END,
     updated_at=CURRENT_TIMESTAMP WHERE id=? AND delivery_state<>'SENT'
  `).bind(state,issue,state,row.id).run();
 }
 return {email_enabled:true,sent,failed};
}
