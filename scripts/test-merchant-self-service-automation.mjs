import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  defineMerchantField,setMerchantFieldSyncMode,merchantCustomSyncHealth,
  createMerchantSyncSource,ingestMerchantCustomFields,merchantFieldContext
} from '../worker/src/merchant-custom-data.js';
import {dispatchMerchantHelpRequests} from '../worker/src/merchant-help.js';
import {transactionPdfLines} from '../worker/src/pdf-evidence.js';

const filename=join(mkdtempSync(join(tmpdir(),'bg-owner-fields-')),'testing.sqlite');
const literal=x=>x===null||x===undefined?'NULL':typeof x==='number'?String(x):
 "'"+String(x).replaceAll("'","''")+"'";
function run(sql,returnRows=false){
 const r=execFileSync('sqlite3',[...(returnRows?['-json']:[]),filename],
   {input:'PRAGMA foreign_keys=ON;\n'+sql+'\n',encoding:'utf8'});
 return returnRows?JSON.parse(r.trim()||'[]'):r.trim();
}
for(const p of readdirSync('migrations').filter(p=>p.endsWith('.sql')).sort()){
 run(readFileSync('migrations/'+p,'utf8'));
 if(p.startsWith('0009_'))run(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
const prepare=sql=>({bind(...values){
 let i=0;const rendered=sql.replace(/\?/g,()=>literal(values[i++]));
 assert.equal(i,values.length,'All SQL placeholders must be bound');
 return {sql:rendered,first:async()=>run(rendered,true)[0]||null,
  all:async()=>({results:run(rendered,true)}),
  run:async()=>{run(rendered);return {success:true};}};
}});
const env={DB:{prepare,batch:async statements=>{
 run('BEGIN;\n'+statements.map(s=>s.sql+';').join('\n')+'\nCOMMIT;');
 return statements.map(()=>({success:true}));
}}};
const merchant='MER-0001';
await defineMerchantField(env,merchant,'owner-test',{
 field_key:'service_route',label:'Service Route',group_title:'Operations',
 record_scope:'CUSTOMER',value_type:'TEXT'});
const app=await createMerchantSyncSource(env,merchant,'owner-test','My HOA System','APP_PUSH');
const file=await createMerchantSyncSource(env,merchant,'owner-test','CSV Backup','FILE');
await assert.rejects(()=>setMerchantFieldSyncMode(env,merchant,'service_route','AUTO',file.id),
 /Automatic updates need an active/);
await assert.rejects(()=>setMerchantFieldSyncMode(env,merchant,'service_route','AUTO','SYNC-NOT-OWNED'),
 /Automatic updates need an active/);
await setMerchantFieldSyncMode(env,merchant,'service_route','AUTO',app.id);
const first=(await merchantCustomSyncHealth(env,merchant))[0];
assert.equal(first.update_mode,'AUTO');
assert.equal(first.sync_health,'AWAITING_FIRST_DELIVERY');
const record=[{scope:'CUSTOMER',external_reference:'CUST-0001',
 fields:{service_route:'Warwick North'}}];
await assert.rejects(()=>ingestMerchantCustomFields(env,merchant,file.id,'incorrect-source',record),
 /belongs to another automatic source/);
assert.equal((await merchantCustomSyncHealth(env,merchant))[0].sync_health,'AWAITING_FIRST_DELIVERY');
await ingestMerchantCustomFields(env,merchant,app.id,'app-event-001',record);
const latest=await merchantFieldContext(env,merchant,'CUST-0001','TX-0001');
assert.equal(latest.find(x=>x.field_key==='service_route').value_text,'Warwick North');
assert.equal((await merchantCustomSyncHealth(env,merchant))[0].sync_health,'CONNECTED');
assert.match(transactionPdfLines({id:'TX-0001',custom_fields:latest},{audience:'merchant'}).join('\n'),
 /Warwick North/);
await setMerchantFieldSyncMode(env,merchant,'service_route','MANUAL');
const updated=await merchantCustomSyncHealth(env,merchant);
assert.equal(updated[0].sync_health,'MANUAL');

run("INSERT INTO merchant_help_requests(id,merchant_id,created_by,request_type,service_name,details)"+
 "VALUES('HELP-DEMO-123','MER-0001','owner-test','INTEGRATION','Example SaaS',"+
 "'I want invoices and service routes sent to my transaction fields automatically.');");
assert.deepEqual(await dispatchMerchantHelpRequests(env),{configured:false,sent:0});
assert.equal(run("SELECT email_status FROM merchant_help_requests WHERE id='HELP-DEMO-123'",true)[0].email_status,'NOT_SENT');
const oldFetch=globalThis.fetch;
let emailRequests=0;
globalThis.fetch=async(uri,options)=>{
 assert.equal(uri,'https://api.resend.com/emails');
 assert.equal(options.headers['Idempotency-Key'],'HELP-DEMO-123');
 const body=JSON.parse(options.body);
 assert.match(body.text,/Example SaaS/);
 emailRequests++;
 return new Response(JSON.stringify({id:'test-delivery'}),{status:200});
};
try{
 const result=await dispatchMerchantHelpRequests({...env,
   MERCHANT_HELP_EMAILS_ENABLED:'true',RESEND_API_KEY:'secret-test',
   MERCHANT_HELP_EMAIL_FROM:'Help <test@example.com>',
   MERCHANT_HELP_EMAIL_TO:'inbox@example.com'});
 assert.equal(result.sent,1);
 assert.equal(emailRequests,1);
 const repeat=await dispatchMerchantHelpRequests({...env,MERCHANT_HELP_EMAILS_ENABLED:'true',
   RESEND_API_KEY:'secret-test',MERCHANT_HELP_EMAIL_FROM:'Help <test@example.com>',
   MERCHANT_HELP_EMAIL_TO:'inbox@example.com'});
 assert.equal(repeat.sent,0,'Sent tickets are never sent again by scheduled retries');
}finally{globalThis.fetch=oldFetch;}
const fieldRoutes=readFileSync('worker/src/merchant-custom-routes.js','utf8');
assert.match(fieldRoutes,/field\/sync/);
assert.match(fieldRoutes,/heartbeat/);
assert.match(fieldRoutes,/verifyMerchantSyncToken/);
const help=readFileSync('worker/src/merchant-help.js','utf8');
assert.match(help,/requireMerchantMembership/);
assert.match(help,/5 requests per merchant/);
const home=readFileSync('worker/src/merchant-home.js','utf8');
assert.match(home,/authenticateClerkSession/);
assert.match(home,/merchant_access/);
const page=readFileSync('public/merchant/index.html','utf8');
assert.match(page,/My transactions/);
assert.match(page,/Help & requests/);
assert.match(readFileSync('public/merchant/integrations/app.js','utf8'),/Save update method/);
assert.match(readFileSync('public/merchant/help/index.html','utf8'),/Submit an integration request/);
console.log('Self-service automatic fields, source isolation, merchant help emails & profile navigation: PASS');
