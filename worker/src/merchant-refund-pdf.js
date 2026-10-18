import {buildRefundPdf} from './pdf.js';
import {authenticateClerkSession} from './clerk-auth.js';
import {requireMerchantMembership} from './authorization.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,
 headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
function safeRef(s){return typeof s==='string'&&s.length<=160&&/^[A-Za-z0-9_\-:.]+$/.test(s);}
export async function loadMerchantRefundEvidence(env,refundId){
 if(!safeRef(refundId))return null;
 const stripe=await env.DB.prepare(`
  SELECT a.id AS refund_id,a.transaction_id,a.merchant_id,'STRIPE' AS processor,
   'COMPLETED' AS status,a.amount_cents,a.currency,a.adjustment_at AS occurred_at,
   COALESCE(a.processor_object_id,a.processor_event_id) AS processor_ref,
   a.processor_event_id,a.processor_object_id,
   a.direction,a.details_json,
   m.name AS merchant_name
  FROM transaction_financial_adjustments a JOIN merchants m ON m.id=a.merchant_id
  WHERE a.id=? AND a.processor='STRIPE' AND a.adjustment_type='REFUND'
  LIMIT 1`).bind(refundId).first();
 if(stripe)return stripe;
 return env.DB.prepare(`
  SELECT f.refund_id,f.transaction_id,t.merchant_id,'SQUARE' AS processor,
    f.status,f.amount_cents,f.currency,f.updated_at AS occurred_at,
    f.observed_at,f.app_fee_refunded_cents,f.processor_payment_id,
    f.refund_id AS processor_ref,m.name AS merchant_name
  FROM square_refund_facts f JOIN transactions t ON t.id=f.transaction_id
   AND t.processor='SQUARE' JOIN merchants m ON m.id=t.merchant_id
  WHERE f.refund_id=? LIMIT 1`).bind(refundId).first();
}
export async function handleMerchantRefundPdf(request,env){
 const path=new URL(request.url).pathname;
 const match=path.match(/^\/api\/merchant\/refunds\/([A-Za-z0-9_.:-]+)\/pdf$/);
 if(!match)return null;
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 const principal=await authenticateClerkSession(request,env);
 if(!principal?.sub||principal.claims?.act)return json({
  error:'Create or sign in to your merchant profile before downloading or sharing refund PDFs.'},401);
 const refund=await loadMerchantRefundEvidence(env,match[1]);
 if(!refund)return json({error:'Refund evidence not found'},404);
 await requireMerchantMembership(env,principal,refund.merchant_id,'VIEWER');
 const transaction=await env.DB.prepare(`
  SELECT t.id,t.description,t.amount_cents,t.currency,t.merchant_payment_reference,
    t.payment_at,t.integrity_status,t.processor_payout_status,t.refunded_cents,
    t.application_fee_refunded_cents,t.processor,
    c.name AS customer_name,p.merchant_reference,
    m.name AS merchant_name FROM transactions t
  JOIN merchants m ON m.id=t.merchant_id
  JOIN customers c ON c.id=t.customer_id AND c.merchant_id=t.merchant_id
  JOIN purchases p ON p.id=t.purchase_id
  WHERE t.id=? AND t.merchant_id=? LIMIT 1`).bind(refund.transaction_id,refund.merchant_id).first();
 if(!transaction)return json({error:'Original transaction unavailable'},404);
 const bytes=buildRefundPdf(refund,transaction);
 await env.DB.prepare(`INSERT INTO merchant_pdf_access_events
    (id,merchant_id,transaction_id,refund_id,event_type,actor_id)
    VALUES(?,?,?,?,?,?)`).bind('PAE-'+crypto.randomUUID(),refund.merchant_id,
       refund.transaction_id,refund.refund_id,'REFUND_PDF',principal.sub).run();
 const url=new URL(request.url),view=url.searchParams.get('view')==='1';
 const filename='Builtegrity-refund-'+String(refund.refund_id).replace(/[^A-Za-z0-9._-]/g,'-')+'.pdf';
 return new Response(bytes,{status:200,headers:{
  'content-type':'application/pdf',
  'content-disposition':(view?'inline':'attachment')+'; filename="'+filename+'"',
  'cache-control':'private, no-store','referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff','x-frame-options':'SAMEORIGIN',
  'content-security-policy':"default-src 'none'; sandbox"
 }});
}
