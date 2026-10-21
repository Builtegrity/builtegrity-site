import test from "node:test";
import assert from "node:assert/strict";
import {usageLedgerEntry,adjustmentEntry,summarizeLedger} from "../worker/src/usage-fee-ledger.js";
const input={eligibility:{eligible:true,key:"m1/stripe/acct/pi/v1",pricingPolicyId:"TEST_ONLY"},merchantId:"m1",provider:"stripe",processorAccountId:"acct",transactionId:"pi",currency:"USD",amountMicros:550000,occurredAt:"2026-10-21T00:00:00Z"};
const entry=usageLedgerEntry(input);
test("creates deterministic and immutable unbilled entitlement",()=>{
 assert.deepEqual(usageLedgerEntry(input),entry);
 assert.ok(Object.isFrozen(entry));
 assert.equal(entry.collectionStatus,"UNBILLED");
});
test("fails closed on ineligible payment and unsafe amounts",()=>{
 assert.throws(()=>usageLedgerEntry({...input,eligibility:{eligible:false}}),/INELIGIBLE/);
 assert.throws(()=>usageLedgerEntry({...input,amountMicros:0.5}),/INVALID_FEE/);
});
test("tracks credits separately without rewriting original fee",()=>{
 const credit=adjustmentEntry({original:entry,adjustmentId:"refund_1",deltaMicros:-150000,reason:"REFUND",occurredAt:"2026-10-22T00:00:00Z"});
 const result=summarizeLedger({entitlements:[entry],adjustments:[credit],collections:[]});
 assert.equal(result.netEarnedMicros,400000);
 assert.equal(result.collectedMicros,0);
 assert.equal(entry.amountMicros,550000);
});
test("rejects replayed entitlements and adjustment duplicates",()=>{
 assert.throws(()=>summarizeLedger({entitlements:[entry,entry],adjustments:[]}),/DUPLICATE/);
 const a=adjustmentEntry({original:entry,adjustmentId:"refund_1",deltaMicros:-100000,reason:"REFUND",occurredAt:"2026-10-22T00:00:00Z"});
 assert.throws(()=>summarizeLedger({entitlements:[entry],adjustments:[a,a]}),/DUPLICATE/);
});
test("cannot over-credit or mix currencies",()=>{
 const a=adjustmentEntry({original:entry,adjustmentId:"a",deltaMicros:-350000,reason:"REFUND",occurredAt:"t"});
 const b=adjustmentEntry({original:entry,adjustmentId:"b",deltaMicros:-350000,reason:"REFUND",occurredAt:"t"});
 assert.throws(()=>summarizeLedger({entitlements:[entry],adjustments:[a,b]}),/OVER_CREDITED/);
 assert.throws(()=>summarizeLedger({entitlements:[entry],adjustments:[],collections:[{collectionKey:"c",currency:"EUR",collectedMicros:50}]}),/MIXED_CURRENCIES/);
});
test("paid status requires separate verified collection evidence",()=>{
 const r=summarizeLedger({entitlements:[entry],adjustments:[],collections:[{collectionKey:"inv_paid_1",currency:"USD",collectedMicros:550000}]});
 assert.equal(r.earnedMicros,550000);assert.equal(r.collectedMicros,550000);
});
