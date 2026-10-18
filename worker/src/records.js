import {handleMerchantEmailAccess} from './merchant-record-access.js';
import { handleMerchantBankRoute } from './bank-routes.js';
import { payoutBankEvidence } from './bank-evidence.js';
import { getTransaction } from './db.js';
import { merchantFieldContext } from './merchant-custom-data.js';
import { handleMerchantCustomRoute } from './merchant-custom-routes.js';
import { handleMerchantHelpRoute } from './merchant-help.js';
import { getTransactionGraph } from './transaction-intelligence.js';
import { serveTransactionPdf } from './pdf.js';
import { authenticateClerkSession } from './clerk-auth.js';
import { requireMerchantMembership } from './authorization.js';
import { handleResendStatementWebhook } from './resend-statement-webhooks.js';
import { handleMerchantComplianceRoute } from './merchant-compliance-routes.js';
import { handleLegalInboxWebhook } from './legal-inbox.js';
import { handleLegalProviderWebhook } from './legal-provider-webhooks.js';

export async function handlePublicRecordRoute(request, env, ctx) {
  // This gateway runs before the owner/admin API gate. Legal/provider webhooks are public only in
  // the network sense: each has its own cryptographic signature/secret boundary. Email/provider
  // content remains untrusted evidence and can never inherit operator privileges.
  const url = new URL(request.url);
  const helpResponse=await handleMerchantHelpRoute(request,env);
  if(helpResponse)return helpResponse;
  const customResponse=await handleMerchantCustomRoute(request,env);
  if(customResponse)return customResponse;
  const bankResponse=await handleMerchantBankRoute(request,env,ctx);
  if(bankResponse)return bankResponse;
  if (url.pathname === '/api/webhooks/legal-inbox' && request.method === 'POST') {
    return handleLegalInboxWebhook(request, env);
  }
  const legalProviderMatch = url.pathname.match(/^\/api\/webhooks\/legal-provider\/([A-Za-z0-9_-]+)$/);
  if (legalProviderMatch && request.method === 'POST') {
    return handleLegalProviderWebhook(request, env, legalProviderMatch[1]);
  }

  const merchantComplianceResponse = await handleMerchantComplianceRoute(request, env);
  if (merchantComplianceResponse) return merchantComplianceResponse;

  const resendWebhookResponse = await handleResendStatementWebhook(request, env);
  if (resendWebhookResponse) return resendWebhookResponse;

  // Merchant refund history is a separate history projection; no refund is initiated here.
  // Stripe keeps append-only successful refund deltas. Square keeps provider refund IDs and
  // their latest verified status, including pending and failed refunds.
  if (url.pathname === '/api/merchant/refunds' && request.method === 'GET') {
    const principal = await authenticateClerkSession(request,env);
    if (!principal?.sub) return json({error:'Merchant sign-in required'},401);
    const result=await env.DB.prepare(`
      SELECT refund_id, transaction_id, merchant_id,merchant_name,processor,
             amount_cents,currency,status,occurred_at,processor_ref,app_fee_refunded_cents
      FROM (
        SELECT a.id AS refund_id,a.transaction_id,a.merchant_id,m.name AS merchant_name,
               'STRIPE' AS processor,a.amount_cents,a.currency,'COMPLETED' AS status,
               a.adjustment_at AS occurred_at,
               COALESCE(a.processor_event_id,a.processor_object_id) AS processor_ref,
               NULL AS app_fee_refunded_cents
        FROM transaction_financial_adjustments a
        JOIN merchants m ON m.id=a.merchant_id
        WHERE a.processor='STRIPE' AND a.adjustment_type='REFUND'
          AND EXISTS (
            SELECT 1 FROM merchant_access access
            WHERE access.merchant_id=a.merchant_id
              AND access.external_user_id=? AND access.status='ACTIVE')
        UNION ALL
        SELECT f.refund_id AS refund_id,f.transaction_id,t.merchant_id,m.name AS merchant_name,
               'SQUARE' AS processor,f.amount_cents,f.currency,f.status,
               f.updated_at AS occurred_at,f.refund_id AS processor_ref,
               f.app_fee_refunded_cents
        FROM square_refund_facts f
        JOIN transactions t ON t.id=f.transaction_id AND t.processor='SQUARE'
        JOIN merchants m ON m.id=t.merchant_id
        WHERE EXISTS (
          SELECT 1 FROM merchant_access access
          WHERE access.merchant_id=t.merchant_id
            AND access.external_user_id=? AND access.status='ACTIVE')
      )
      ORDER BY occurred_at DESC,refund_id DESC LIMIT 100
    `).bind(principal.sub,principal.sub).all();
    return json({refunds:result.results||[],limit:100,read_only:true});
  }

  const timelineMatch=url.pathname.match(/^\/api\/merchant\/transactions\/(TX-[A-Za-z0-9-]+)\/journey$/);
  if(timelineMatch&&request.method==='GET'){
    const principal=await authenticateClerkSession(request,env);
    if(!principal?.sub)return json({error:'Sign in required'},401);
    const tx=await getTransaction(env,timelineMatch[1]);
    if(!tx)return json({error:'Transaction not found'},404);
    await requireMerchantMembership(env,principal,tx.merchant_id,'VIEWER');
    const [bank,customFields,deliveries]=await Promise.all([
      payoutBankEvidence(env,tx),merchantFieldContext(env,tx.merchant_id,tx.customer_id,tx.id),
      transactionEventDeliveries(env,tx.id)]);
    // Confidential internal details are not exposed; the full PDF remains authorized.
    const milestones={
      created_at:tx.created_at,consent_at:tx.consent_accepted_at,
      checkout_at:tx.stripe_checkout_session_id||tx.processor_checkout_id?
        tx.checkout_legal_gate_at:null,
      payment_at:tx.payment_at,
      fee_verified_at:tx.protection_confirmed_at,
      payout_expected_at:tx.expected_payout_arrival,
      payout_reported_at:tx.processor_payout_status?.toLowerCase()==='paid'
        ?tx.last_reconciled_at:null,
      integrity_verified_at:tx.integrity_verified_at
    };
    return json({transaction:{
      id:tx.id,merchant_name:tx.merchant_name,customer_name:tx.customer_name,
      merchant_reference:tx.merchant_reference,
      merchant_payment_reference:tx.merchant_payment_reference,
      customer_reference:tx.merchant_customer_reference||tx.customer_id,
      processor:tx.processor,amount_cents:tx.amount_cents,currency:tx.currency,
      lifecycle_status:tx.lifecycle_status,integrity_status:tx.integrity_status,
      exception_status:tx.exception_status,record_classification:tx.record_classification,
      processor_payout_status:tx.processor_payout_status,
      payout_id:tx.processor==='SQUARE'?tx.processor_payout_id:tx.stripe_payout_id,
      external_reference:tx.merchant_reference,
      ...milestones,
      // Intentionally omit bank fields entirely for unlinked or revoked accounts.
      ...(bank?{bank_evidence:bank}:{})
    },custom_fields:customFields,deliveries,events:(tx.events||[]).map(e=>({
      id:e.id,type:e.event_type,occurred_at:e.event_at,source:e.source
    })),exceptions:(tx.exceptions||[]).map(e=>({
      id:e.id,type:e.exception_type,status:e.status,summary:e.summary
    }))});
  }
  const merchantPdf = url.pathname.match(/^\/api\/merchant\/transactions\/(TX-[A-Za-z0-9-]+)\/pdf$/);
  const merchantList = url.pathname === '/api/merchant/transactions';
  if((merchantPdf||merchantList)&&request.method==='GET'){
    const principal=await authenticateClerkSession(request,env);
    if(!principal?.sub)return json({error:'Merchant sign-in required'},401);
    if(merchantPdf){
      const full=await getTransaction(env,merchantPdf[1]);
      if(!full)return json({error:'Transaction not found'},404);
      await requireMerchantMembership(env,principal,full.merchant_id,'VIEWER');
      return serveTransactionPdf(env,await fullMerchantPdfEvidence(env,full),
        {type:'MERCHANT',ref:principal.sub,view:url.searchParams.get('view')==='1'});
    }
    const result=await env.DB.prepare(`
      SELECT t.id,t.merchant_id,t.processor,t.amount_cents,t.currency,
        t.lifecycle_status,t.integrity_status,t.exception_status,t.payment_at,t.created_at,
        v.verified_at AS integrity_verified_at,
        m.name AS merchant_name,p.merchant_reference,t.merchant_payment_reference
      FROM transactions t
      LEFT JOIN transaction_integrity_verifications v ON v.transaction_id=t.id
      JOIN merchant_access a ON a.merchant_id=t.merchant_id
      JOIN merchants m ON m.id=t.merchant_id
      JOIN purchases p ON p.id=t.purchase_id
      WHERE a.external_user_id=? AND a.status='ACTIVE'
      ORDER BY t.created_at DESC,t.id DESC LIMIT 100
    `).bind(principal.sub).all();
    return json({transactions:result.results||[],limit:100});
  }

  const match = url.pathname.match(/^\/api\/records\/([^/]+)(\/pdf)?$/);
  if (!match || request.method !== 'GET') return null;

  const token = decodeURIComponent(match[1]);
  const tx = await findTransactionByRecordToken(env, token);
  if (!tx) return json({ error: 'Transaction record not found' }, 404);
  if (isExpired(tx.record_access_expires_at)) return json({ error: 'Transaction record link expired' }, 410);

  if (match[2] === '/pdf') {
    const full = await getTransaction(env, tx.id);
    if (!full) return json({ error: 'Transaction record not found' }, 404);
    return serveTransactionPdf(env, full, { type: 'CUSTOMER_TOKEN', ref: tokenFingerprint(token) });
  }

  return json(publicRecord(tx));
}

