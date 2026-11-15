import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeExternallyInitiatedStripePayment, previewStripeObservationFee,
} from '../worker/src/stripe-observation-proof.js';

const merchantId = 'MER-0002';
const event = {
  id: 'evt_12345', type: 'payment_intent.succeeded', created: 1794700800,
  account: 'acct_12345',
  data: { object: { id: 'pi_12345', status: 'succeeded', amount_received: 20000, currency: 'usd', metadata: {} } },
};
const connection = { provider: 'STRIPE', status: 'ACTIVE', merchantId, processorAccountId: 'acct_12345', paymentsReadable: true };
const retrievedIntent = { id: 'pi_12345', status: 'succeeded', latest_charge: 'ch_12345', currency: 'usd', amount_received: 20000, metadata: {} };
const retrievedCharge = { id: 'ch_12345', payment_intent: 'pi_12345', status: 'succeeded', paid: true, captured: true, amount_captured: 20000, currency: 'usd', balance_transaction: 'txn_12345', metadata: {} };
const verified = {event, connection, retrievedIntent, retrievedCharge, signatureVerified:true, processorAccessVerified:true};
const agreement = {merchantId, status:'ACTIVE', acceptedAt:'2026-11-01T00:00:00.000Z', effectiveFrom:'2026-11-01T00:00:00.000Z', version:'v1', pricingPolicyId:'BG_OBSERVED_300BPS_V1', rateBps:300, currency:'USD', allowedProviders:['STRIPE'], billingAuthorized:true};

const obs = props => normalizeExternallyInitiatedStripePayment({...verified,...props});
const quote = (o=obs(), a=agreement, prior=false) => previewStripeObservationFee({observation:o, agreement:a, existingApplicationFee:prior});

test('verified unrelated checkout normalizes to OBSERVED, not PROTECTED',()=>{
  const r=obs();
  assert.equal(r.eligible,true);
  assert.equal(r.recordClassification,'OBSERVED');
  assert.equal(r.integrityState,'INCOMPLETE');
  assert.equal(r.chargeId,'ch_12345');
});
test('exact three percent in micros with no invoice or payment created',()=>{
  const q=quote();
  assert.equal(q.eligible,true);
  assert.equal(q.mode,'DRY_RUN_ONLY');
  assert.equal(q.entry.amountMicros,6000000);
  assert.equal(q.entry.collectionStatus,'UNBILLED');
  assert.equal(q.collectionAuthorizedByThisFunction,false);
});
test('zero trust: signature and scoped processor retrieval required',()=>{
  assert.equal(obs({signatureVerified:false}).reason,'SOURCE_NOT_VERIFIED');
  assert.equal(obs({processorAccessVerified:false}).reason,'SOURCE_NOT_VERIFIED');
  assert.equal(obs({connection:{...connection,merchantId:'MER-0003',processorAccountId:'acct_other'}}).reason,'UNAUTHORIZED_OR_INACTIVE_CONNECTION');
});
test('event payload must match retrieved payment and charge facts',()=>{
  assert.equal(obs({retrievedIntent:{...retrievedIntent,amount_received:15000}}).reason,'PAYMENT_FACTS_MISMATCH');
  assert.equal(obs({retrievedCharge:{...retrievedCharge,amount_captured:15000}}).reason,'CHARGE_NOT_INDEPENDENTLY_CONFIRMED');
  assert.equal(obs({retrievedCharge:{...retrievedCharge,balance_transaction:null}}).reason,'BALANCE_TRANSACTION_PENDING');
});
test('legacy checkout or collected application fee never produces second usage fee',()=>{
  assert.equal(obs({retrievedIntent:{...retrievedIntent,metadata:{builtegrity_tx_id:'TX-0001'}}}).reason,'LEGACY_BUILTEGRITY_CHECKOUT');
  assert.equal(quote(obs(),agreement,true).reason,'APPLICATION_FEE_ALREADY_COLLECTED');
  assert.equal(previewStripeObservationFee({observation:obs(),agreement}).reason,'APPLICATION_FEE_EVIDENCE_REQUIRED');
});
test('inactive billing agreement, wrong merchant, or incorrect price fail closed',()=>{
  assert.equal(quote(obs(),{...agreement,status:'PENDING'}).reason,'NO_ACTIVE_ACCEPTED_PRICING_AGREEMENT');
  assert.equal(quote(obs(),{...agreement,merchantId:'MER-0003'}).reason,'MERCHANT_MISMATCH');
  assert.equal(quote(obs(),{...agreement,rateBps:200}).reason,'PRICING_NOT_EXPLICITLY_APPROVED');
  assert.equal(quote(obs(),{...agreement,billingAuthorized:false}).reason,'BILLING_NOT_AUTHORIZED');
});
test('signed agreement period prevents retroactive fees',()=>{
  assert.equal(quote(obs(),{...agreement,effectiveFrom:'2027-01-01T00:00:00.000Z'}).reason,'OUTSIDE_CONTRACTED_INTERVAL');
});
test('economic identity does not change on agreement rollover',()=>{
  const q1=quote(obs(),agreement);
  const q2=quote(obs(),{...agreement,version:'v2'});
  assert.equal(q1.economicKey,q2.economicKey);
  assert.notEqual(q1.entry.entryKey,q2.entry.entryKey); // DB must enforce independent economicKey uniqueness
});
