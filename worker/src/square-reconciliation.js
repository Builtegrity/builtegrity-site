
import { squareApi } from './square-oauth.js';
import { applySquarePayoutSnapshot } from './square.js';

// Read-only processor reconciliation; no payment/refund creation or funds movement.
// Designed for the daily DEEP schedule and tightly bounded to control API cost.
export async function runSquarePayoutRecovery(env) {
  if(env.SQUARE_RECONCILIATION_ENABLED!=='true')return {enabled:false,merchants:0,examined:0};
  const rows=await env.DB.prepare(`
    SELECT c.merchant_id,c.external_account_id,c.location_id
    FROM merchant_processor_connections c
    WHERE c.processor='SQUARE' AND c.status='ACTIVE'
      AND c.location_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.merchant_id=c.merchant_id AND t.processor='SQUARE'
          AND t.payment_at IS NOT NULL AND t.payout_accounted=0
      )
    ORDER BY c.updated_at ASC LIMIT 5
  `).all();
  let examined=0,errors=0,processed=0;
  for(const connection of rows.results||[]){
    try {
      const since=new Date(Date.now()-90*86400000).toISOString();
      let cursor=null;let pages=0;
      do {
        const params=new URLSearchParams({
          location_id:connection.location_id,status:'PAID',
          sort_order:'DESC',begin_time:since,limit:'20'
        });
        if(cursor)params.set('cursor',cursor);
        const data=await squareApi(env,connection.merchant_id,'/v2/payouts?'+params);
        for(const payout of data.payouts||[]){
          if(payout.status!=='PAID'||payout.location_id!==connection.location_id)continue;
          examined++;
          await applySquarePayoutSnapshot(env,connection.external_account_id,payout);
          processed++;
        }
        cursor=data.cursor||null;
        pages++;
      }while(cursor&&pages<3);
      if(cursor)console.warn('Square payout recovery scan capped for merchant',connection.merchant_id);
    }catch(err){
      errors++;
      console.error('Square payout recovery failed for merchant',connection.merchant_id,String(err?.message||err));
    }
  }
  return {enabled:true,merchants:(rows.results||[]).length,examined,processed,errors};
}