async function transactionEventDeliveries(env,transactionId){
  const rows=await env.DB.prepare(`
    SELECT DISTINCT a.provider_event_id,a.processor,a.event_type,
      a.provider_event_created_at,a.received_at,a.processed_at,a.outcome
    FROM transaction_events e
    JOIN processor_event_delivery_audit a ON (
      e.source_event_id=a.provider_event_id
      OR e.source_event_id LIKE a.provider_event_id||':%'
      OR e.source_event_id LIKE 'SQUARE:'||a.provider_event_id||':%'
    )
    WHERE e.transaction_id=?
    ORDER BY a.received_at DESC LIMIT 30
  `).bind(transactionId).all();
  return rows.results||[];
}

async function fullMerchantPdfEvidence(env,tx) {
  const bank=await payoutBankEvidence(env,tx);
  const [graph,deliveries,customFields]=await Promise.all([
    getTransactionGraph(env,tx.id),transactionEventDeliveries(env,tx.id),
    merchantFieldContext(env,tx.merchant_id,tx.customer_id,tx.id,{forPdf:true})]);
  return {...tx,...(bank?{bank_evidence:bank}:{}),deliveries,custom_fields:customFields,
    components:graph.visible_components||[],
    artifacts:graph.artifacts||[],source_objects:graph.source_objects||[]};
}

