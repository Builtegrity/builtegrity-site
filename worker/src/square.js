
import { squareApi, squareConnection, squareBase } from './square-oauth.js';
import { assertMerchantLegalReadyForLiveAction } from './legal-enforcement.js';
import { assertCustomerStateReady } from './stripe.js';
import { lockTransactionFeeRefundRule,assertTransactionFeeRefundRuleLocked } from './fee-refund-compliance.js';
import { reserveAvailableFeeCarry } from './pricing.js';
import { advanceLifecycle, recordEvent, recomputeIntegrity, openException } from './db.js';

export async function createSquareCheckout(env,tx) {
  if(env.SQUARE_PAYMENT_LINKS_ENABLED!=='true') throw statusError('Square checkout is disabled until integration tests and approvals pass',503);
  if(String(env.SQUARE_ENV||'sandbox').toLowerCase()==='production'&&env.SQUARE_LIVE_ENABLED!=='true')
    throw statusError('Square live transactions are not authorized',503);
  if(tx.processor!=='SQUARE')throw statusError('Square checkout requires a Square transaction',400);
  await assertMerchantLegalReadyForLiveAction(env,tx.merchant_id,'Square checkout creation');
  await assertCustomerStateReady(env,tx.customer_attested_state_code);
  const connection=await squareConnection(env,tx.merchant_id);
  if(!connection.location_id)throw statusError('Square merchant location is not selected',409);
  if(String(env.SQUARE_ENV||'sandbox').toLowerCase()==='production'&&connection.status!=='ACTIVE')
    throw statusError('Square merchant has not passed connection verification',409);
  const locked=await lockTransactionFeeRefundRule(env,tx.id);
  assertTransactionFeeRefundRuleLocked(locked);
  if(locked.processor!=='SQUARE'||!locked.payment_access_token||Number(locked.consent_accepted)!==1)
    throw statusError('Square transaction consent and payment token are required',409);
  if(String(locked.currency).toUpperCase()!=='USD')throw statusError('Square V1 accepts USD only',409);

  const reserved=await reserveAvailableFeeCarry(env,locked.id);
  const effective={...locked,...(reserved||{})};
  const fee=Number(effective.integrity_fee_earned_cents||0)+Number(effective.pricing_carry_reserved_cents||0);
  const amount=Number(effective.amount_cents||0);
  if(!Number.isSafeInteger(fee)||fee<=0||fee>Math.floor(amount*0.5))
    throw statusError('Square fee amount failed merchant safety limits',409);
  const returnUrl=String(env.APP_BASE_URL||'').replace(/\/$/,'')+'/pay/success/?token='+encodeURIComponent(effective.payment_access_token);
  const payload=await squareApi(env,tx.merchant_id,'/v2/online-checkout/payment-links',{
    method:'POST',
    body:{
      idempotency_key:'builtegrity-'+effective.id+'-square-checkout-v1',
      quick_pay:{name:String(effective.description).slice(0,120),price_money:{amount,currency:'USD'},location_id:connection.location_id},
      checkout_options:{app_fee_money:{amount:fee,currency:'USD'},redirect_url:returnUrl,allow_tipping:false},
      payment_note:'Builtegrity '+effective.id
    }
  });
  const link=payload.payment_link;
  if(!link?.id||!link?.order_id||!link?.url)throw statusError('Square did not return the required checkout identifiers',502);
  return {id:link.id,url:link.url,order_id:link.order_id,app_fee_cents:fee,payment_status:'PENDING'};
}

export async function verifySquareWebhook(rawBody,signature,signatureKey,notificationUrl) {
  if(!signature||!signatureKey||!notificationUrl)return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(signatureKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const computed=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(notificationUrl+rawBody)));
  const expected=btoa(String.fromCharCode(...computed));
  // Constant-work comparison to avoid signature oracle through early exit.
  let mismatch=expected.length^signature.length;
  for(let i=0;i<Math.max(expected.length,signature.length);i++)
    mismatch|=(expected.charCodeAt(i)||0)^(signature.charCodeAt(i)||0);
  return mismatch===0;
}

