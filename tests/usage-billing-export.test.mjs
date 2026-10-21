import test from "node:test";
import assert from "node:assert/strict";
import {prepareUsageInvoiceExport} from "../worker/src/usage-billing-export.js";
const agreement={merchantId:"m",version:"v1",status:"ACTIVE",billingAuthorized:true,billingCustomerRef:"cus_test",meterEventName:"test_usage",currency:"USD"};
const entry={entryKey:"m/stripe/tx1",merchantId:"m",amountMicros:550000,currency:"USD",collectionStatus:"UNBILLED"};
test("prepares stable export but never charges",()=>{
 const result=prepareUsageInvoiceExport({agreement,entry});
 assert.equal(result.ready,true);assert.equal(result.requiresPricingAggregation,true);
 assert.equal(result.outboxKey,prepareUsageInvoiceExport({agreement,entry}).outboxKey);
});
test("rejects double export and missing billing authorization",()=>{
 assert.equal(prepareUsageInvoiceExport({agreement,entry,alreadyExported:true}).ready,false);
 assert.equal(prepareUsageInvoiceExport({agreement:{...agreement,billingAuthorized:false},entry}).ready,false);
});
test("does not report an invoice for cross-tenant or unsupported currency",()=>{
 assert.equal(prepareUsageInvoiceExport({agreement,entry:{...entry,merchantId:"wrong"}}).ready,false);
 assert.equal(prepareUsageInvoiceExport({agreement,entry:{...entry,currency:"EUR"}}).ready,false);
});
