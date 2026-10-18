import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transactionPdfLines } from '../worker/src/pdf-evidence.js';
import { buildTransactionPdf } from '../worker/src/pdf.js';
const base = {
  id:'TX-DEMO-RR-001',merchant_name:'Receptacle Rollers',customer_name:'Example HOA',
  merchant_reference:'HOA-30-UNITS',purchase_id:'PUR-DEMO',amount_cents:130000,
  currency:'USD',description:'30 homes with 60 carts, annualized monthly HOA service',
  consent_accepted:1,terms_snapshot:'The association approved weekly cart service.',
  terms_snapshot_sha256:'abc123',record_classification:'PROTECTED',
  lifecycle_status:'COMPLETE',integrity_status:'ACCOUNTED',exception_status:'NONE',
  processor_payout_status:'paid',payment_status:'completed',
  integrity_verified_at:'2026-10-18 15:20:00',integrity_fee_earned_cents:145,
  components:[{id:'COMP-DEMO',component_type_code:'PROCESSOR_FEE',amount_cents:3921,source_system:'STRIPE'}],
  artifacts:[{id:'ART-DEMO',document_type:'HOA_CONTRACT',content_sha256:'hash-demo',metadata:{description:'sample contract',token:'nope'}}],
  source_objects:[{id:'SRC-DEMO',source_system:'STRIPE',object_type:'PAYOUT',external_object_id:'fake-demo-payout'}],
  events:[{id:'EVT-D1',event_at:'2026-10-18',event_type:'PAYMENT_CONFIRMED',
    source:'SYSTEM',event_data:{receipt:'test',secret:'never-visible',customer_token:'hide'}}],
  exceptions:[],economics:{ledger:[{id:'ECO-DEMO',entry_kind:'REVENUE',
    category:'INTEGRITY_FEE',amount_micros:1450000,basis:'ACTUAL'}]}
};
for(const processor of ['SQUARE','STRIPE']){
  const tx={...base,processor,
    processor_checkout_id:processor==='SQUARE'?'square-checkout':null,
    processor_order_id:processor==='SQUARE'?'square-order':null,
    processor_payment_id:processor==='SQUARE'?'square-payment':null,
    processor_payout_id:processor==='SQUARE'?'square-payout':null,
    stripe_payment_intent_id:processor==='STRIPE'?'pi_demo':null,
    stripe_charge_id:processor==='STRIPE'?'ch_demo':null,
    stripe_balance_transaction_id:processor==='STRIPE'?'txn_demo':null,
    stripe_payout_id:processor==='STRIPE'?'po_demo':null
  };
  const merchant=transactionPdfLines(tx,{audience:'merchant'}).join('\n');
  const customer=transactionPdfLines(tx,{audience:'customer'}).join('\n');
  assert.match(merchant,/ACCOUNTED/);
  assert.match(merchant,/PROTECTED/);
  assert.match(merchant,/Example HOA/);
  assert.match(merchant,/Integrity locally verified at: 2026/);
  assert.match(merchant,/Event evidence/);
  assert.match(merchant,/COMP-DEMO/);
  assert.match(merchant,/ART-DEMO/);
  assert.match(merchant,/SRC-DEMO/);
  assert.doesNotMatch(customer,/COMP-DEMO|ART-DEMO|SRC-DEMO/);
  assert.match(merchant,/\[REDACTED\]/);
  assert.doesNotMatch(merchant,/never-visible|hide/);
  assert.doesNotMatch(merchant,/nope/);
  assert.doesNotMatch(customer,/Merchant fees|Event evidence|Economics ledger|Revenue|Fee earned/);
  assert.doesNotMatch(customer,/square-order|pi_demo/);
  assert.equal(customer.includes('Accepted terms snapshot:'),true);
  if(processor==='SQUARE')assert.match(merchant,/square-payment/);
  else assert.match(merchant,/pi_demo/);
  const bytes=buildTransactionPdf(tx,{audience:'merchant'});
  assert.equal(Buffer.from(bytes).toString('utf8',0,8),'%PDF-1.4');
  const changed=buildTransactionPdf({...tx,integrity_status:'NEEDS_ATTENTION'},{audience:'merchant'});
  assert.notDeepEqual(bytes,changed);
  console.log(processor+' PDF evidence: PASS');
}
const wrangler=readFileSync('wrangler.toml.example','utf8');
assert.match(wrangler,/\*\/2 \* \* \* \*/);
assert.match(wrangler,/\*\/10 \* \* \* \*/);
const runtime=readFileSync('worker/src/runtime.js','utf8');
assert.match(runtime,/verifyIntegritySnapshotBatch/);
assert.match(runtime,/controller.cron==='\*\/2 \* \* \* \*'/);
const watchdog=readFileSync('worker/src/watchdogs.js','utf8');
assert.match(watchdog,/checkIntegrityFreshness/);
const pdf=readFileSync('worker/src/pdf.js','utf8');
assert.match(pdf,/SHA-256/);
assert.match(pdf,/transaction-records\/\$\{tx.id\}\/\$\{audience\}\//);
console.log('2-minute verification + 10-minute watchdog + living PDFs: PASS');
