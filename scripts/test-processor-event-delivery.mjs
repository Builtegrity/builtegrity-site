import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {normalizeProviderEvent} from '../worker/src/processor-event-delivery.js';

const at='2026-10-18T19:45:32.120Z';
const sq=normalizeProviderEvent('SQUARE',{event_id:'square-event-1',type:'refund.updated',
  merchant_id:'seller-1',created_at:'2026-10-18T19:45:27.200Z'},at);
assert.equal(sq.processor,'SQUARE');
assert.equal(sq.id,'square-event-1');
assert.equal(sq.providerAccount,'seller-1');
assert.equal(sq.providerTime,'2026-10-18T19:45:27.200Z');
const stripe=normalizeProviderEvent('STRIPE',{id:'evt_01',type:'charge.refunded',
  account:'acct_01',created:1792352727},at);
assert.equal(stripe.processor,'STRIPE');
assert.equal(stripe.providerAccount,'acct_01');
assert.equal(stripe.providerTime,new Date(1792352727*1000).toISOString());
assert.throws(()=>normalizeProviderEvent('UNSUPPORTED',{id:'evt_x'}));
assert.throws(()=>normalizeProviderEvent('SQUARE',{event_id:''}));
const db=join(mkdtempSync(join(tmpdir(),'bg-provider-timing-')),'test.sqlite');
function run(sql,output=false){
  return execFileSync('sqlite3',[...(output?['-json']:[]),db],
    {input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'}).trim();
}
run(readFileSync('migrations/0067_processor_event_delivery_audit.sql','utf8'));
const values="'SQUARE','square-event-1','refund.updated','seller-1','2026-10-18T19:45:27.200Z','"+at+"'";
run('INSERT INTO processor_event_delivery_audit(processor,provider_event_id,event_type,provider_account_id,provider_event_created_at,received_at) VALUES('+values+');');
run('INSERT INTO processor_event_delivery_audit(processor,provider_event_id,event_type,provider_account_id,provider_event_created_at,received_at) VALUES('+values+') ON CONFLICT(processor,provider_event_id) DO UPDATE SET attempts=attempts+1,last_delivery_at=CURRENT_TIMESTAMP;');
run("UPDATE processor_event_delivery_audit SET outcome='PROCESSED',processed_at=CURRENT_TIMESTAMP WHERE provider_event_id='square-event-1';");
const list=JSON.parse(run('SELECT processor,provider_event_id,attempts,outcome,provider_event_created_at,received_at FROM processor_event_delivery_audit;',true));
assert.equal(list.length,1);
assert.equal(list[0].attempts,2);
assert.equal(list[0].outcome,'PROCESSED');
const runtime=readFileSync('worker/src/runtime.js','utf8');
assert(runtime.includes("normalizeProviderEvent('STRIPE'"));
assert(runtime.includes("normalizeProviderEvent('SQUARE'"));
assert(runtime.includes('/api/watchdogs/provider-timing'));
assert(runtime.includes('verifyStripeSignature'));
assert(runtime.includes('verifySquareWebhook'));
console.log('Provider event-created vs signed webhook arrival audit: PASS');
