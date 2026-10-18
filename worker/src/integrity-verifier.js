import { recomputeIntegrity, recordEvent } from './db.js';

// Oldest-first local record checks. Processor webhooks and recovery APIs provide external truth.
// Bounded batches avoid scanning or re-downloading payment records every two minutes.
export async function verifyIntegritySnapshotBatch(env,options={}) {
  if(!env.DB)throw Error('Missing D1 database');
  const limit=Math.min(Math.max(Number(options.limit)||250,1),500);
  const due=await env.DB.prepare(`
    SELECT t.id,t.integrity_status,t.exception_status
      FROM transactions t
      LEFT JOIN transaction_integrity_verifications v ON v.transaction_id=t.id
     WHERE v.verified_at IS NULL OR datetime(v.verified_at)<=datetime('now','-2 minutes')
     ORDER BY COALESCE(v.verified_at,'') ASC,t.id ASC LIMIT ?
  `).bind(limit).all();
  let checked=0,changed=0,failed=0;
  for(const tx of due.results||[]){
    try {
      const next=await recomputeIntegrity(env,tx.id);
      const differ=next.integrityStatus!==tx.integrity_status||next.exceptionStatus!==tx.exception_status;
      if(differ){
        await recordEvent(env,tx.id,'INTEGRITY_REVERIFIED','SYSTEM',null,{
          previous_integrity:tx.integrity_status,current_integrity:next.integrityStatus,
          previous_exception:tx.exception_status,current_exception:next.exceptionStatus,
          source:'LOCAL_CANONICAL_RECORD_NOT_PROCESSOR_POLL'});
        changed++;
      }
      await env.DB.prepare(`
        INSERT INTO transaction_integrity_verifications
          (transaction_id,verified_at,integrity_status,exception_status,checks,last_change_at,last_error)
        VALUES (?,CURRENT_TIMESTAMP,?,?,1,CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,NULL)
        ON CONFLICT(transaction_id) DO UPDATE SET
          verified_at=CURRENT_TIMESTAMP,integrity_status=excluded.integrity_status,
          exception_status=excluded.exception_status,checks=checks+1,last_error=NULL,
          last_change_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_change_at END
      `).bind(tx.id,next.integrityStatus,next.exceptionStatus,differ?1:0,differ?1:0).run();
      checked++;
    }catch(e){
      failed++;
      console.error('Integrity check failed for transaction',tx.id,String(e?.message||e));
      await env.DB.prepare(`
        INSERT INTO transaction_integrity_verifications
          (transaction_id,integrity_status,exception_status,last_error)
        VALUES(?,?,?,?)
        ON CONFLICT(transaction_id) DO UPDATE SET last_error=excluded.last_error
      `).bind(tx.id,tx.integrity_status,tx.exception_status,String(e?.message||e).slice(0,500)).run().catch(()=>{});
    }
  }
  return {checked,changed,failed,scope:'local canonical evidence',external_processor_poll:false};
}
