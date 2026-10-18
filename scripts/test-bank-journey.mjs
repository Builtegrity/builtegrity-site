import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { observedPlaidCredit,encryptBankToken,decryptBankToken,payoutBankEvidence } from '../worker/src/bank-evidence.js';
import { transactionPdfLines } from '../worker/src/pdf-evidence.js';

const credit=observedPlaidCredit({transaction_id:'bank-txn-1',account_id:'bank-account-1',
  amount:-1298.44,iso_currency_code:'USD',name:'STRIPE TRANSFER',date:'2026-10-18',pending:false});
assert.equal(credit.credit,129844);
assert.equal(credit.pending,false);
assert.equal(observedPlaidCredit({transaction_id:'b',account_id:'a',amount:15,
  iso_currency_code:'USD'}),null,'Outbound bank debit is not a deposit');
const env={BANK_TOKEN_ENCRYPTION_KEY_B64:Buffer.alloc(32,17).toString('base64')};
const stored=await encryptBankToken(env,'access-sandbox-example');
assert.equal(await decryptBankToken(env,stored),'access-sandbox-example');
assert.notEqual(stored.ciphertext,'access-sandbox-example');
const tx={merchant_id:'MER-0001',id:'TX-0001',processor:'STRIPE',
  stripe_payout_id:'po_bank_demo',amount_cents:130000,currency:'USD'};
const lines=transactionPdfLines({...tx,integrity_status:'INCOMPLETE'},{audience:'merchant'}).join('\n');
assert(!lines.includes('OPTIONAL CONNECTED BANK'),'No link = no bank section');
const withBank=transactionPdfLines({...tx,bank_evidence:{
 status:'BANK_POSTED',verified:true,bank_transaction_date:'2026-10-18',
 matched_payout_amount_cents:129844,evidence_source:'PLAID_TRANSACTIONS'}},{audience:'merchant'}).join('\n');
assert(withBank.includes('BANK_POSTED')&&withBank.includes('1298.44 USD'));
const customer=transactionPdfLines({...tx,bank_evidence:{status:'BANK_POSTED'}},
 {audience:'customer'}).join('\n');
assert(!customer.includes('BANK_POSTED'),'No merchant bank evidence in customer copy');

const db=join(mkdtempSync(join(tmpdir(),'builtegrity-bank-proof-')),'proof.db');
const quote=v=>v===null?'NULL':typeof v==='number'?String(v):
  "'"+String(v).replaceAll("'","''")+"'";
function run(sql,rows=false){
 const args=rows?['-json',db]:[db];
 const out=execFileSync('sqlite3',args,{
  input:'PRAGMA foreign_keys=ON;\n'+sql+'\n',encoding:'utf8'});
 return rows?JSON.parse(out.trim()||'[]'):out.trim();
}
for(const path of readdirSync('migrations').filter(p=>p.endsWith('.sql')).sort()){
 run(readFileSync('migrations/'+path,'utf8'));
 if(path.startsWith('0009_'))run(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
const fakeDb={
 prepare(sql){return {bind(...values){
   let n=0;
   const filled=sql.replace(/\?/g,()=>quote(values[n++]));
   assert.equal(n,values.length);
   return {first:async()=>run(filled,true)[0]||null,all:async()=>({results:run(filled,true)}),
    run:async()=>run(filled)};
 }};}
};
assert.equal(await payoutBankEvidence({DB:fakeDb},tx),null);
run("INSERT INTO merchant_bank_connections(id,merchant_id,item_id,access_token_ciphertext,access_token_iv,status) VALUES('BANK-DEMO','MER-0001','item-example','encrypted','iv','CONNECTED');");
run("INSERT INTO merchant_bank_accounts(merchant_id,connection_id,provider_account_id,account_name,is_payout_target) VALUES('MER-0001','BANK-DEMO','account-bank-demo','Example business checking',1);");
let pending=await payoutBankEvidence({DB:fakeDb},tx);
assert.equal(pending.status,'AWAITING_BANK_EVIDENCE');
run("INSERT INTO merchant_bank_deposit_observations(provider_transaction_id,connection_id,merchant_id,provider_account_id,credit_cents,currency,display_name,pending,bank_transaction_date,bank_posted_at) VALUES('bank-txn-1','BANK-DEMO','MER-0001','account-bank-demo',129844,'USD','STRIPE PAYOUT',0,'2026-10-18','2026-10-18');");
run("INSERT INTO processor_bank_payout_matches(merchant_id,processor,payout_id,bank_transaction_id,matched_amount_cents,status,bank_posted_at) VALUES('MER-0001','STRIPE','po_bank_demo','bank-txn-1',129844,'BANK_POSTED','2026-10-18');");
assert.equal((await payoutBankEvidence({DB:fakeDb},tx)).status,'BANK_POSTED');
run("UPDATE merchant_bank_connections SET status='DISCONNECTED' WHERE id='BANK-DEMO';");
assert.equal(await payoutBankEvidence({DB:fakeDb},tx),null,'No active consent => bank evidence hidden');
assert.match(readFileSync('public/merchant/transactions/index.html','utf8'),/journey-card/);
const js=readFileSync('public/merchant/transactions/app.js','utf8');
assert.match(js,/createCard/);assert.match(js,/refreshJourney/);
assert.match(js,/15000/);assert.match(js,/pdfIcon/);
assert.match(readFileSync('worker/src/records.js','utf8'),/payoutBankEvidence/);
console.log('Bank evidence gating, redaction, PDF and live journey structure: PASS');
