import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
 sanitizeFieldDefinition,normalizeMerchantFieldValue,defineMerchantField,
 createMerchantSyncSource,ingestMerchantCustomFields,merchantFieldContext,
 merchantCustomerGroups,customersInGroup,verifyMerchantSyncToken,
 rotateMerchantSyncSource,revokeMerchantSyncSource
} from '../worker/src/merchant-custom-data.js';
import {transactionPdfLines} from '../worker/src/pdf-evidence.js';
assert.throws(()=>sanitizeFieldDefinition({field_key:'card_number',label:'Card number',
  record_scope:'CUSTOMER'}),/non-sensitive|credentials/);
assert.throws(()=>normalizeMerchantFieldValue('NaN','NUMBER'),/finite/);
assert.throws(()=>normalizeMerchantFieldValue('2026-02-30','DATE'),/YYYY-MM-DD/);
assert.equal(normalizeMerchantFieldValue('true','BOOLEAN'),'true');

const path=join(mkdtempSync(join(tmpdir(),'bg-field-test-')),'data.db');
function lit(v){if(v===null||v===undefined)return 'NULL';
 if(typeof v==='number')return String(v);
 return "'"+String(v).replaceAll("'","''")+"'";}
function sqlRun(sql,rows=false){
 const args=rows?['-json',path]:[path];
 const x=execFileSync('sqlite3',args,{encoding:'utf8',input:'PRAGMA foreign_keys=ON;\n'+sql+'\n'});
 return rows?JSON.parse(x.trim()||'[]'):x.trim();
}
for(const name of readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort()){
 sqlRun(readFileSync('migrations/'+name,'utf8'));
 if(name.startsWith('0009_'))sqlRun(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
sqlRun("UPDATE transactions SET merchant_payment_reference='RR-INVOICE-1' WHERE id='TX-0001';");
function statement(s){return {bind(...values){
 let at=0;const query=s.replace(/\?/g,()=>lit(values[at++]));
 assert.equal(at,values.length,'Unexpected SQL placeholders');
 return {first:async()=>sqlRun(query,true)[0]||null,all:async()=>({results:sqlRun(query,true)}),
   run:async()=>{sqlRun(query);return {success:true};},sql:query};
}};}
const env={DB:{
 prepare:statement,
 batch:async jobs=>{
  assert(jobs.every(x=>x.sql),'Every write must be bound');
  sqlRun('BEGIN;\n'+jobs.map(x=>x.sql+';').join('\n')+'\nCOMMIT;');
  return jobs.map(()=>({success:true}));
}}};
await defineMerchantField(env,'MER-0001','user-test',{
 field_key:'hoa_name',label:'HOA Community',group_title:'Locations',
 record_scope:'CUSTOMER',value_type:'TEXT'});
await defineMerchantField(env,'MER-0001','user-test',{
 field_key:'cart_count',label:'Weekly carts',group_title:'Services',
 record_scope:'TRANSACTION',value_type:'NUMBER'});
const source=await createMerchantSyncSource(env,'MER-0001','user-test','RR Google Sheet','FILE');
const records=[
 {scope:'CUSTOMER',external_reference:'CUST-0001',fields:{hoa_name:'West Bay HOA'}},
 {scope:'TRANSACTION',external_reference:'RR-INVOICE-1',fields:{cart_count:60}}
];
assert.deepEqual(await ingestMerchantCustomFields(env,'MER-0001',source.id,'batch-001',records),
 {duplicate:false,applied:2});
assert.deepEqual(await ingestMerchantCustomFields(env,'MER-0001',source.id,'batch-001',records),
 {duplicate:true,applied:2});
const next=[{scope:'CUSTOMER',external_reference:'CUST-0001',fields:{hoa_name:'West Bay HOA 55+'}}];
await ingestMerchantCustomFields(env,'MER-0001',source.id,'batch-002',next);
const fields=await merchantFieldContext(env,'MER-0001','CUST-0001','TX-0001');
assert.equal(fields.length,2);
assert.equal(fields.find(x=>x.field_key==='hoa_name').value_text,'West Bay HOA 55+');
assert.equal(fields.find(x=>x.field_key==='cart_count').value_text,'60');
const summary=await merchantCustomerGroups(env,'MER-0001','hoa_name');
assert.equal(summary.groups.length,1);
assert.equal(summary.groups[0].group_value,'West Bay HOA 55+');
assert.equal(summary.groups[0].transaction_count,1);
const list=await customersInGroup(env,'MER-0001','hoa_name','West Bay HOA 55+');
assert.equal(list.records[0].transaction_id,'TX-0001');
assert.match(transactionPdfLines({id:'TX-0001',custom_fields:fields},{audience:'merchant'}).join('\n'),
 /West Bay HOA 55\+/);
assert.doesNotMatch(transactionPdfLines({id:'TX-0001',custom_fields:fields},{audience:'customer'}).join('\n'),
 /West Bay HOA 55\+/);
await assert.rejects(()=>ingestMerchantCustomFields(env,'MER-0001',source.id,'bad-cross',
 [{scope:'CUSTOMER',external_reference:'nonexistent',fields:{hoa_name:'Other'}}]),/Unmatched/);
await assert.rejects(()=>ingestMerchantCustomFields(env,'MER-0001',source.id,'bad-truth',
 [{scope:'TRANSACTION',external_reference:'RR-INVOICE-1',fields:{payment_status:'PAID'}}]),/Unregistered/);
assert.equal(sqlRun("SELECT COUNT(*) AS n FROM merchant_custom_sync_deliveries WHERE source_id="+lit(source.id),true)[0].n,2);

const push=await createMerchantSyncSource(env,'MER-0001','user-test','CRM update feed','WEBHOOK');
assert(push.token_once.startsWith('bg_sync_'));
assert.equal((await verifyMerchantSyncToken(env,push.id,push.token_once))?.merchant_id,'MER-0001');
const rotated=await rotateMerchantSyncSource(env,'MER-0001',push.id);
assert.equal(await verifyMerchantSyncToken(env,push.id,push.token_once),null);
assert.equal((await verifyMerchantSyncToken(env,push.id,rotated.token_once))?.id,push.id);
await revokeMerchantSyncSource(env,'MER-0001',push.id);
assert.equal(await verifyMerchantSyncToken(env,push.id,rotated.token_once),null);

const route=readFileSync('worker/src/merchant-custom-routes.js','utf8');
assert.match(route,/requireMerchantMembership/);
assert.match(route,/CUSTOM_SYNC_ENABLED/);
assert.match(route,/readBoundedJson/);
const recordsFile=readFileSync('worker/src/records.js','utf8');
assert.match(recordsFile,/merchantFieldContext/);
const bank=readFileSync('public/merchant/bank/app.js','utf8');
assert.match(bank,/reauthorize/);
const html=readFileSync('public/merchant/integrations/index.html','utf8');
assert.match(html,/groupCustomers/);
console.log('Custom fields: scoped references, revisions, grouping, customer/transaction PDFs, source key rotation: PASS');
