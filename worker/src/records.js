import { getTransaction } from './db.js';
import { serveTransactionPdf } from './pdf.js';

export async function handlePublicRecordRoute(request, env) {
  const url = new URL(request.url);
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

export async function serveOperatorTransactionPdf(env, txId, principal) {
  const tx = await getTransaction(env, txId);
  if (!tx) return json({ error: 'Transaction not found' }, 404);
  return serveTransactionPdf(env, tx, {
    type: 'OPERATOR',
    ref: principal?.sub || null,
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
