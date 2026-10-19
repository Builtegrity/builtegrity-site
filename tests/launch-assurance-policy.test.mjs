import test from 'node:test';import assert from 'node:assert/strict';
import {LAUNCH_ASSURANCE_IDS,launchAssuranceBlockers} from '../worker/src/launch-assurance.js';
const rows=()=>LAUNCH_ASSURANCE_IDS.map(id=>({id,status:'SATISFIED',evidence_ref:'private-file-id',verified_at:new Date(Date.now()-3600000).toISOString(),next_review_due_at:new Date(Date.now()+86400000).toISOString()}));
const env=items=>({DB:{prepare:()=>({bind:()=>({all:async()=>({results:items})})})}});
test('launch assurance fails closed on missing or expired evidence',async()=>{
 assert.deepEqual(await launchAssuranceBlockers(env(rows())),[]);
 assert.equal((await launchAssuranceBlockers(env(rows().slice(1)))).length,1);
 const r=rows();r[0].status='NOT_APPLICABLE';assert.equal((await launchAssuranceBlockers(env(r))).length,1);
 assert.deepEqual(await launchAssuranceBlockers({}),['LAUNCH_ASSURANCE_UNAVAILABLE']);
});
