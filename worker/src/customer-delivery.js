import {authenticateClerkSession} from './clerk-auth.js';
import {requireMerchantMembership} from './authorization.js';
import {buildCustomerDeliveryDecision,renderTransactionEmail} from '../../transaction-engine/merchant-themed-delivery.mjs';

const response=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const bool=x=>x===true?1:0;
export async function handleCustomerDeliveryPreferences(request,env){
 const url=new URL(request.url);
 if(url.pathname!=='/api/merchant/customer-delivery')return null;
 if(!['GET','PUT'].includes(request.method))return response({error:'Method not allowed'},405);
 if(request.method==='PUT'){
   const origin=request.headers.get('origin');
   if(origin&&origin!==url.origin)return response({error:'Cross-origin update denied'},403);
   const site=request.headers.get('sec-fetch-site');
   if(site&&site!=='same-origin'&&site!=='none')return response({error:'Cross-site update denied'},403);
 }
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub||principal.claims?.act)return response({error:'Sign-in required'},401);
 let body={};
 if(request.method==='PUT'){
   if(Number(request.headers.get('content-length')||0)>2048)return response({error:'Request too large'},413);
   const raw=await request.text();
   if(new TextEncoder().encode(raw).byteLength>2048)return response({error:'Request too large'},413);
   try{body=JSON.parse(raw);}catch{return response({error:'Invalid JSON'},400);}
 }
 const merchantId=request.method==='GET'?url.searchParams.get('merchant_id'):body.merchant_id;
 if(!/^MER-[A-Za-z0-9-]+$/.test(String(merchantId||'')))return response({error:'Invalid merchant'},400);
 await requireMerchantMembership(env,principal,merchantId,request.method==='PUT'?'ADMIN':'VIEWER');
 if(request.method==='PUT'){
   for(const k of ['pdf_theme_opt_in','customer_email_opt_in','email_theme_opt_in']){
     if(typeof body[k]!=='boolean')return response({error:k+' must be boolean'},400);
   }
   // Builtegrity confirmation supplements the processor receipt. PRIMARY is
   // reserved until verified suppression/replacement of processor receipts exists.
   await env.DB.prepare(`INSERT INTO merchant_transaction_delivery_preferences
      (merchant_id,pdf_theme_opt_in,customer_email_opt_in,email_theme_opt_in,receipt_mode,updated_at)
      VALUES(?,?,?,?,'SUPPLEMENT',CURRENT_TIMESTAMP)
      ON CONFLICT(merchant_id) DO UPDATE SET
      pdf_theme_opt_in=excluded.pdf_theme_opt_in,
      customer_email_opt_in=excluded.customer_email_opt_in,
      email_theme_opt_in=excluded.email_theme_opt_in,updated_at=CURRENT_TIMESTAMP`)
      .bind(merchantId,bool(body.pdf_theme_opt_in),bool(body.customer_email_opt_in),
         bool(body.email_theme_opt_in)).run();
 }
 const p=await env.DB.prepare('SELECT * FROM merchant_transaction_delivery_preferences WHERE merchant_id=?')
   .bind(merchantId).first();
 return response({merchant_id:merchantId,pdf_theme_opt_in:Boolean(p?.pdf_theme_opt_in),
  customer_email_opt_in:Boolean(p?.customer_email_opt_in),
  email_theme_opt_in:Boolean(p?.email_theme_opt_in),receipt_mode:'SUPPLEMENT'});
}

/**
 * Reconcile only actual, processor-confirmed payments. Never send based solely
 * on checkout creation, pending status, or developer simulations.
 */
export async function enqueueCustomerTransactionConfirmation(env,txId){
 const row=await env.DB.prepare(`SELECT t.id,t.merchant_id,t.amount_cents,t.currency,t.payment_status,
   t.payment_at,t.processor,c.email,m.name,p.customer_email_opt_in
   FROM transactions t JOIN customers c ON c.id=t.customer_id AND c.merchant_id=t.merchant_id
   JOIN merchants m ON m.id=t.merchant_id
   JOIN merchant_transaction_delivery_preferences p ON p.merchant_id=t.merchant_id
   WHERE t.id=?`).bind(txId).first();
 if(!row||!row.customer_email_opt_in||!row.payment_at||
     !['PAID','SUCCEEDED'].includes(String(row.payment_status).toUpperCase()))return {queued:false};
 const decision=buildCustomerDeliveryDecision({preferences:{customerTransactionEmailEnabled:true},
   transaction:{id:txId,status:'succeeded'},customer:{email:row.email}});
 if(!decision.send)return {queued:false};
 const inserted=await env.DB.prepare(`INSERT OR IGNORE INTO customer_transaction_email_deliveries
   (merchant_id,transaction_id,event_kind,event_reference,recipient_email)
   VALUES(?,?,'PAYMENT_SUCCEEDED',?,?)`)
   .bind(row.merchant_id,txId,txId,row.email).run();
 return {queued:Number(inserted.meta?.changes||0)>0};
}