export async function serveOperatorTransactionPdf(env, txId, principal, options={}) {
  const tx = await getTransaction(env, txId);
  if (!tx) return json({ error: 'Transaction not found' }, 404);
  return serveTransactionPdf(env, await fullMerchantPdfEvidence(env,tx), {
    type: 'OPERATOR',
    ref: principal?.sub || null,
    view: Boolean(options.view),
  });
}

async function findTransactionByRecordToken(env, token) {
  return env.DB.prepare(`
    SELECT
      t.id,
      t.purchase_id,
      t.merchant_id,
      t.customer_id,
      t.transaction_type,
      t.description,
      t.amount_cents,
      t.currency,
      t.terms_version,
      t.consent_accepted,
      t.consent_accepted_at,
      t.lifecycle_status,
      t.integrity_status,
      t.exception_status,
      t.processor,
      t.payment_status,
      t.payment_at,
      t.processor_payout_status,
      t.expected_payout_arrival,
      t.created_at,
      t.updated_at,
      t.record_access_token,
      t.record_access_expires_at,
      p.merchant_reference,
      p.description AS purchase_description,
      m.name AS merchant_name
    FROM transactions t
    JOIN purchases p ON p.id = t.purchase_id
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.record_access_token = ?
    LIMIT 1
  `).bind(token).first();
}

function publicRecord(tx) {
  return {
    transaction_id: tx.id,
    purchase_id: tx.purchase_id,
    merchant_name: tx.merchant_name,
    purchase_reference: tx.merchant_reference,
    purchase_description: tx.purchase_description,
    transaction_type: tx.transaction_type,
    transaction_description: tx.description,
    amount_cents: tx.amount_cents,
    currency: tx.currency,
    terms_version: tx.terms_version,
    consent_accepted: Boolean(tx.consent_accepted),
    consent_accepted_at: tx.consent_accepted_at,
    lifecycle_status: tx.lifecycle_status,
    integrity_status: tx.integrity_status,
    exception_status: tx.exception_status,
    processor: tx.processor,
    payment_status: tx.payment_status,
    payment_at: tx.payment_at,
    payout_status: tx.processor_payout_status,
    expected_payout_arrival: tx.expected_payout_arrival,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
    pdf_path: `/api/records/${encodeURIComponent(tx.record_access_token)}/pdf`,
  };
}

function isExpired(value) {
  return Boolean(value && Date.parse(value) <= Date.now());
}

function tokenFingerprint(token) {
  return `token:${String(token || '').slice(0, 8)}…`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
