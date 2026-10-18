import { plaidCall, decryptBankToken, syncBankConnection } from './bank-evidence.js';
function err(message,status=409){const e=new Error(message);e.status=status;return e;}
export async function completeBankReauthorization(env,merchantId,connectionId){
 const row=await env.DB.prepare(`SELECT * FROM merchant_bank_connections
 WHERE merchant_id=? AND id=? AND status IN('REAUTH_REQUIRED','CONNECTED')
 `).bind(merchantId,connectionId).first();
 if(!row)throw err('Bank connection not found or no longer authorized',404);
 if(env.BANK_SYNC_ENABLED!=='true')throw err('Bank feature is disabled',503);
 // Revalidate against provider, not merely a browser's onSuccess callback.
 const token=await decryptBankToken(env,row);
 const state=await plaidCall(env,'/item/get',{access_token:token});
 if(state.item?.item_id!==row.item_id)throw err('Bank provider Item does not match',409);
 await env.DB.prepare(`UPDATE merchant_bank_connections SET status='CONNECTED',
 last_error=NULL,last_sync_at=NULL,updated_at=CURRENT_TIMESTAMP
 WHERE merchant_id=? AND id=?`).bind(merchantId,connectionId).run();
 try{
   await syncBankConnection(env,connectionId);
 }catch(error){
   await env.DB.prepare(`UPDATE merchant_bank_connections SET status='REAUTH_REQUIRED',
    last_error=?,updated_at=CURRENT_TIMESTAMP WHERE merchant_id=? AND id=?`)
      .bind('Bank data update not yet available; please reopen authorization if needed',
        merchantId,connectionId).run();
   throw err('Bank authorization finished, but bank updates could not yet be verified',503);
 }
 await env.DB.prepare(`UPDATE merchant_setup_notices SET notice_state='RESOLVED'
 WHERE merchant_id=? AND notice_key=?`).bind(merchantId,'BANK_REAUTH:'+connectionId).run();
 return {connected:true,verified_with_provider:true};
}
export async function merchantSetupNotices(env,merchantId){
 const bank=await env.DB.prepare(`
 SELECT c.id,c.status,c.last_sync_at,c.last_error,
  MAX(CASE WHEN a.is_payout_target=1 AND a.status='AVAILABLE' THEN 1 ELSE 0 END) AS payout_selected
 FROM merchant_bank_connections c LEFT JOIN merchant_bank_accounts a ON a.connection_id=c.id
 WHERE c.merchant_id=? AND c.status NOT IN('DISCONNECTED','REPLACED')
 GROUP BY c.id ORDER BY c.created_at DESC LIMIT 20
 `).bind(merchantId).all();
 const notices=[];
 for(const c of bank.results||[]){
  if(c.status==='REAUTH_REQUIRED')notices.push({
    code:'BANK_REAUTH',connection_id:c.id,
    severity:'ACTION_REQUIRED',title:'Reconnect your bank to resume deposit verification',
    description:'Your bank requires you to confirm permission again. Existing Stripe/Square payments continue. Bank-posted entries will not be claimed until the bank feed resumes.',
    action_url:'/merchant/bank/'});
  else if(c.status==='CONNECTED'&&!Number(c.payout_selected))
    notices.push({code:'BANK_PAYOUT_ACCOUNT',connection_id:c.id,
      severity:'ACTION_REQUIRED',title:'Select the account that receives payouts',
      description:'We can only match a payout to a bank deposit after you select the receiving account.',
      action_url:'/merchant/bank/'});
  else if(c.status==='ERROR')
    notices.push({code:'BANK_SYNC_ERROR',connection_id:c.id,
      severity:'WARNING',title:'Bank synchronization needs your attention',
      description:'Builtegrity is retrying, but a bank update has failed. Check your connection status.',
      action_url:'/merchant/bank/'});
  else if(c.status==='CONNECTED'&&c.last_sync_at&&
     Date.now()-Date.parse(c.last_sync_at+'Z')>72*3600000)
    notices.push({code:'BANK_STALE',connection_id:c.id,severity:'WARNING',
      title:'Bank information may be delayed',
      description:'The bank feed has not confirmed new transaction history recently. Builtegrity keeps retrying; no deposit is claimed from stale data.',
      action_url:'/merchant/bank/'});
 }
 const sources=await env.DB.prepare(`SELECT id,title,status,last_error,last_success_at,
  expected_interval_minutes,source_kind
 FROM merchant_custom_sync_sources WHERE merchant_id=?
  AND status IN('ACTIVE','ERROR')`)
 .bind(merchantId).all();
 for(const source of sources.results||[])notices.push({
   code:'DATA_SOURCE_ERROR',connection_id:source.id,severity:'WARNING',
   title:'Custom field feed needs reconnecting: '+source.title,
   description:'The automated feed reported an error. Recheck its key or sender integration; saved financial events remain unaffected.',
   action_url:'/merchant/integrations/'});
 return notices;
}
export async function runMerchantSetupNotifications(env,{limit=20}={}){
 // All service-side alerts and merchant notifications are automatic; no support queue.
 // We do not send bank account identifiers, provider tokens or customer records by email.
 const connected=await env.DB.prepare(`
  SELECT c.id,c.merchant_id,m.email
   FROM merchant_bank_connections c JOIN merchants m ON m.id=c.merchant_id
  WHERE c.status='REAUTH_REQUIRED'
  ORDER BY c.updated_at ASC LIMIT ?
 `).bind(Math.max(1,Math.min(50,limit))).all();
 let open=0,emails=0,skipped=0;
 for(const row of connected.results||[]){
  const noticeKey='BANK_REAUTH:'+row.id;
  await env.DB.prepare(`
   INSERT INTO merchant_setup_notices(merchant_id,notice_key)
   VALUES(?,?) ON CONFLICT(merchant_id,notice_key)
   DO UPDATE SET notice_state='OPEN',last_detected_at=CURRENT_TIMESTAMP
  `).bind(row.merchant_id,noticeKey).run();
  open++;
  if(env.MERCHANT_SETUP_EMAILS_ENABLED!=='true'||!env.RESEND_API_KEY||
     !env.MERCHANT_SETUP_EMAIL_FROM||!/^\S+@\S+\.\S+$/.test(String(row.email||''))){
    skipped++;continue;
  }
  const seen=await env.DB.prepare(`
    SELECT email_attempts,last_emailed_at FROM merchant_setup_notices
    WHERE merchant_id=? AND notice_key=?
  `).bind(row.merchant_id,noticeKey).first();
  const minHours=Number(seen?.email_attempts||0)<2?24:168;
  if(seen?.last_emailed_at&&Date.now()-Date.parse(seen.last_emailed_at+'Z')<minHours*3600000){
   skipped++;continue;
  }
  const base=String(env.APP_BASE_URL||'https://builtegrity.com').replace(/\/$/,'');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',
    headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'content-type':'application/json'},
    body:JSON.stringify({from:env.MERCHANT_SETUP_EMAIL_FROM,to:[row.email],
      subject:'Action required: reconnect your bank data in Builtegrity',
      text:'Your bank authorization needs renewal before Builtegrity can continue reporting bank deposits. Your Stripe/Square payment monitoring is unchanged. Sign in yourself at '+base+'/merchant/bank/ and choose Reconnect for the affected bank. Bank transaction feeds may lag. Builtegrity cannot renew bank consent without your approval.'})});
  if(response.ok){
   await env.DB.prepare(`UPDATE merchant_setup_notices SET
     last_emailed_at=CURRENT_TIMESTAMP,email_attempts=email_attempts+1
     WHERE merchant_id=? AND notice_key=?`).bind(row.merchant_id,noticeKey).run();
   emails++;
  }else{
   console.warn('Merchant bank notice delivery failed',row.merchant_id,response.status);
   skipped++;
  }
 }
 return {action_required:open,emails_sent:emails,skipped,provider:'self-service'};
}
