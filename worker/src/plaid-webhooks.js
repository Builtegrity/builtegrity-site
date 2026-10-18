import { plaidCall, syncBankConnection } from './bank-evidence.js';
const decode64url=value=>{
 const v=String(value).replace(/-/g,'+').replace(/_/g,'/');
 const binary=atob(v+'='.repeat((4-v.length%4)%4));
 return Uint8Array.from(binary,c=>c.charCodeAt(0));
};
const jsonPart=x=>JSON.parse(new TextDecoder().decode(decode64url(x)));
export async function verifyPlaidWebhook(env,raw,jwt) {
 if(!jwt||jwt.length>6000)return false;
 try{
  const parts=jwt.split('.');
  if(parts.length!==3)return false;
  const header=jsonPart(parts[0]),claim=jsonPart(parts[1]);
  if(header.alg!=='ES256'||!header.kid||typeof header.kid!=='string')return false;
  if(!Number.isInteger(claim.iat)||Math.abs(Date.now()/1000-claim.iat)>300)return false;
  const response=await plaidCall(env,'/webhook_verification_key/get',{key_id:header.kid});
  const k=response.key;
  if(!k||k.kid!==header.kid||k.alg!=='ES256'||k.kty!=='EC'||k.crv!=='P-256')return false;
  if(k.expired_at&&Number(k.expired_at)<Date.now()/1000)return false;
  const key=await crypto.subtle.importKey('jwk',k,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const valid=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode64url(parts[2]),
    new TextEncoder().encode(parts[0]+'.'+parts[1]));
  if(!valid)return false;
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  const calculated=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
  const expected=String(claim.request_body_sha256||'');
  if(!/^[a-f0-9]{64}$/.test(expected))return false;
  let delta=0;for(let i=0;i<64;i++)delta|=calculated.charCodeAt(i)^expected.charCodeAt(i);
  return delta===0;
 }catch{return false;}
}
export async function handlePlaidWebhook(request,env,ctx) {
 if(env.BANK_SYNC_ENABLED!=='true')return new Response('Bank data integration disabled',{status:503});
 const raw=await request.text();
 if(raw.length>1024*1024)return new Response('Too large',{status:413});
 if(!await verifyPlaidWebhook(env,raw,request.headers.get('Plaid-Verification')))
   return new Response('Invalid bank provider signature',{status:401});
 let message;try{message=JSON.parse(raw);}catch{return new Response('Invalid JSON',{status:400});}
 if(!message.item_id||typeof message.item_id!=='string')return new Response('Accepted',{status:202});
 const row=await env.DB.prepare(`SELECT id,status FROM merchant_bank_connections
    WHERE item_id=? AND status IN('CONNECTED','REAUTH_REQUIRED') LIMIT 1`)
     .bind(message.item_id).first();
 if(!row)return new Response('Accepted',{status:202});
 if(message.webhook_type==='ITEM'&&message.webhook_code==='LOGIN_REPAIRED'){
   await env.DB.prepare(`UPDATE merchant_bank_connections SET status='CONNECTED',
     last_error=NULL,last_sync_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(row.id).run();
   await env.DB.prepare(`UPDATE merchant_setup_notices SET notice_state='RESOLVED'
     WHERE merchant_id=(SELECT merchant_id FROM merchant_bank_connections WHERE id=?)
       AND notice_key=?`).bind(row.id,'BANK_REAUTH:'+row.id).run();
   if(ctx?.waitUntil)ctx.waitUntil(syncBankConnection(env,row.id).catch(e=>
     console.error('Bank self-heal refresh failed',row.id,String(e.message))));
 }else if(message.webhook_type==='ITEM'&&
   ['ERROR','PENDING_DISCONNECT','PENDING_EXPIRATION'].includes(message.webhook_code)){
    await env.DB.prepare(`UPDATE merchant_bank_connections SET status='REAUTH_REQUIRED',
      last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(String(message.webhook_code),row.id).run();
 }else if(message.webhook_type==='TRANSACTIONS'&&
   ['SYNC_UPDATES_AVAILABLE','INITIAL_UPDATE','HISTORICAL_UPDATE','DEFAULT_UPDATE',
    'TRANSACTIONS_REMOVED'].includes(message.webhook_code)&&row.status==='CONNECTED'){
   await env.DB.prepare(`UPDATE merchant_bank_connections SET last_sync_at=NULL
     WHERE id=? AND status='CONNECTED'`).bind(row.id).run();
   if(ctx?.waitUntil)ctx.waitUntil(syncBankConnection(env,row.id).catch(e=>
     console.error('Bank webhook-triggered sync failed',row.id,String(e.message))));
 }
 return new Response('Accepted',{status:202});
}