/** At-least-once delivery with DB-level deduplication and fixed provider key. */
export async function dispatchCustomerTransactionEmails(env,{limit=8}={}){
 if(env.CUSTOMER_TRANSACTION_EMAILS_ENABLED!=='true'||!env.RESEND_API_KEY||
   !env.CUSTOMER_TRANSACTION_EMAIL_FROM)return {enabled:false,sent:0};
 const pending=await env.DB.prepare(`SELECT d.id,d.transaction_id,d.merchant_id,d.recipient_email,
  d.event_kind,d.event_reference,p.email_theme_opt_in,p.customer_email_opt_in,
  COALESCE(a.template,'builtegrity') AS theme,m.name,t.payment_status,t.payment_at,
  t.amount_cents,t.currency,t.created_at
  FROM customer_transaction_email_deliveries d
  JOIN merchant_transaction_delivery_preferences p ON p.merchant_id=d.merchant_id
  JOIN merchants m ON m.id=d.merchant_id
  JOIN transactions t ON t.id=d.transaction_id AND t.merchant_id=d.merchant_id
  LEFT JOIN merchant_dashboard_appearance a ON a.merchant_id=d.merchant_id
  WHERE d.state IN ('PENDING','RETRY') AND d.attempts<4 AND p.customer_email_opt_in=1
    AND (d.next_attempt_at IS NULL OR datetime(d.next_attempt_at)<=CURRENT_TIMESTAMP)
  ORDER BY d.created_at LIMIT ?`).bind(Math.max(1,Math.min(8,limit))).all();
 let sent=0,failed=0;
 for(const d of pending.results||[]){
  const claim=await env.DB.prepare(`UPDATE customer_transaction_email_deliveries
    SET state='CLAIMED',attempts=attempts+1,claimed_at=CURRENT_TIMESTAMP
    WHERE id=? AND state IN('PENDING','RETRY') AND attempts<4
    RETURNING id`).bind(d.id).first();
  if(!claim)continue;
  try{
   if(!d.payment_at||!['PAID','SUCCEEDED'].includes(String(d.payment_status).toUpperCase()))
     throw new Error('Processor payment confirmation missing');
   const amount=(Number(d.amount_cents)/100).toFixed(2)+' '+String(d.currency||'USD');
   const mail=renderTransactionEmail({preferences:{theme:d.theme,
     customerTransactionEmailEnabled:true,themeEmailEnabled:Boolean(d.email_theme_opt_in)},
     merchant:{name:d.name},transaction:{id:d.transaction_id,status:'succeeded',
       reference:d.transaction_id,formattedAmount:amount,formattedDate:d.payment_at},
       customer:{email:d.recipient_email}});
   if(!mail)throw new Error('Recipient is not eligible');
   const res=await fetch('https://api.resend.com/emails',{method:'POST',
     headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json',
       'Idempotency-Key':'customer-transaction-'+d.id},
     body:JSON.stringify({from:env.CUSTOMER_TRANSACTION_EMAIL_FROM,to:[mail.to],
       subject:mail.subject,html:mail.html,text:mail.text})});
   if(!res.ok)throw new Error('Resend HTTP '+res.status);
   const result=await res.json();
   await env.DB.prepare(`UPDATE customer_transaction_email_deliveries
      SET state='SENT',provider_message_id=?,sent_at=CURRENT_TIMESTAMP,last_error=NULL
      WHERE id=? AND state='CLAIMED'`).bind(String(result.id||''),d.id).run();sent++;
  }catch(e){
   await env.DB.prepare(`UPDATE customer_transaction_email_deliveries SET
      state=CASE WHEN attempts>=4 THEN 'FAILED' ELSE 'RETRY' END,
      next_attempt_at=datetime('now','+30 minutes'),last_error=?
      WHERE id=? AND state='CLAIMED'`).bind(String(e.message||e).slice(0,250),d.id).run();failed++;
  }
 }
 return {enabled:true,sent,failed};
}
