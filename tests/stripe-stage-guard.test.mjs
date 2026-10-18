import test from 'node:test';
import assert from 'node:assert/strict';
import {assertStripeStageCredential} from '../worker/src/stripe-stage-guard.js';
const env=(stage,key)=>({WATCHDOG_STAGE:stage,STRIPE_SECRET_KEY:key});
test('preview and test reject live Stripe credentials',()=>{
 for(const stage of ['PREVIEW','TEST',' test ']){
  for(const prefix of ['sk','rk']){
   assert.throws(()=>assertStripeStageCredential(env(stage,prefix+'_live_example')), {status:503});
   assert.doesNotThrow(()=>assertStripeStageCredential(env(stage,prefix+'_test_example')));
  }
 }
});
test('invalid and missing credential configurations fail closed',()=>{
 for(const key of ['',undefined,'malformed']){
  assert.throws(()=>assertStripeStageCredential(env('LIVE',key)),{status:503});
 }
 assert.throws(()=>assertStripeStageCredential(env('LIV','sk_test_example')),{status:503});
});
test('valid pilot and live stages accept recognizable Stripe keys',()=>{
 for(const stage of ['PILOT','LIVE'])for(const mode of ['test','live'])
  assert.doesNotThrow(()=>assertStripeStageCredential(env(stage,'sk_'+mode+'_example')));
});
