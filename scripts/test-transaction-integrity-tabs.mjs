import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=readFileSync('index.html','utf8');
assert.equal(root,readFileSync('public/index.html','utf8'),'Root and Worker home must match');
assert.match(root,/\/preview\/integrity\//);
assert.equal(readFileSync('preview/integrity/index.html','utf8'),
  readFileSync('public/preview/integrity/index.html','utf8'));
const page=readFileSync('public/merchant/transactions/index.html','utf8');
assert.match(page,/role="tablist"/);
for(const s of ['Transaction integrity','Transactions','Refunds','panel-transactions','panel-refunds'])
  assert(page.includes(s),'Missing UI component '+s);
const ui=readFileSync('public/merchant/transactions/app.js','utf8');
assert.match(ui,/\/api\/merchant\/refunds/);
assert.match(ui,/\/api\/merchant\/transactions/);
assert.match(ui,/(15000|30000)/,'Dashboard must refresh without manual work');
const records=readFileSync('worker/src/records.js','utf8');
const begin=records.indexOf('SELECT refund_id, transaction_id, merchant_id,merchant_name,processor,');
const end=records.indexOf(String.fromCharCode(96)+').bind(principal.sub,principal.sub).all()',begin);
assert(begin>=0&&end>begin,'Refund-history SQL query not found');
const query=records.slice(begin,end);
assert.match(query,/merchant_access/);
assert.match(query,/adjustment_type='REFUND'/);
assert.match(query,/square_refund_facts/);
const db=join(mkdtempSync(join(tmpdir(),'bg-refund-tabs-')),'test.sqlite');
function run(sql,output=false){
  return execFileSync('sqlite3',[...(output?['-json']:[]),db],
    {input:'PRAGMA foreign_keys=ON;\n'+sql+'\n',encoding:'utf8'}).trim();
}
for(const p of readdirSync('migrations').filter(p=>p.endsWith('.sql')).sort()){
  run(readFileSync('migrations/'+p,'utf8'));
  if(p.startsWith('0009_'))run(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
run("INSERT INTO merchant_access(id,merchant_id,external_user_id,role,status) VALUES('ACC-HISTORY','MER-0001','test-user','OWNER','ACTIVE');");
run("INSERT INTO transaction_financial_adjustments(id,transaction_id,merchant_id,processor,adjustment_type,direction,amount_cents,currency,processor_event_id,processor_object_id,adjustment_at) VALUES('ADJ-HISTORY','TX-0001','MER-0001','STRIPE','REFUND','MERCHANT_OUTFLOW',6500,'USD','evt_test','ch_test','2026-10-18T16:00:00Z');");
run("INSERT INTO transactions(id,purchase_id,merchant_id,customer_id,transaction_type,description,amount_cents,processor,fee_collection_method) VALUES('TX-SQ-HISTORY','PUR-0001','MER-0001','CUST-0001','PAYMENT','Square history',130000,'SQUARE','OTHER');");
run("INSERT INTO square_refund_facts(refund_id,transaction_id,processor_payment_id,status,amount_cents,app_fee_refunded_cents,currency) VALUES('SQ-REF-HISTORY','TX-SQ-HISTORY','sqpay-demo','COMPLETED',12000,12,'USD');");
function readFor(user){
  const sql=query.replaceAll('?',"'"+user.replaceAll("'","''")+"'");
  return JSON.parse(run(sql+';',true)||'[]');
}
const own=readFor('test-user');
assert.equal(own.length,2,'Merchant sees Stripe and Square refunds');
assert.deepEqual(new Set(own.map(r=>r.processor)),new Set(['STRIPE','SQUARE']));
assert.equal(own.find(r=>r.processor==='SQUARE').app_fee_refunded_cents,12);
assert.equal(own.find(r=>r.processor==='STRIPE').amount_cents,6500);
assert.equal(readFor('unrelated-user').length,0,'No cross-merchant disclosure');
run("UPDATE merchant_access SET status='REVOKED' WHERE id='ACC-HISTORY';");
assert.equal(readFor('test-user').length,0,'Revoked membership must block refunds');
console.log('Transaction Integrity tabs and refund-history SQL: PASS');
