
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'builtegrity-square-ci-'));
const db = join(dir, 'dual.sqlite');
function run(sql) {
  return execFileSync('sqlite3', [db], {input: 'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
}
const migrations=readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort();
for(const file of migrations){
  run(readFileSync('migrations/'+file,'utf8'));
  if(file.startsWith('0009_'))run(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
run(readFileSync('transaction-engine/ci-legal-clearance.sql','utf8'));
run(readFileSync('transaction-engine/ci-transaction-jurisdiction.sql','utf8'));

const t="TX-SQUARE-PROOF";
run("INSERT INTO transactions (id,purchase_id,merchant_id,customer_id,transaction_type,description,amount_cents,currency,processor,fee_collection_method,integrity_fee_earned_cents,consent_accepted,customer_attested_country_code,customer_attested_state_code,customer_attested_at,checkout_legal_gate_at,fee_refund_rule_locked_at,merchant_fee_policy_acceptance_id,processor_checkout_id,processor_order_id,processor_payment_id,payment_status) VALUES ('"+t+"','PUR-0001','MER-0001','CUST-0001','PAYMENT','Synthetic square proof',120000,'USD','SQUARE','OTHER',25,1,'US','RI',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'MFPA-CI-MER-0001','link-ci','order-ci','pay-ci','PENDING');");
assert.equal(run("SELECT record_classification FROM transactions WHERE id='"+t+"';"),'PENDING_PROTECTED');
run("UPDATE transactions SET payment_at=CURRENT_TIMESTAMP,payment_status='COMPLETED',customer_paid_cents=amount_cents WHERE id='"+t+"';");
assert.equal(run("SELECT record_classification FROM transactions WHERE id='"+t+"';"),'FEE_EXCEPTION');
assert.equal(run("SELECT bg_fee_earned_cents FROM transactions WHERE id='"+t+"';"),'0');
run("UPDATE transactions SET processor_app_fee_confirmed_cents=25,application_fee_gross_confirmed_cents=25,integrity_fee_collected_cents=25 WHERE id='"+t+"';");
assert.equal(run("SELECT record_classification FROM transactions WHERE id='"+t+"';"),'PROTECTED');
assert.equal(run("SELECT bg_fee_earned_cents FROM transactions WHERE id='"+t+"';"),'25');
assert.equal(run("SELECT COUNT(*) FROM transaction_fee_entitlements WHERE transaction_id='"+t+"';"),'1');
assert.equal(run("SELECT COUNT(*) FROM transaction_economics_ledger WHERE transaction_id='"+t+"' AND entry_kind='REVENUE' AND basis='ACTUAL';"),'1');
function mustReject(sql,label) {
  let failed=false;
  try{run(sql)}catch{failed=true}
  assert.ok(failed,label);
}
mustReject("UPDATE transactions SET processor='STRIPE' WHERE id='"+t+"';",'processor must remain immutable');
mustReject("UPDATE transactions SET bg_fee_earned_cents=bg_fee_earned_cents+1 WHERE id='"+t+"';",'protected revenue must remain immutable');
mustReject("UPDATE transactions SET processor_app_fee_confirmed_cents=1 WHERE id='"+t+"';",'protected fee proof must remain immutable');
mustReject("INSERT INTO transactions(id,purchase_id,merchant_id,customer_id,transaction_type,description,amount_cents,processor,record_classification,bg_fee_earned_cents) VALUES('TX-SQUARE-BAD','PUR-0001','MER-0001','CUST-0001','PAYMENT','Fake',120000,'SQUARE','PROTECTED',25);",'cannot insert unverified protected payment');
console.log('Square protection SQL lifecycle: PASS (missing fee, verified fee, immutable proof, carry/ledger recognition)');