export async function processSquareWebhook(env,event) {
  if(!event?.event_id||!event?.type||!event?.merchant_id)throw statusError('Invalid Square webhook envelope',400);
  await env.DB.prepare(`
   INSERT OR IGNORE INTO processor_webhook_deliveries
    (processor,event_id,event_type,attempt_count) VALUES ('SQUARE',?,?,0)
  `).bind(event.event_id,event.type).run();
  const receipt=await env.DB.prepare(`
    SELECT processed_at FROM processor_webhook_deliveries WHERE processor='SQUARE' AND event_id=?
  `).bind(event.event_id).first();
  if(receipt?.processed_at)return {duplicate:true};
  await env.DB.prepare(`
    UPDATE processor_webhook_deliveries SET attempt_count=attempt_count+1
    WHERE processor='SQUARE' AND event_id=?
  `).bind(event.event_id).run();
  try {
    let outcome='ignored';
    if(['payment.created','payment.updated'].includes(event.type))outcome=await projectSquarePayment(env,event);
    if(['payout.paid','payout.sent','payout.failed'].includes(event.type))outcome=await projectSquarePayout(env,event);
    if(['refund.created','refund.updated'].includes(event.type))outcome=await projectSquareRefund(env,event);
    await env.DB.prepare(`
      UPDATE processor_webhook_deliveries SET processed_at=CURRENT_TIMESTAMP,last_error=NULL
      WHERE processor='SQUARE' AND event_id=?
    `).bind(event.event_id).run();
    return {processed:true,outcome};
  }catch(error){
    await env.DB.prepare(`
      UPDATE processor_webhook_deliveries SET last_error=?
      WHERE processor='SQUARE' AND event_id=?
    `).bind(String(error.message||error).slice(0,500),event.event_id).run();
    throw error;
  }
}

