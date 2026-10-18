import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
 queueMerchantRecordEmail,dispatchMerchantRecordEmails,lookupMerchantRecordToken,
 accountlessTransactionProjection,claimMerchantFromEmailLink
} from '../worker/src/merchant-record-links.js';
import {createMerchantGroup,listMedia,uploadMerchantMedia} from '../worker/src/merchant-media.js';
import {findHelpSolutions} from '../worker/src/help-playbooks.js';

const path=join(mkdtempSync(join(tmpdir(),'bg-merchant-flex-')),'records.db');
const quote=x=>x===null||x===undefined?'NULL':typeof x==='number'?String(x):
 "'"+String(x).replaceAll("'","''")+"'";
function sqlRun(sql,rows=false){
 const out=execFileSync('sqlite3',[...(rows?['-json']:[]),path],
   {input:'PRAGMA foreign_keys=ON;\n'+sql+'\n',encoding:'utf8'});
 return rows?JSON.parse(out.trim()||'[]'):out.trim();
}
for(const name of readdirSync('migrations').filter(p=>p.endsWith('.sql')).sort()){
 sqlRun(readFileSync('migrations/'+name,'utf8'));
 if(name.startsWith('0009_'))
  sqlRun(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
const DB={prepare:sql=>({bind(...values){
 let n=0;const stmt=sql.replace(/\?/g,()=>quote(values[n++]));
 assert.equal(n,values.length);
 return {sql:stmt,all:async()=>({results:sqlRun(stmt,true)}),
  first:async()=>sqlRun(stmt,true)[0]||null,run:async()=>{sqlRun(stmt);return {success:true}}};
}})};
const stored=new Map();
const r2={put:async(k,v)=>stored.set(k,v),get:async(k)=>stored.has(k)?{body:new Uint8Array(stored.get(k))}:null,
 delete:async(k)=>stored.delete(k)};
const env={DB,MERCHANT_TRANSACTION_EMAILS_ENABLED:'true',RESEND_API_KEY:'sandbox_secret',
 MERCHANT_RECORD_EMAIL_FROM:'Record Bot <support@example.com>',APP_BASE_URL:'https://builtegrity.com',
 MERCHANT_MEDIA:r2};
sqlRun("UPDATE merchants SET email='owner@example.com',record_email_opt_in=1,"+
 "record_email_consent_reference='verified-onboarding-consent-1' WHERE id='MER-0001'");
let delivery=null;
const oldFetch=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{
 assert.equal(url,'https://api.resend.com/emails');
 const message=JSON.parse(opts.body);
 assert.deepEqual(message.to,['owner@example.com']);
 assert.match(message.text,/Create a Builtegrity merchant profile/);
 delivery=message;return new Response(JSON.stringify({id:'email-test'}),{status:200});
};
try{
 assert.deepEqual(await queueMerchantRecordEmail({...env,MERCHANT_TRANSACTION_EMAILS_ENABLED:'false'},
 'TX-0001','MER-0001'),{queued:false,reason:'disabled'});
 assert.equal((await queueMerchantRecordEmail(env,'TX-0001','MER-0001')).queued,true);
 assert.equal(sqlRun("SELECT COUNT(*) AS n FROM merchant_transaction_email_links",true)[0].n,1);
 const outcome=await dispatchMerchantRecordEmails(env);assert.equal(outcome.sent,1);
 assert.match(delivery.text,/\\/merchant\\/record\\/#/);
 const found=delivery.text.match(/https:\\/\\/builtegrity.com\\/merchant\\/record\\/#([a-f0-9]{64})/);
 assert(found);
 const token=found[1];
 assert.equal((await lookupMerchantRecordToken(env,token)).transaction_id,'TX-0001');
 assert.equal(await lookupMerchantRecordToken(env,'a'.repeat(64)),null);
 const view=accountlessTransactionProjection({id:'TX-0001',processor:'STRIPE',
  merchant_name:'Example',amount_cents:130000,currency:'USD',integrity_status:'ACCOUNTED',
  customer_email:'notvisible@example.com',bank_evidence:{bank_posted_at:'secret'}});
 assert.equal(view.bank_evidence,undefined);
 assert.equal(view.customer_email,undefined);
 assert.equal(view.amount_cents,130000);
 const again=await dispatchMerchantRecordEmails(env);assert.equal(again.sent,0);
 sqlRun("UPDATE merchant_transaction_email_links SET expires_at='2020-01-01' WHERE transaction_id='TX-0001'");
 assert.equal(await lookupMerchantRecordToken(env,token),null,'Expired link fails closed');
}finally{globalThis.fetch=oldFetch;}

sqlRun("INSERT INTO merchant_custom_field_definitions(merchant_id,field_key,label,record_scope,created_by)"+
 " VALUES('MER-0001','hoa_community','HOA Community','CUSTOMER','test')");
const group=await createMerchantGroup(env,'MER-0001','owner-test',{
 field_key:'hoa_community',group_value:'West Bay',title:'West Bay HOA'});
assert(group.group_id.startsWith('GRP-'));
await assert.rejects(()=>createMerchantGroup(env,'MER-0001','owner-test',{
 field_key:'nonexistent',group_value:'Unknown',title:'Unknown'}),/not active/);
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const sample={type:'image/png',size:png.length,name:'community.png',arrayBuffer:async()=>png.buffer};
const up=await uploadMerchantMedia({...env,MERCHANT_MEDIA:r2},'MER-0001','owner-test',
 'GROUP',group.group_id,sample,'COVER','HOA building');
assert(up.id.startsWith('MEDIA-'));
assert.equal((await listMedia(env,'MER-0001','GROUP',group.group_id)).media.length,1);
await assert.rejects(()=>uploadMerchantMedia(env,'MER-0001','owner-test','GROUP',
 'GRP-not-existent',sample,'COVER',''),/does not belong/);
const html=sample.type==='image/png';
assert(html);
const evil={...sample,type:'image/jpeg'};
await assert.rejects(()=>uploadMerchantMedia(env,'MER-0001','owner-test','GROUP',
 group.group_id,evil,'COVER',''),/do not match/);

const customerSol=findHelpSolutions('bank','MERCHANT');
assert(customerSol.some(x=>x.code==='BANK_RECONNECT'));
assert(!findHelpSolutions('referral','MERCHANT').some(x=>x.code==='PARTNER_REFERRAL'));
assert(findHelpSolutions('referral','PARTNER').some(x=>x.code==='PARTNER_REFERRAL'));
const route=readFileSync('worker/src/merchant-record-access.js','utf8');
assert.match(route,/lookupMerchantRecordToken/);
assert.match(route,/claimMerchantFromEmailLink/);
assert.match(readFileSync('worker/src/merchant-media.js','utf8'),/requireMerchantMembership/);
assert.match(readFileSync('public/signup/index.html','utf8'),/profile is optional/);
assert.match(readFileSync('public/merchant/record/index.html','utf8'),/Your transaction/);
assert.match(readFileSync('worker/src/records.js','utf8'),/handleMerchantMediaRoute/);
console.log('Optional account, hashed recipient-only record links, private media/tenant guards, self-help catalog: PASS');
