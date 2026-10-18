import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateHelpRequest,deliverMerchantHelpRequests} from '../worker/src/merchant-help.js';
import {createMerchantSyncSource,listMerchantSyncSources} from '../worker/src/merchant-custom-data.js';

const valid={
 topic:'CONNECT_SOURCE',subject:'Connect our service management database',
 description:'Our system sends property route and job information that should appear in transactions.',
 source_system:'Example Field Service CRM',desired_outcome:'Sync job number and route updates',
 example_reference:'RR-INVOICE-1'
};
assert.equal(validateHelpRequest(valid).topic,'CONNECT_SOURCE');
assert.throws(()=>validateHelpRequest({...valid,topic:'UNKNOWN'}),/topic/i);
assert.throws(()=>validateHelpRequest({...valid,description:'sk_live_fake_secret_example'}),/Do not submit/);
assert.throws(()=>validateHelpRequest({...valid,subject:'x'}),/length/);

const dbPath=join(mkdtempSync(join(tmpdir(),'bg-merchant-help-')),'test.db');
function lit(x){if(x===null||x===undefined)return 'NULL';
 if(typeof x==='number')return String(x);
 return "'"+String(x).replaceAll("'","''")+"'";}
function run(sql,list=false){
 const r=execFileSync('sqlite3',[...(list?['-json']:[]),dbPath],{
  input:'PRAGMA foreign_keys=ON;\n'+sql+'\n',encoding:'utf8'}).trim();
 return list?JSON.parse(r||'[]'):r;
}
for(const migration of readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort()){
 run(readFileSync('migrations/'+migration,'utf8'));
 if(migration.startsWith('0009_'))run(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
const env={DB:{prepare(query){return {bind(...params){
 let i=0;const sql=query.replace(/\?/g,()=>lit(params[i++]));
 assert.equal(i,params.length);
 return {sql,first:async()=>run(sql,true)[0]||null,
  all:async()=>({results:run(sql,true)}),run:async()=>({success:!run(sql)})};
}};}}};
const push=await createMerchantSyncSource(env,'MER-0001','test-owner','ERP updates','APP_PUSH',5);
assert.equal(push.expected_interval_minutes,5);
let sources=await listMerchantSyncSources(env,'MER-0001');
assert.equal(sources.find(x=>x.id===push.id).sync_health,'AWAITING_FIRST_UPDATE');
run("UPDATE merchant_custom_sync_sources SET last_success_at=datetime('now','-30 minutes') WHERE id="+lit(push.id));
sources=await listMerchantSyncSources(env,'MER-0001');
assert.equal(sources.find(x=>x.id===push.id).sync_health,'LATE');
run("UPDATE merchant_custom_sync_sources SET last_success_at=CURRENT_TIMESTAMP WHERE id="+lit(push.id));
sources=await listMerchantSyncSources(env,'MER-0001');
assert.equal(sources.find(x=>x.id===push.id).sync_health,'CURRENT');
const none=await createMerchantSyncSource(env,'MER-0001','test-owner','Spreadsheet','FILE',5);
assert.equal(none.expected_interval_minutes,null);
assert.equal((await listMerchantSyncSources(env,'MER-0001')).find(x=>x.id===none.id).sync_health,'MANUAL_IMPORT');
await assert.rejects(()=>createMerchantSyncSource(env,'MER-0001','test-owner','Invalid interval','WEBHOOK',1),/5 minutes/);

const requestId='HELP-'+crypto.randomUUID();
run("INSERT INTO merchant_help_requests(id,merchant_id,created_by,topic,subject,description,source_system,desired_outcome,example_reference) VALUES("+
 [requestId,'MER-0001','owner-test',valid.topic,valid.subject,valid.description,
  valid.source_system,valid.desired_outcome,valid.example_reference].map(lit).join(',')+");");
const pending=run('SELECT id,request_status,delivery_state FROM merchant_help_requests WHERE id='+lit(requestId),true)[0];
assert.deepEqual([pending.request_status,pending.delivery_state],['OPEN','QUEUED']);
assert.equal((await deliverMerchantHelpRequests(env)).email_enabled,false,'Email must be gated');
assert.equal(run('SELECT delivery_state FROM merchant_help_requests WHERE id='+lit(requestId),true)[0].delivery_state,'QUEUED');
let attempts=0;const oldFetch=globalThis.fetch;
globalThis.fetch=async(_url,opts)=>{
 attempts++;
 assert.equal(opts.headers['Idempotency-Key'],requestId);
 const message=JSON.parse(opts.body);
 assert.match(message.text,/Merchant:.*MER-0001/);
 assert.equal(message.to[0],'help-owner@example.com');
 return new Response(JSON.stringify({id:'email-test-1'}),{status:200});
};
try{
 const out=await deliverMerchantHelpRequests({...env,
  MERCHANT_HELP_EMAILS_ENABLED:'true',RESEND_API_KEY:'test-key',
  HELP_REQUEST_EMAIL_FROM:'Builtegrity Help <support@example.com>',
  HELP_REQUEST_EMAIL_TO:'help-owner@example.com'
 });
 assert.equal(out.sent,1);
 assert.equal(attempts,1);
 assert.equal(run('SELECT delivery_state FROM merchant_help_requests WHERE id='+lit(requestId),true)[0].delivery_state,'SENT');
 await deliverMerchantHelpRequests({...env,MERCHANT_HELP_EMAILS_ENABLED:'true',
  RESEND_API_KEY:'test-key',HELP_REQUEST_EMAIL_FROM:'support@example.com',
  HELP_REQUEST_EMAIL_TO:'help-owner@example.com'});
 assert.equal(attempts,1,'Sent tickets must not be emailed a second time');
}finally{globalThis.fetch=oldFetch;}

for(const path of ['public/merchant/index.html','public/merchant/help/index.html',
 'public/merchant/help/app.js','public/merchant/transactions/index.html']){
 assert(readFileSync(path,'utf8').length>100,'Missing real user interface: '+path);
}
const home=readFileSync('public/merchant/index.html','utf8');
for(const path of ['/merchant/transactions/','/merchant/integrations/',
 '/merchant/setup/','/merchant/help/'])assert(home.includes(path),'Missing navigation: '+path);
const help=readFileSync('public/merchant/help/index.html','utf8');
for(const id of ['helpTopic','helpMerchant','helpSubject','helpDescription','helpDesired','helpSubmit'])
 assert(help.includes('id="'+id+'"'),'Missing form element '+id);
const creation=readFileSync('worker/src/index.js','utf8');
assert.match(creation,/txInput\.custom_fields/);
assert.match(creation,/source_id,source_event_id/);
assert.match(creation,/CHECKOUT_CREATE/);
const routes=readFileSync('worker/src/records.js','utf8');
assert.match(routes,/handleMerchantHelpRoute/);
const config=readFileSync('wrangler.toml.example','utf8');
assert.match(config,/MERCHANT_HELP_EMAILS_ENABLED = "false"/);
console.log('Merchant profile, help intake, async email notification and custom source freshness: PASS');