async function findSquareTransaction(env,merchantProviderId,paymentId,orderId) {
  if(!paymentId&&!orderId)return null;
  return env.DB.prepare(`
    SELECT t.* FROM transactions t
    JOIN merchant_processor_connections c ON c.merchant_id=t.merchant_id
     AND c.processor='SQUARE' AND c.external_account_id=?
    WHERE t.processor='SQUARE'
      AND ((? IS NOT NULL AND t.processor_payment_id=?)
        OR (? IS NOT NULL AND t.processor_order_id=?))
    LIMIT 1
  `).bind(merchantProviderId,paymentId||null,paymentId||null,orderId||null,orderId||null).first();
}
async function projectSquarePayment(env,event) {
  const obj=event.data?.object;
  const received=obj?.payment||obj;
  const paymentId=received?.id||event.data?.id;
  if(!paymentId)return 'missing_payment';
  // Fetch processor truth, not only the possibly partial event payload.
  const owner=await env.DB.prepare(`
   SELECT merchant_id FROM merchant_processor_connections
   WHERE processor='SQUARE' AND external_account_id=? AND status IN ('TEST','ACTIVE')
  `).bind(event.merchant_id).first();
  if(!owner)return 'unconnected_merchant';
  const reply=await squareApi(env,owner.merchant_id,'/v2/payments/'+encodeURIComponent(paymentId));
  const p=reply.payment;
  if(!p)return 'payment_unavailable';
  const tx=await findSquareTransaction(env,event.merchant_id,p.id,p.order_id);
  if(!tx)return 'unmanaged_payment';
  const status=String(p.status||'UNKNOWN').toUpperCase();
  const total=Number(p.amount_money?.amount);
  const currency=String(p.amount_money?.currency||'').toUpperCase();
  if(total!==Number(tx.amount_cents)||currency!==String(tx.currency).toUpperCase()){
    await openException(env,tx.id,'SQUARE_PAYMENT_MISMATCH','Square amount/currency does not match the authorized Builtegrity transaction');
    return 'amount_mismatch';
  }
  const confirmed=Number(p.app_fee_money?.amount||0);
  if(status==='COMPLETED'){
    await env.DB.prepare(`
      UPDATE transactions SET processor_payment_id=COALESCE(processor_payment_id,?),
       payment_status='COMPLETED',payment_at=COALESCE(payment_at,?),
       customer_paid_cents=?,processor_app_fee_confirmed_cents=?,
       integrity_fee_collected_cents=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND processor='SQUARE'
    `).bind(p.id,p.created_at||new Date().toISOString(),total,confirmed,confirmed,tx.id).run();
    await advanceLifecycle(env,tx.id,'PAID');
    if(confirmed!==Number(tx.processor_app_fee_requested_cents)){
      await openException(env,tx.id,'SQUARE_FEE_MISMATCH','Square application fee does not match the locked checkout amount');
    }
    await recordEvent(env,tx.id,'PAYMENT_SUCCEEDED','SYSTEM','SQUARE:'+event.event_id,{
      processor:'SQUARE',payment_id:p.id,app_fee_reported_cents:confirmed
    },event.created_at||null);
  }else if(['FAILED','CANCELED'].includes(status)){
    await env.DB.prepare(`UPDATE transactions SET payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(status,tx.id).run();
    await recordEvent(env,tx.id,'PAYMENT_FAILED','SYSTEM','SQUARE:'+event.event_id,{processor:'SQUARE',status});
    await openException(env,tx.id,'PAYMENT_FAILED','Square reported a failed or cancelled payment');
  }
  if(Number(p.refunded_money?.amount||0)>0)await openException(env,tx.id,'SQUARE_REFUND_RECONCILIATION','Square refund requires application-fee refund reconciliation');
  await recomputeIntegrity(env,tx.id);
  return tx.id;
}
async function projectSquarePayout(env,event) {
  const payout=event.data?.object?.payout||event.data?.object;
  const payoutId=payout?.id||event.data?.id;
  if(!payoutId)return 'missing_payout';
  const owner=await env.DB.prepare(`
    SELECT merchant_id FROM merchant_processor_connections
    WHERE processor='SQUARE' AND external_account_id=? AND status IN ('TEST','ACTIVE')
  `).bind(event.merchant_id).first();
  if(!owner)return 'unconnected_merchant';
  if(event.type==='payout.sent')return 'payout_sent_pending';
  if(event.type==='payout.failed'){
    const known=await env.DB.prepare(`SELECT id FROM transactions WHERE processor='SQUARE' AND processor_payout_id=?`).bind(payoutId).all();
    for(const item of known.results||[]){
      await env.DB.prepare(`UPDATE transactions SET processor_payout_status='failed',payout_accounted=0 WHERE id=?`).bind(item.id).run();
      await openException(env,item.id,'PAYOUT_FAILED','Square reports a failed payout');
    }
    return 'payout_failed';
  }
  // Payout is not accounted for unless its individual payment IDs can be confirmed
  // from the complete (paginated) settlement-entry listing.
  let cursor=null;const entries=[];let pages=0;
  do {
    const query=new URLSearchParams({limit:'100'});
    if(cursor)query.set('cursor',cursor);
    const data=await squareApi(env,owner.merchant_id,'/v2/payouts/'+encodeURIComponent(payoutId)+'/payout-entries?'+query);
    entries.push(...(data.payout_entries||[])); cursor=data.cursor||null;
    pages++;
    if(pages>100)throw statusError('Square payout entry pagination safety limit exceeded',502);
  }while(cursor);
  let matched=0;
  for(const entry of entries){
    if(entry.type!=='CHARGE')continue;
    const paymentId=entry.type_charge_details?.payment_id;
    if(!paymentId)continue;
    const tx=await findSquareTransaction(env,event.merchant_id,paymentId,null);
    if(!tx||!tx.payment_at)continue;
    await env.DB.prepare(`
      UPDATE transactions SET processor_payout_id=?,processor_payout_status='paid',
        payout_accounted=1,transaction_payout_contribution_cents=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=? AND processor='SQUARE'
    `).bind(payoutId,Number.isInteger(entry.net_amount_money?.amount)?entry.net_amount_money.amount:null,tx.id).run();
    await advanceLifecycle(env,tx.id,'COMPLETE');
    await recordEvent(env,tx.id,'PAYOUT_PAID','SYSTEM','SQUARE:'+event.event_id+':'+tx.id,{
      processor:'SQUARE',payout_id:payoutId,entry_id:entry.id
    });
    await recomputeIntegrity(env,tx.id);matched++;
  }
  return 'payout_entries_matched:'+matched;
}
async function projectSquareRefund(env,event) {
  const obj=event.data?.object?.refund||event.data?.object;
  const id=obj?.payment_id;
  if(!id)return 'refund_unmatched';
  const tx=await findSquareTransaction(env,event.merchant_id,id,null);
  if(!tx)return 'unmanaged_refund';
  await recordEvent(env,tx.id,'REFUND_OBSERVED','SYSTEM','SQUARE:'+event.event_id,{processor:'SQUARE',refund_id:obj?.id||null});
  await openException(env,tx.id,'SQUARE_REFUND_RECONCILIATION','Square refund requires application-fee refund reconciliation');
  return tx.id;
}
function statusError(message,status=409){const e=new Error(message);e.status=status;return e;}
