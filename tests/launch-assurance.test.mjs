import test from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCH_ASSURANCE_IDS, launchAssuranceBlockers, assertStripeEnvironment } from '../worker/src/launch-assurance.js';
import { stripeRequest, createTrackedCheckout } from '../worker/src/stripe.js';
import { exchangeStripeOAuthCode, deauthorizeStripeAccount } from '../worker/src/stripe-oauth.js';

const key = (mode, kind = 'sk') => [kind, mode, 'synthetic'].join('_');
const rows = () => LAUNCH_ASSURANCE_IDS.map(id => ({ id, status: 'SATISFIED', evidence_ref: 'private-evidence-reference', verified_at: new Date(Date.now()-60000).toISOString(), next_review_due_at: new Date(Date.now()+60000).toISOString() }));
const envFor = records => ({ DB: { prepare: () => ({ bind: () => ({ all: async () => ({results: records}) }) }) } });

test('all three current evidence records are required', async () => {
  assert.deepEqual(await launchAssuranceBlockers(envFor(rows())), []);
  assert.equal((await launchAssuranceBlockers(envFor(rows().slice(1)))).length, 1);
  assert.deepEqual(await launchAssuranceBlockers({}), ['LAUNCH_ASSURANCE_UNAVAILABLE']);
});

test('labels, missing evidence, invalid dates and expiry never clear launch', async () => {
  for (const change of [
    {status: 'OPEN'}, {status: 'NOT_APPLICABLE'}, {evidence_ref: ' '},
    {verified_at: null}, {verified_at: 'invalid'}, {verified_at: '2999-01-01'},
    {next_review_due_at: null}, {next_review_due_at: 'invalid'}, {next_review_due_at: '2000-01-01'},
  ]) {
    const records = rows(); Object.assign(records[0], change);
    assert.equal((await launchAssuranceBlockers(envFor(records))).length, 1, JSON.stringify(change));
  }
});

test('preview/test allow only test credentials including restricted keys', () => {
  for (const stage of [undefined, 'PREVIEW', 'TEST', ' test ']) {
    for (const kind of ['sk', 'rk']) {
      assert.doesNotThrow(() => assertStripeEnvironment({WATCHDOG_STAGE:stage, STRIPE_SECRET_KEY:key('test',kind)}));
      assert.throws(() => assertStripeEnvironment({WATCHDOG_STAGE:stage, STRIPE_SECRET_KEY:key('live',kind)}), {status:503});
    }
  }
  for (const stage of ['PILOT','LIVE',' live ']) {
    assert.doesNotThrow(() => assertStripeEnvironment({WATCHDOG_STAGE:stage, STRIPE_SECRET_KEY:key('live')}));
  }
  for (const secret of [undefined, '', 'malformed']) {
    assert.throws(() => assertStripeEnvironment({WATCHDOG_STAGE:'LIVE',STRIPE_SECRET_KEY:secret}), {status:503});
  }
  assert.throws(() => assertStripeEnvironment({WATCHDOG_STAGE:'LIV',STRIPE_SECRET_KEY:key('test')}), {status:503});
});

test('unsafe checkout, API and OAuth calls stop before network or DB access', async () => {
  const env = {WATCHDOG_STAGE:'PREVIEW',STRIPE_SECRET_KEY:key('live')};
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };
  try {
    for (const fn of [() => stripeRequest(env,'/v1/checkout/sessions',{method:'POST'}), () => createTrackedCheckout(env,{}), () => exchangeStripeOAuthCode(env,'code'), () => deauthorizeStripeAccount(env,'acct_synthetic')]) {
      await assert.rejects(fn, {status:503});
    }
    assert.equal(called,false);
  } finally { globalThis.fetch = original; }
});
