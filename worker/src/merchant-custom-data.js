// Merchant-supplied context only. No imported data is permitted to overwrite
// processor truth, payment amounts, balances, payout confirmations or consent.
const validKey=/^[a-z][a-z0-9_]{1,39}$/;
const badNames=/password|secret|api.?key|access.?token|routing.?number|bank.?account|social.?security|ssn|card.?number|cvv|cvc|private.?key|authentication/i;
const scopeSet=new Set(['CUSTOMER','TRANSACTION']);
const typeSet=new Set(['TEXT','NUMBER','BOOLEAN','DATE']);
const kindSet=new Set(['FILE','WEBHOOK','DATABASE_PUSH','APP_PUSH']);
function err(message,status=400){const e=new Error(message);e.status=status;return e;}
export function sanitizeFieldDefinition(raw){
 const field_key=String(raw?.field_key||'').trim().toLowerCase();
 const label=String(raw?.label||'').trim();
 const group_title=String(raw?.group_title||'General').trim();
 const record_scope=String(raw?.record_scope||'').toUpperCase();
 const value_type=String(raw?.value_type||'TEXT').toUpperCase();
 if(!validKey.test(field_key)||badNames.test(field_key))throw err('Use a non-sensitive field key: lowercase letters, numbers, underscore; starts with a letter',400);
 if(!label||label.length>90||badNames.test(label))throw err('Label must be 1–90 characters and must not request credentials or account numbers',400);
 if(!group_title||group_title.length>60)throw err('Group title must be 1–60 characters');
 if(!scopeSet.has(record_scope)||!typeSet.has(value_type))throw err('Invalid field scope or type');
 return {field_key,label,group_title,record_scope,value_type,
   visible_in_pdf:raw.visible_in_pdf===false?0:1};
}
export function normalizeMerchantFieldValue(value,type){
 if(value===undefined||value===null)throw err('Custom field value cannot be blank');
 if(type==='TEXT'){
  const str=String(value).trim();if(!str||str.length>1024)throw err('Text must contain 1–1024 characters');
  return str;
 }
 if(type==='NUMBER'){
  if((typeof value!=='number'&&typeof value!=='string')||
    String(value).trim()===''||!Number.isFinite(Number(value)))throw err('Numeric field requires a finite number');
  return String(Number(value));
 }
 if(type==='BOOLEAN'){
  if(value===true||value==='true'||value===1||value==='1')return 'true';
  if(value===false||value==='false'||value===0||value==='0')return 'false';
  throw err('Boolean field requires true or false');
 }
 const x=String(value);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(x)||Number.isNaN(Date.parse(x+'T00:00:00Z'))||
    new Date(x+'T00:00:00Z').toISOString().slice(0,10)!==x)throw err('Date field requires YYYY-MM-DD');
 return x;
}
export async function listMerchantFieldDefinitions(env,merchantId){
 const result=await env.DB.prepare(`
  SELECT field_key,label,group_title,record_scope,value_type,visible_in_pdf,active,created_at
  FROM merchant_custom_field_definitions WHERE merchant_id=?
  ORDER BY record_scope,group_title,label LIMIT 150
 `).bind(merchantId).all();
 return result.results||[];
}
export async function defineMerchantField(env,merchantId,userId,raw){
 const x=sanitizeFieldDefinition(raw);
 const count=await env.DB.prepare(`SELECT COUNT(*) AS n FROM merchant_custom_field_definitions
   WHERE merchant_id=?`).bind(merchantId).first();
 if(Number(count?.n)>=100)throw err('100 custom field limit reached for this merchant',409);
 const exists=await env.DB.prepare(`SELECT field_key FROM merchant_custom_field_definitions
   WHERE merchant_id=? AND field_key=?`).bind(merchantId,x.field_key).first();
 if(exists)throw err('Field key already exists; definitions cannot be overwritten',409);
 await env.DB.prepare(`INSERT INTO merchant_custom_field_definitions
   (merchant_id,field_key,label,group_title,record_scope,value_type,visible_in_pdf,created_by)
   VALUES(?,?,?,?,?,?,?,?)`).bind(merchantId,x.field_key,x.label,x.group_title,
    x.record_scope,x.value_type,x.visible_in_pdf,userId).run();
 return x;
}
export async function disableMerchantField(env,merchantId,key){
 await env.DB.prepare(`UPDATE merchant_custom_field_definitions SET active=0,
   updated_at=CURRENT_TIMESTAMP WHERE merchant_id=? AND field_key=?`).bind(merchantId,key).run();
}
export async function merchantFieldContext(env,merchantId,customerId,transactionId=null,{forPdf=false}={}){
 const ids=[{scope:'CUSTOMER',id:customerId},...(transactionId?[{scope:'TRANSACTION',id:transactionId}]:[])]
   .filter(x=>Boolean(x.id));
 if(!ids.length)return [];
 const conditions=ids.map(()=>' (v.record_scope=? AND v.record_id=?) ').join(' OR ');
 const params=[merchantId,...ids.flatMap(x=>[x.scope,x.id])];
 const result=await env.DB.prepare(`
   SELECT * FROM (
    SELECT d.field_key,d.label,d.group_title,d.record_scope,d.value_type,d.visible_in_pdf,
     v.value_text,v.source_id,v.observed_at,
     ROW_NUMBER() OVER (PARTITION BY v.record_scope,v.record_id,v.field_key
       ORDER BY v.rowid DESC) AS n
    FROM merchant_custom_field_observations v
    JOIN merchant_custom_field_definitions d ON d.merchant_id=v.merchant_id
      AND d.field_key=v.field_key AND d.active=1
    WHERE v.merchant_id=? AND (${conditions})
   ) WHERE n=1
   ORDER BY group_title,label LIMIT 150
 `).bind(...params).all();
 return (result.results||[]).filter(x=>!forPdf||x.visible_in_pdf===1);
}
async function resolveImportTarget(env,merchantId,item){
 const scope=String(item.scope||'').toUpperCase(),external=String(item.external_reference||'').trim();
 if(!scopeSet.has(scope)||!external||external.length>150)
   throw err('Each row needs scope CUSTOMER or TRANSACTION and an external_reference');
 const row=scope==='CUSTOMER'?
   await env.DB.prepare(`SELECT id,merchant_id FROM customers
     WHERE merchant_id=? AND merchant_customer_reference=? LIMIT 1`)
     .bind(merchantId,external).first():
   await env.DB.prepare(`SELECT id,merchant_id FROM transactions
     WHERE merchant_id=? AND merchant_payment_reference=? LIMIT 1`)
     .bind(merchantId,external).first();
 if(!row)throw err('Unmatched '+scope.toLowerCase()+' reference: '+external+
   '. Import does not create or assume customer identities.',422);
 return {scope,id:row.id};
}
export async function ingestMerchantCustomFields(env,merchantId,sourceId,deliveryId,records){
 if(!Array.isArray(records)||records.length<1||records.length>50)
   throw err('Provide between 1 and 50 records per batch');
 if(!deliveryId||typeof deliveryId!=='string'||deliveryId.length>128)
   throw err('Provide a stable delivery_id of 1–128 characters');
 const minute=await env.DB.prepare(`SELECT COUNT(*) AS n
  FROM merchant_custom_sync_deliveries WHERE source_id=?
   AND datetime(received_at)>=datetime('now','-1 minute')`).bind(sourceId).first();
 if(Number(minute?.n)>120)throw err('Too many delivery attempts; retry later',429);
 const existing=await env.DB.prepare(`SELECT result_count FROM merchant_custom_sync_deliveries
   WHERE source_id=? AND delivery_id=?`).bind(sourceId,deliveryId).first();
 if(existing)return {duplicate:true,applied:Number(existing.result_count)||0};
 const defs=await listMerchantFieldDefinitions(env,merchantId);
 const byKey=new Map(defs.filter(x=>x.active===1).map(d=>[d.field_key,d]));
 let applied=0;const statements=[];
 for(let i=0;i<records.length;i++){
  const item=records[i];
  const target=await resolveImportTarget(env,merchantId,item);
  const fields=item?.fields;
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw err('Each record must contain a fields object');
  const entries=Object.entries(fields);
  if(!entries.length||entries.length>15)throw err('Every record must supply 1–15 custom fields');
  for(const [key,raw] of entries){
   const def=byKey.get(key);
   if(!def||def.record_scope!==target.scope)throw err('Unregistered field or scope mismatch: '+key,422);
   const value=normalizeMerchantFieldValue(raw,def.value_type);
   statements.push(env.DB.prepare(`INSERT OR IGNORE INTO merchant_custom_field_observations
    (id,merchant_id,field_key,record_scope,record_id,value_text,source_id,source_event_id)
    VALUES(?,?,?,?,?,?,?,?)`).bind('CFO-'+crypto.randomUUID(),merchantId,key,target.scope,target.id,value,
      sourceId,deliveryId+':'+i));
   applied++;
  }
 }
 // One atomic SQLite batch: delivery is committed only if every validated observation succeeds.
 await env.DB.batch([
   env.DB.prepare(`INSERT INTO merchant_custom_sync_deliveries
    (source_id,delivery_id,result_count) VALUES(?,?,?)`).bind(sourceId,deliveryId,applied),
   ...statements,
   env.DB.prepare(`UPDATE merchant_custom_sync_sources
    SET last_success_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND merchant_id=? AND status='ACTIVE'`).bind(sourceId,merchantId)
 ]);
 return {duplicate:false,applied};
}
export async function merchantCustomerGroups(env,merchantId,key){
 const def=await env.DB.prepare(`SELECT * FROM merchant_custom_field_definitions
   WHERE merchant_id=? AND field_key=? AND record_scope='CUSTOMER' AND active=1`)
    .bind(merchantId,key).first();
 if(!def)throw err('Choose an active customer field for grouping',404);
 const result=await env.DB.prepare(`
   WITH latest AS (
    SELECT v.record_id,v.value_text,ROW_NUMBER() OVER(
      PARTITION BY v.record_id,v.field_key ORDER BY v.rowid DESC) AS n
    FROM merchant_custom_field_observations v
    WHERE v.merchant_id=? AND v.field_key=? AND v.record_scope='CUSTOMER'
   )
   SELECT l.value_text AS group_value,COUNT(DISTINCT c.id) AS customer_count,
    COUNT(DISTINCT t.id) AS transaction_count
   FROM latest l JOIN customers c ON c.id=l.record_id AND c.merchant_id=?
   LEFT JOIN transactions t ON t.customer_id=c.id AND t.merchant_id=?
   WHERE l.n=1 GROUP BY l.value_text ORDER BY customer_count DESC,group_value LIMIT 100
 `).bind(merchantId,key,merchantId,merchantId).all();
 return {field_key:key,label:def.label,groups:result.results||[]};
}
export async function customersInGroup(env,merchantId,key,value){
 const grouped=await merchantCustomerGroups(env,merchantId,key);
 const result=await env.DB.prepare(`
 WITH latest AS (
  SELECT v.record_id,v.value_text,ROW_NUMBER() OVER(
   PARTITION BY v.record_id ORDER BY v.rowid DESC) AS n
  FROM merchant_custom_field_observations v
  WHERE v.merchant_id=? AND v.field_key=? AND v.record_scope='CUSTOMER'
 )
 SELECT c.id AS customer_id,c.name,c.merchant_customer_reference,
  t.id AS transaction_id,t.merchant_payment_reference,t.amount_cents,t.currency,
  t.processor,t.integrity_status,t.created_at
 FROM latest l JOIN customers c ON c.id=l.record_id AND c.merchant_id=?
 LEFT JOIN transactions t ON t.customer_id=c.id AND t.merchant_id=?
 WHERE l.n=1 AND l.value_text=? ORDER BY t.created_at DESC,t.id DESC LIMIT 200
 `).bind(merchantId,key,merchantId,merchantId,value).all();
 return {...grouped,selected_value:value,records:result.results||[]};
}
export async function createMerchantSyncSource(env,merchantId,userId,title,kind){
 title=String(title||'').trim();
 kind=String(kind||'').toUpperCase();
 if(title.length<1||title.length>90||!kindSet.has(kind))throw err('Source title or kind invalid');
 const count=await env.DB.prepare(`SELECT COUNT(*) AS n FROM merchant_custom_sync_sources
   WHERE merchant_id=? AND status='ACTIVE'`).bind(merchantId).first();
 if(Number(count?.n)>=15)throw err('15 active source limit reached',409);
 const id='SYNC-'+crypto.randomUUID();
 let token=null,hash=null;
 if(kind!=='FILE'){
   token='bg_sync_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
   hash=await sha256Hex(token);
 }
 await env.DB.prepare(`INSERT INTO merchant_custom_sync_sources
  (id,merchant_id,title,source_kind,key_hash,created_by) VALUES(?,?,?,?,?,?)`)
  .bind(id,merchantId,title,kind,hash,userId).run();
 return {id,title,kind,token_once:token};
}
export async function listMerchantSyncSources(env,merchantId){
 const x=await env.DB.prepare(`SELECT id,title,source_kind,status,last_success_at,last_error,created_at
 FROM merchant_custom_sync_sources WHERE merchant_id=? ORDER BY created_at DESC LIMIT 50`)
 .bind(merchantId).all();
 return x.results||[];
}
export async function rotateMerchantSyncSource(env,merchantId,id){
 const row=await env.DB.prepare(`SELECT id,source_kind FROM merchant_custom_sync_sources
 WHERE merchant_id=? AND id=? AND status='ACTIVE'`).bind(merchantId,id).first();
 if(!row||row.source_kind==='FILE')throw err('Source does not support keys',404);
 const token='bg_sync_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 const hash=await sha256Hex(token);
 await env.DB.prepare(`UPDATE merchant_custom_sync_sources SET key_hash=?,
 updated_at=CURRENT_TIMESTAMP WHERE id=? AND merchant_id=?`).bind(hash,id,merchantId).run();
 return {token_once:token};
}
export async function revokeMerchantSyncSource(env,merchantId,id){
 await env.DB.prepare(`UPDATE merchant_custom_sync_sources SET status='REVOKED',
 key_hash=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND merchant_id=?`).bind(id,merchantId).run();
}
export async function verifyMerchantSyncToken(env,id,bearer){
 const row=await env.DB.prepare(`SELECT id,merchant_id,source_kind,key_hash,status
 FROM merchant_custom_sync_sources WHERE id=? LIMIT 1`).bind(id).first();
 if(!row||row.status!=='ACTIVE'||row.source_kind==='FILE'||!row.key_hash||
    !/^bg_sync_[a-f0-9]{64}$/.test(String(bearer||'')))return null;
 const actual=await sha256Hex(bearer);
 if(!safeEqual(actual,row.key_hash))return null;
 return row;
}
function safeEqual(a,b){if(a.length!==b.length)return false;let x=0;
 for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
async function sha256Hex(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',
 new TextEncoder().encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
