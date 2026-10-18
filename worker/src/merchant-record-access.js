import {lookupMerchantRecordToken,accountlessTransactionProjection,sha256,
 claimMerchantFromEmailLink} from './merchant-record-links.js';
import {getTransaction} from './db.js';
import {authenticateClerkSession} from './clerk-auth.js';
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{
 'content-type':'application/json','cache-control':'no-store','referrer-policy':'no-referrer',
 'x-content-type-options':'nosniff'}});
const fail=(text,status)=>new Response(JSON.stringify({error:text}),{
 status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function handleMerchantEmailAccess(request,env){
 const path=new URL(request.url).pathname;
 if(!path.startsWith('/api/merchant/record-link/'))return null;
 if(request.method!=='POST')return fail('Method not allowed',405);
 if(Number(request.headers.get('content-length')||0)>1024)return fail('Invalid request size',413);
 const raw=await request.text();
 if(raw.length>1024)return fail('Invalid request size',413);
 let body;try{body=JSON.parse(raw);}catch{return fail('Invalid request',400);}
 const token=body?.token;
 const row=await lookupMerchantRecordToken(env,token);
 if(!row)return fail('Link expired, revoked, or not found. Ask for a new authorized link.',404);
 const tx=await getTransaction(env,row.transaction_id);
 if(!tx||tx.merchant_id!==row.merchant_id)return fail('Transaction unavailable',404);
 if(path==='/api/merchant/record-link/read'){
  await env.DB.prepare(`UPDATE merchant_transaction_email_links
   SET opened_at=COALESCE(opened_at,CURRENT_TIMESTAMP),open_count=open_count+1
   WHERE transaction_id=? AND token_sha256=? AND revoked_at IS NULL`)
    .bind(row.transaction_id,await sha256(token)).run();
  return json({record:accountlessTransactionProjection(tx),
    accountless:true,expires_at:row.expires_at,
    included:'This read-only link shows only the named transaction. It excludes bank evidence, private merchant notes, customer files and other transactions.',
    signup_url:'/signup/'});
 }
 if(path==='/api/merchant/record-link/pdf'){
  return fail('A verified merchant account is required to download or share any PDF. Sign in to your dashboard.',403);
 }
 if(path==='/api/merchant/record-link/claim'){
  const principal=await authenticateClerkSession(request,env);
  if(!principal?.sub||principal.claims?.act)
   return fail('Create an account or sign in with your verified business email first',401);
  try{return json(await claimMerchantFromEmailLink(env,row,principal));}
  catch(e){return fail(e.message,e.status||409);}
 }
 return fail('Not found',404);
}
