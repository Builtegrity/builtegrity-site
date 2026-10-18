// Accountless merchant notification: separate from public customer payment token and
// separately scoped from the authenticated merchant evidence portal.
const expHours=14*24;
const regex=/^\S+@\S+\.\S+$/;
const toHex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
export const sha256=async s=>toHex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
function fail(text,status=400){const e=new Error(text);e.status=status;return e;}
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{
 'content-type':'application/json','cache-control':'no-store','referrer-policy':'no-referrer',
 'x-content-type-options':'nosniff'}});
export async function queueMerchantRecordEmail(env,txId,merchantId){
 if(env.MERCHANT_TRANSACTION_EMAILS_ENABLED!=='true')return {queued:false,reason:'disabled'};
 const merchant=await env.DB.prepare(`
  SELECT m.email,m.record_email_opt_in,
    (SELECT COUNT(*) FROM merchant_access a WHERE a.merchant_id=m.id AND a.status='ACTIVE') AS accounts
  FROM merchants m WHERE m.id=?`).bind(merchantId).first();
 if(!merchant||!merchant.record_email_opt_in||!regex.test(String(merchant.email||'')))
   return {queued:false,reason:'no_consent_or_email'};
 if(Number(merchant.accounts)>0)return {queued:false,reason:'profile_already_exists'};
 const token=randomToken(),hash=await sha256(token);
 // No clear text access token is stored; the send runner creates one at delivery.
 await env.DB.prepare(`INSERT OR IGNORE INTO merchant_transaction_email_links
  (transaction_id,merchant_id,recipient_email,token_sha256,expires_at)
  VALUES(?,?,?,?,datetime('now','+14 days'))`)
   .bind(txId,merchantId,merchant.email,hash).run();
 return {queued:true};
}
async function sendTransactionEmail(env,row,token){
 if(!env.RESEND_API_KEY||!env.MERCHANT_RECORD_EMAIL_FROM)
  return {ok:false,error:'email provider not configured'};
 const domain=String(env.APP_BASE_URL||'https://builtegrity.com').replace(/\/$/,'');
 if(!/^https:\/\/[^/#?]+$/.test(domain))return {ok:false,error:'invalid app base'};
 const url=domain+'/merchant/record/#'+token;
 const response=await fetch('https://api.resend.com/emails',{method:'POST',
  headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json',
    'Idempotency-Key':'merchant-record-'+row.transaction_id+'-'+row.email_attempts},
  body:JSON.stringify({from:env.MERCHANT_RECORD_EMAIL_FROM,to:[row.recipient_email],
   subject:'Your Builtegrity transaction '+row.transaction_id,
   text:[
     'Your business transaction has a Builtegrity record.',
     'You can view this specific transaction without creating an account:',
     url,
     '',
     'This link is private, read-only and expires 14 days after it is issued.',
     'Anyone who obtains the link can see that transaction summary. Do not forward it.',
     'It never grants access to unrelated transactions, customer images, bank data or full merchant account settings.',
     '',
     'Optional: Create a Builtegrity merchant profile at '+domain+'/signup/',
     'Use the same business email address. To link your business account, sign in and return to this private email link to claim access.',
     'You do not need a Builtegrity profile for your payments to be monitored.',
     '',
     'Information updates when the payment processor reports new information; this is not a bank settlement guarantee.'
   ].join('\n')})
 });
 return {ok:response.ok,error:response.ok?null:'Resend '+response.status};
}
export async function dispatchMerchantRecordEmails(env,{limit=8}={}){
 if(env.MERCHANT_TRANSACTION_EMAILS_ENABLED!=='true')return {enabled:false,sent:0};
 const rows=await env.DB.prepare(`
  SELECT r.transaction_id,r.merchant_id,r.recipient_email,r.email_attempts
  FROM merchant_transaction_email_links r JOIN merchants m ON m.id=r.merchant_id
  WHERE (r.email_state IN('QUEUED','RETRY')
     OR (r.email_state='SENDING' AND datetime(r.next_attempt_at)<=CURRENT_TIMESTAMP))
   AND r.email_attempts<4
   AND r.revoked_at IS NULL AND m.record_email_opt_in=1
   AND (r.next_attempt_at IS NULL OR datetime(r.next_attempt_at)<=CURRENT_TIMESTAMP)
   AND NOT EXISTS (SELECT 1 FROM merchant_access a WHERE a.merchant_id=r.merchant_id
      AND a.status='ACTIVE')
  ORDER BY r.created_at ASC LIMIT ?`).bind(Math.min(8,Math.max(1,limit))).all();
 let sent=0,failed=0;
 for(const row of rows.results||[]){
  // Only one scheduled worker may claim this delivery.
  const claim=await env.DB.prepare(`UPDATE merchant_transaction_email_links
    SET email_state='SENDING',email_attempts=email_attempts+1,
      next_attempt_at=datetime('now','+20 minutes')
    WHERE transaction_id=? AND (email_state IN('QUEUED','RETRY')
      OR (email_state='SENDING' AND datetime(next_attempt_at)<=CURRENT_TIMESTAMP))
      AND email_attempts<4 AND revoked_at IS NULL RETURNING email_attempts`)
    .bind(row.transaction_id).first();
  if(!claim)continue;
  const token=randomToken(),hash=await sha256(token);
  // Expiration starts on delivery attempt, not record creation.
  await env.DB.prepare(`UPDATE merchant_transaction_email_links SET token_sha256=?,
    expires_at=datetime('now','+14 days') WHERE transaction_id=? AND email_state='SENDING'`)
    .bind(hash,row.transaction_id).run();
  let result;try{result=await sendTransactionEmail(env,{...row,email_attempts:claim.email_attempts},token);}
  catch(e){result={ok:false,error:String(e.message).slice(0,140)};}
  await env.DB.prepare(`UPDATE merchant_transaction_email_links SET
    email_state=?,emailed_at=CASE WHEN ?='SENT' THEN CURRENT_TIMESTAMP ELSE emailed_at END,
    last_error=?,next_attempt_at=CASE WHEN ?='RETRY' THEN datetime('now','+30 minutes') ELSE NULL END
    WHERE transaction_id=? AND email_state='SENDING'`)
   .bind(result.ok?'SENT':'RETRY',result.ok?'SENT':'RETRY',result.error,
     result.ok?'SENT':'RETRY',row.transaction_id).run();
  result.ok?sent++:failed++;
 }
 return {enabled:true,sent,failed};
}
async function activeToken(env,token){
 if(!/^[a-f0-9]{64}$/.test(String(token||'')))return null;
 const row=await env.DB.prepare(`
  SELECT l.transaction_id,l.merchant_id,l.recipient_email,l.expires_at,l.claimed_by
  FROM merchant_transaction_email_links l JOIN merchants m ON m.id=l.merchant_id
  WHERE l.token_sha256=? AND l.revoked_at IS NULL
    AND l.email_state='SENT' AND datetime(l.expires_at)>CURRENT_TIMESTAMP
    AND m.record_email_opt_in=1 LIMIT 1`).bind(await sha256(token)).first();
 return row||null;
}
export async function lookupMerchantRecordToken(env,token){return activeToken(env,token);}
export function accountlessTransactionProjection(tx){
 return {transaction_id:tx.id,merchant_name:tx.merchant_name,
  merchant_reference:tx.merchant_reference,merchant_payment_reference:tx.merchant_payment_reference,
  processor:tx.processor,amount_cents:tx.amount_cents,currency:tx.currency,
  lifecycle_status:tx.lifecycle_status,integrity_status:tx.integrity_status,
  payment_status:tx.payment_status,processor_payout_status:tx.processor_payout_status,
  created_at:tx.created_at,payment_at:tx.payment_at,
  expected_payout_arrival:tx.expected_payout_arrival,
  last_updated_at:tx.updated_at};
}
export async function verifyClerkBusinessEmail(env,principal,email){
 if(!env.CLERK_SECRET_KEY||!principal?.sub)return false;
 const response=await fetch('https://api.clerk.com/v1/users/'+encodeURIComponent(principal.sub),{
  headers:{Authorization:'Bearer '+env.CLERK_SECRET_KEY,'Accept':'application/json'}});
 if(!response.ok)return false;
 const user=await response.json();
 return (user.email_addresses||[]).some(v=>String(v.email_address||'').trim().toLowerCase()===
   String(email).trim().toLowerCase()&&v.verification?.status==='verified');
}
export async function claimMerchantFromEmailLink(env,row,principal){
 if(!await verifyClerkBusinessEmail(env,principal,row.recipient_email))
  throw fail('Your signed-in profile must have this merchant email verified in Clerk before claiming access',403);
 // Email link authorizes only its associated merchant, never payment mutations.
 const existing=await env.DB.prepare(`SELECT id FROM merchant_access
  WHERE merchant_id=? AND role='OWNER' AND status='ACTIVE' LIMIT 1`)
   .bind(row.merchant_id).first();
 // Avoid claiming ownership over an organization that already has an owner.
 if(existing)throw fail('Business already has an owner. Ask an authorized owner to invite you.',409);
 const claim=await env.DB.prepare(`INSERT INTO merchant_access
  (id,merchant_id,external_user_id,role,status)
  SELECT ?,?,?,'OWNER','ACTIVE'
  WHERE NOT EXISTS(SELECT 1 FROM merchant_access
    WHERE merchant_id=? AND role='OWNER' AND status='ACTIVE')
  ON CONFLICT(merchant_id,external_user_id) DO NOTHING RETURNING id`)
  .bind('MAC-'+crypto.randomUUID(),row.merchant_id,principal.sub,row.merchant_id).first();
 if(!claim)throw fail('A merchant owner already exists; ask them for an invitation.',409);
 await env.DB.prepare(`UPDATE merchant_transaction_email_links SET
  claimed_by=?,claimed_at=CURRENT_TIMESTAMP,revoked_at=CURRENT_TIMESTAMP
  WHERE transaction_id=? AND claimed_at IS NULL`).bind(principal.sub,row.transaction_id).run();
 return {claimed:true,merchant_id:row.merchant_id,account_url:'/merchant/'};
}
