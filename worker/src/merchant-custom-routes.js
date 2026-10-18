import { authenticateClerkSession } from './clerk-auth.js';
import { requireMerchantMembership } from './authorization.js';
import {
 defineMerchantField,disableMerchantField,listMerchantFieldDefinitions,
 merchantFieldContext,merchantCustomerGroups,customersInGroup,
 createMerchantSyncSource,listMerchantSyncSources,rotateMerchantSyncSource,
 revokeMerchantSyncSource,ingestMerchantCustomFields,verifyMerchantSyncToken
} from './merchant-custom-data.js';
function json(data,status=200){return new Response(JSON.stringify(data),{
 status,headers:{'content-type':'application/json','cache-control':'no-store',
 'x-content-type-options':'nosniff'}});}
function err(s,status=400){const e=new Error(s);e.status=status;return e;}
function sameOrigin(request){
 const origin=request.headers.get('origin'),url=new URL(request.url);
 if(origin&&origin!==url.origin)throw err('Cross-origin modification refused',403);
 const site=request.headers.get('sec-fetch-site');
 if(site&&site!=='same-origin'&&site!=='none')throw err('Cross-site modification refused',403);
}
async function readBoundedJson(request){
 const length=Number(request.headers.get('content-length'));
 if(length>110000)throw err('Maximum upload batch is 100 KB',413);
 const text=await request.text();
 if(new TextEncoder().encode(text).byteLength>110000)throw err('Maximum upload batch is 100 KB',413);
 try{return JSON.parse(text);}catch{throw err('Valid JSON required');}
}
export async function handleMerchantCustomRoute(request,env){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 const external=path.match(/^\/api\/sync\/merchant-fields\/(SYNC-[a-f0-9-]{36})$/);
 if(external){
   if(method!=='POST')return json({error:'Method not allowed'},405);
   if(env.CUSTOM_SYNC_ENABLED!=='true')return json({error:'Custom data feed is not activated'},503);
   const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
   const source=await verifyMerchantSyncToken(env,external[1],token);
   if(!source)return json({error:'Invalid or revoked source key'},401);
   const body=await readBoundedJson(request);
   const result=await ingestMerchantCustomFields(env,source.merchant_id,source.id,
     body.delivery_id,body.records);
   return json(result);
 }
 if(!path.startsWith('/api/merchant/custom/'))return null;
 if(!['GET','POST'].includes(method))return json({error:'Method not allowed'},405);
 if(method==='POST')sameOrigin(request);
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub||principal.claims?.act)return json({error:'Merchant sign-in required'},401);
 const data=method==='POST'?await readBoundedJson(request):Object.fromEntries(url.searchParams);
 if(path==='/api/merchant/custom/merchants'&&method==='GET'){
   const rows=await env.DB.prepare(`
    SELECT m.id,m.name,a.role FROM merchant_access a JOIN merchants m
    ON m.id=a.merchant_id WHERE a.external_user_id=? AND a.status='ACTIVE'
     AND a.role='OWNER' ORDER BY m.name LIMIT 100
   `).bind(principal.sub).all();
   return json({merchants:rows.results||[],
     automatic_push_enabled:env.CUSTOM_SYNC_ENABLED==='true'});
 }
 const merchantId=String(data.merchant_id||'');
 if(!/^MER-[A-Za-z0-9-]+$/.test(merchantId))return json({error:'Merchant ID required'},400);
 // Viewing requires explicit tenant membership. All settings and imports require OWNER.
 const canMutate=method==='POST';
 await requireMerchantMembership(env,principal,merchantId,canMutate?'OWNER':'VIEWER');
 if(path==='/api/merchant/custom/schema'&&method==='GET')
   return json({definitions:await listMerchantFieldDefinitions(env,merchantId)});
 if(path==='/api/merchant/custom/define'&&method==='POST')
   return json({definition:await defineMerchantField(env,merchantId,principal.sub,data)},201);
 if(path==='/api/merchant/custom/deactivate'&&method==='POST'){
   await disableMerchantField(env,merchantId,String(data.field_key||''));
   return json({deactivated:true});
 }
 if(path==='/api/merchant/custom/sources'&&method==='GET')
   return json({sources:await listMerchantSyncSources(env,merchantId),
     live_sync_enabled:env.CUSTOM_SYNC_ENABLED==='true'});
 if(path==='/api/merchant/custom/source/create'&&method==='POST'){
   if(data.source_kind!=='FILE'&&env.CUSTOM_SYNC_ENABLED!=='true')
     return json({error:'Automated push feeds are not enabled yet'},503);
   const source=await createMerchantSyncSource(env,merchantId,principal.sub,
     data.title,data.source_kind);
   return json({source},201);
 }
 if(path==='/api/merchant/custom/source/rotate'&&method==='POST')
   return json(await rotateMerchantSyncSource(env,merchantId,data.source_id));
 if(path==='/api/merchant/custom/source/revoke'&&method==='POST'){
   await revokeMerchantSyncSource(env,merchantId,data.source_id);
   return json({revoked:true});
 }
 if(path==='/api/merchant/custom/import'&&method==='POST'){
   const source=await env.DB.prepare(`SELECT id,source_kind FROM merchant_custom_sync_sources
     WHERE id=? AND merchant_id=? AND source_kind='FILE' AND status='ACTIVE'`)
      .bind(data.source_id,merchantId).first();
   if(!source)return json({error:'Create an active file source first'},409);
   return json(await ingestMerchantCustomFields(env,merchantId,source.id,
     data.delivery_id,data.records));
 }
 if(path==='/api/merchant/custom/groups'&&method==='GET')
   return json(await merchantCustomerGroups(env,merchantId,String(data.field_key||'')));
 if(path==='/api/merchant/custom/group-history'&&method==='GET')
   return json(await customersInGroup(env,merchantId,String(data.field_key||''),
     String(data.value??'')));
 if(path==='/api/merchant/custom/context'&&method==='GET'){
   const scope=String(data.record_scope||'').toUpperCase();
   const reference=String(data.external_reference||'');
   if(reference.length>150||!reference)return json({error:'External reference required'},400);
   if(scope==='CUSTOMER'){
      const row=await env.DB.prepare(`SELECT id,name FROM customers
       WHERE merchant_id=? AND merchant_customer_reference=?`)
       .bind(merchantId,reference).first();
      if(!row)return json({error:'Customer reference not found'},404);
      return json({record:row,fields:await merchantFieldContext(env,merchantId,row.id)});
   }
   if(scope==='TRANSACTION'){
      const row=await env.DB.prepare(`SELECT id,customer_id FROM transactions
       WHERE merchant_id=? AND merchant_payment_reference=?`)
       .bind(merchantId,reference).first();
      if(!row)return json({error:'Payment reference not found'},404);
      return json({record:row,fields:await merchantFieldContext(env,merchantId,row.customer_id,row.id)});
   }
   return json({error:'Invalid record scope'},400);
 }
 return json({error:'Custom field action not found'},404);
}
