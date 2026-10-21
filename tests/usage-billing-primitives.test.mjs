import test from "node:test";
import assert from "node:assert/strict";
import {assessUsageEligibility, entitlementKey} from "../worker/src/usage-billing-primitives.js";

const agreement = {
 merchantId:"merchant_A",status:"ACTIVE",acceptedAt:"2026-10-20T00:00:00Z",
 effectiveFrom:"2026-10-20T00:00:00Z",version:"v1",pricingPolicyId:"CANDIDATE_FOR_TEST_ONLY",
 currency:"USD",billingAuthorized:true,allowedProviders:["stripe","square"]
};
const payment = {merchantId:"merchant_A",provider:"stripe",processorAccountId:"acct_A",
 transactionId:"pi_123",status:"SUCCEEDED",verified:true,currency:"USD",
 amountMinor:10000,occurredAt:"2026-10-21T00:00:00Z"};
const check=(overrides={},p=payment,a=agreement)=>assessUsageEligibility({
 agreement:{...a,...overrides},payment:p,collectionMode:"USAGE_BILLING"
});

test("qualifying external processor payment has stable tenant-scoped entitlement key",()=>{
 const first=check();assert.equal(first.eligible,true);
 assert.equal(first.key,check().key);
 assert.notEqual(first.key,entitlementKey({merchantId:"merchant_B",provider:"stripe",
 processorAccountId:"acct_A",transactionId:"pi_123",component:"SUCCESSFUL_PAYMENT",agreementVersion:"v1"}));
});
test("no accepted active agreement or billing authorization",()=>{
 assert.equal(check({acceptedAt:null}).eligible,false);
 assert.equal(check({billingAuthorized:false}).eligible,false);
 assert.equal(check({status:"SUSPENDED"}).eligible,false);
});
test("no fees for unverified, failed, prior or cross-tenant payment",()=>{
 assert.equal(check({}, {...payment,verified:false}).eligible,false);
 assert.equal(check({}, {...payment,status:"FAILED"}).eligible,false);
 assert.equal(check({}, {...payment,occurredAt:"2026-10-19T00:00:00Z"}).eligible,false);
 assert.equal(check({}, {...payment,merchantId:"merchant_B"}).eligible,false);
});
test("no double charging on protected checkout application fee",()=>{
 assert.equal(assessUsageEligibility({agreement,payment,collectionMode:"USAGE_BILLING",existingApplicationFee:true}).eligible,false);
 assert.equal(assessUsageEligibility({agreement,payment,collectionMode:"APPLICATION_FEE"}).eligible,false);
});
test("cannot bill unspecified provider or currency",()=>{
 assert.equal(check({}, {...payment,provider:"unknown"}).eligible,false);
 assert.equal(check({}, {...payment,currency:"EUR"}).eligible,false);
});
