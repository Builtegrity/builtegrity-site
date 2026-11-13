import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateImpactCents, normalizeImpactPolicy } from '../worker/src/merchant-impact.js';

test('percent, flat and partial-refund calculations use integer cents', () => {
  assert.deepEqual(calculateImpactCents({originalCents:50000,refundedCents:0,mode:'BPS',value:25}),
    {eligible_amount_cents:50000,commitment_cents:125});
  assert.deepEqual(calculateImpactCents({originalCents:50000,refundedCents:20000,mode:'BPS',value:25}),
    {eligible_amount_cents:30000,commitment_cents:75});
  assert.deepEqual(calculateImpactCents({originalCents:50000,refundedCents:20000,mode:'FLAT_CENTS',value:50}),
    {eligible_amount_cents:30000,commitment_cents:30});
  assert.deepEqual(calculateImpactCents({originalCents:50000,refundedCents:50000,mode:'FLAT_CENTS',value:50}),
    {eligible_amount_cents:0,commitment_cents:0});
  assert.equal(calculateImpactCents({originalCents:50000,refundedCents:60000,mode:'BPS',value:25}).commitment_cents,0);
});

test('merchant policy must use explicit opt-in and bounded amounts', () => {
  assert.deepEqual(normalizeImpactPolicy({enabled:true,cause_code:'REFORESTATION',contribution_mode:'BPS',contribution_value:25}),{
    enabled:true,cause_code:'REFORESTATION',contribution_mode:'BPS',contribution_value:25,
  });
  for(const invalid of [
    {enabled:'true',cause_code:'REFORESTATION',contribution_mode:'BPS',contribution_value:25},
    {enabled:true,cause_code:'NOT_APPROVED',contribution_mode:'BPS',contribution_value:25},
    {enabled:true,cause_code:'REFORESTATION',contribution_mode:'BPS',contribution_value:1001},
    {enabled:true,cause_code:'REFORESTATION',contribution_mode:'FLAT_CENTS',contribution_value:0},
  ]) assert.throws(()=>normalizeImpactPolicy(invalid));
});
