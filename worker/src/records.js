import { getTransaction } from './db.js';
import { getTransactionGraph } from './transaction-intelligence.js';
import { serveTransactionPdf } from './pdf.js';
import { authenticateClerkSession } from './clerk-auth.js';
import { requireMerchantMembership } from './authorization.js';
import { handleResendStatementWebhook } from './resend-statement-webhooks.js';
import { handleMerchantComplianceRoute } from './merchant-compliance-routes.js';
import { handleLegalInboxWebhook } from './legal-inbox.js';
import { handleLegalProviderWebhook } from './legal-provider-webhooks.js';

export async function handlePublicRecordRoute(request, env) {
  // This gateway runs before the owner/admin API gate. Legal/provider webhooks are public only in
  // the network sense: each has its own cryptographic signature/secret boundary. Email/provider
  // content remains untrusted evidence and can never inherit operator privileges.
  const url = new URL(request.url);
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
        m.name AS merchant_name,p.merchant_reference
      FROM transactions t
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

async function fullMerchantPdfEvidence(env,tx) {
  const graph=await getTransactionGraph(env,tx.id);
  return {...tx,components:graph.visible_components||[],
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
