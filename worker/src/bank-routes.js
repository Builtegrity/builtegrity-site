import { authenticateClerkSession } from './clerk-auth.js';
import { requireMerchantMembership } from './authorization.js';
import { makeBankLinkToken, connectBank, bankConnectionsForMerchant,
  selectPayoutBank, disconnectMerchantBank } from './bank-evidence.js';
import { handlePlaidWebhook } from './plaid-webhooks.js';
import { completeBankReauthorization,merchantSetupNotices } from './merchant-setup-autopilot.js';

function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{
  'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
function bad(message,status=400){const e=new Error(message);e.status=status;return e;}
function assertSameOrigin(request) {
 const origin=request.headers.get('origin');
 const url=new URL(request.url);

 if(origin&&origin!==url.origin)throw bad('Cross-origin bank actions are not allowed',403);
 const fetchSite=request.headers.get('sec-fetch-site');
 if(fetchSite&&['cross-site','same-site'].includes(fetchSite))throw bad('Cross-site bank action blocked',403);
}
export async function handleMerchantBankRoute(request,env,ctx) {
 const path=new URL(request.url).pathname,method=request.method;
 if(path==='/api/webhooks/plaid'&&method==='POST')
   return handlePlaidWebhook(request,env,ctx);
 if(!path.startsWith('/api/merchant/bank/'))return null;
 if(!['GET','POST'].includes(method))return json({error:'Method not allowed'},405);
 if(method==='POST')assertSameOrigin(request);
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub||principal.claims?.act)return json({error:'Merchant sign-in required'},401);
 const url=new URL(request.url);
 let input={};if(method==='POST'){
   try{input=await request.json();}catch{return json({error:'Valid JSON required'},400);}
 }
 if(path==='/api/merchant/bank/merchants'&&method==='GET'){
   const rows=await env.DB.prepare(`
    SELECT m.id,m.name,a.role FROM merchant_access a JOIN merchants m
    ON m.id=a.merchant_id WHERE a.external_user_id=? AND a.status='ACTIVE'
       AND a.role='OWNER' ORDER BY m.name LIMIT 100
   `).bind(principal.sub).all();
   return json({merchants:rows.results||[],bank_link_available:env.BANK_SYNC_ENABLED==='true'});
 }

 const merchantId=method==='GET'?url.searchParams.get('merchant_id'):input.merchant_id;
 if(!merchantId||!/^MER-[A-Za-z0-9-]+$/.test(merchantId))
   return json({error:'Merchant ID required'},400);
 await requireMerchantMembership(env,principal,merchantId,
   method==='POST'?'OWNER':'VIEWER');
 if(path==='/api/merchant/bank/notices'&&method==='GET')
   return json({notices:await merchantSetupNotices(env,merchantId)});
 if(path==='/api/merchant/bank/status'&&method==='GET'){
  const connections=await bankConnectionsForMerchant(env,merchantId);
  return json({enabled:env.BANK_SYNC_ENABLED==='true',merchant_id:merchantId,
    connection_status:connections.length?'CONNECTED':'NOT_CONNECTED',connections,
    scope:'read-only transaction history'});
 }
 if(env.BANK_SYNC_ENABLED!=='true')return json({error:'Optional bank linking not enabled'},503);
 if(path==='/api/merchant/bank/link-token'&&method==='POST'){
  let row=null;
  if(input.connection_id){
   row=await env.DB.prepare(`SELECT * FROM merchant_bank_connections WHERE merchant_id=?
     AND id=? AND status IN('CONNECTED','REAUTH_REQUIRED')`)
     .bind(merchantId,input.connection_id).first();
   if(!row)return json({error:'Bank connection unavailable'},404);
  }
  return json(await makeBankLinkToken(env,merchantId,principal.sub,row));
 }
 if(path==='/api/merchant/bank/reauthorize'&&method==='POST')
   return json(await completeBankReauthorization(env,merchantId,input.connection_id));
 if(path==='/api/merchant/bank/complete'&&method==='POST'){
  return json(await connectBank(env,merchantId,principal.sub,input.public_token,
    input.selected_account_id||null));
 }
 if(path==='/api/merchant/bank/select'&&method==='POST'){
  return json(await selectPayoutBank(env,merchantId,input.connection_id,input.account_id));
 }
 if(path==='/api/merchant/bank/disconnect'&&method==='POST'){
  return json(await disconnectMerchantBank(env,merchantId,input.connection_id));
 }
 return json({error:'Bank route not found'},404);
}
