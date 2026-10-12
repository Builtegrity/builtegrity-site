import {
  advanceLifecycle,
  getTransaction,
  listTransactions,
  openException,
  recomputeIntegrity,
  recordEvent,
  resolveException,
} from './db.js';
import {
  createTrackedCheckout,
  retrieveCheckoutSession,
  verifyStripeSignature,
} from './stripe.js';
import { processStripeWebhook } from './webhooks.js';
import { createTransactionRequest } from './transaction-create.js';
import { verifyMerchantStripe } from './merchant-stripe.js';
import { publicTurnstileConfig, requireTurnstile } from './turnstile.js';
import { transactionStageProblem } from './readiness.js';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/health' && request.method === 'GET') {
        return json({
          ok: true,
          service: 'builtegrity-transaction-engine',
          mode: env.DEV_MODE === 'true' ? 'development' : 'production',
        });
      }

      if (path === '/api/webhooks/stripe' && request.method === 'POST') {
        return await handleStripeWebhook(request, env);
      }

      const publicMatch = path.match(/^\/api\/payments\/([^/]+)$/);
      if (publicMatch && request.method === 'GET') {
        return await handlePublicPayment(env, decodeURIComponent(publicMatch[1]));
      }

      const consentMatch = path.match(/^\/api\/payments\/([^/]+)\/consent$/);
      if (consentMatch && request.method === 'POST') {
        return await handleConsent(request, env, decodeURIComponent(consentMatch[1]));
      }

      const checkoutMatch = path.match(/^\/api\/payments\/([^/]+)\/checkout$/);
      if (checkoutMatch && request.method === 'POST') {
        return await handleCheckout(env, decodeURIComponent(checkoutMatch[1]));
      }

      if (path.startsWith('/api/')) {
        requireInternal(request, env);
      }

      if (path === '/api/transactions' && request.method === 'GET') {
        return json({ transactions: await listTransactions(env, url.searchParams.get('limit')) });
      }

      if (path === '/api/transactions' && request.method === 'POST') {
        return await createTransactionRequest(request, env);
      }

      const txMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)$/);
      if (txMatch && request.method === 'GET') {
        const tx = await getTransaction(env, txMatch[1]);
        return tx ? json(tx) : json({ error: 'Transaction not found' }, 404);
      }

      const verifyMerchantMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/verify$/);
      if (verifyMerchantMatch && request.method === 'POST') {
        return await verifyMerchantStripe(env, verifyMerchantMatch[1]);
      }

      const simulateMatch = path.match(/^\/api\/dev\/transactions\/(TX-[A-Za-z0-9-]+)\/simulate$/);
      if (simulateMatch && request.method === 'POST') {
        if (env.DEV_MODE !== 'true') return json({ error: 'Development simulator is disabled' }, 404);
        return await handleSimulation(request, env, simulateMatch[1]);
      }

      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error(error);
      const status = error?.status && Number(error.status) >= 400 && Number(error.status) < 600
        ? Number(error.status)
        : 500;
      const message = status >= 500 ? 'Internal error' : (error?.message || 'Request failed');
      return json({ error: message }, status);
    }
  },
};

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Stripe webhook secret is not configured' }, 503);
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature');
  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'Invalid Stripe signature' }, 400);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const result = await processStripeWebhook(env, event);
  return json({ received: true, ...result });
}

async function handlePublicPayment(env, token) {
  const tx = await findByPaymentToken(env, token);
  if (!tx) return json({ error: 'Payment link not found' }, 404);
  if (isExpired(tx.payment_access_expires_at)) return json({ error: 'Payment link expired' }, 410);
  const turnstile = publicTurnstileConfig(env);

  return json({
    transaction_id: tx.id,
    merchant_name: tx.merchant_name,
    purchase_reference: tx.merchant_reference,
    purchase_description: tx.purchase_description,
    transaction_description: tx.description,
    transaction_type: tx.transaction_type,
    amount_cents: tx.amount_cents,
    currency: tx.currency,
    terms_version: tx.terms_version,
    terms_snapshot: tx.terms_snapshot,
    refund_policy: tx.refund_policy_snapshot,
    cancellation_policy: tx.cancellation_policy_snapshot,
    consent_accepted: Boolean(tx.consent_accepted),
    lifecycle_status: tx.lifecycle_status,
    payment_status: tx.payment_status,
    turnstile_required: turnstile.required,
    turnstile_site_key: turnstile.site_key,
  });
}

async function handleConsent(request, env, token) {
  const stageProblem = transactionStageProblem(env);
  if (stageProblem) return json({ error: stageProblem }, 503);

  const tx = await findByPaymentToken(env, token);
  if (!tx) return json({ error: 'Payment link not found' }, 404);
  if (isExpired(tx.payment_access_expires_at)) return json({ error: 'Payment link expired' }, 410);
  if (isPaid(tx)) return json({ error: 'This transaction has already been paid' }, 409);

  const merchantProblem = v1MerchantProblem(tx, env);
  if (merchantProblem) return json({ error: merchantProblem }, 409);

  const body = await readJson(request);
  if (body.accepted !== true) return json({ error: 'Explicit acceptance is required' }, 400);
  if (!tx.terms_snapshot) return json({ error: 'No terms snapshot exists for this transaction' }, 409);
  await requireTurnstile(request, env, body.turnstile_token, 'payment_consent');

  if (!Number(tx.consent_accepted)) {
    const termsHash = await sha256Hex(tx.terms_snapshot);
    await env.DB.prepare(`
      UPDATE transactions
         SET consent_accepted = 1,
             consent_accepted_at = CURRENT_TIMESTAMP,
             consent_method = 'CHECKBOX_CONTINUE',
             terms_snapshot_sha256 = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(termsHash, tx.id).run();

    await advanceLifecycle(env, tx.id, 'CONSENTED');
    await recordEvent(env, tx.id, 'TERMS_ACCEPTED', 'CUSTOMER', null, {
      terms_version: tx.terms_version,
      terms_snapshot_sha256: termsHash,
      method: 'CHECKBOX_CONTINUE',
    });
  }

  await recomputeIntegrity(env, tx.id);
  return json({ accepted: true, transaction_id: tx.id });
}

async function handleCheckout(env, token) {
  const stageProblem = transactionStageProblem(env);
  if (stageProblem) return json({ error: stageProblem }, 503);

  let tx = await findByPaymentToken(env, token);
  if (!tx) return json({ error: 'Payment link not found' }, 404);
  if (isExpired(tx.payment_access_expires_at)) return json({ error: 'Payment link expired' }, 410);
  if (!Number(tx.consent_accepted)) return json({ error: 'Terms must be accepted before payment' }, 409);
  if (isPaid(tx)) return json({ error: 'This transaction has already been paid' }, 409);

  const merchantProblem = v1MerchantProblem(tx, env);
  if (merchantProblem) return json({ error: merchantProblem }, 409);

  if (tx.stripe_checkout_session_id && ['CREATED', 'CONSENTED', 'PAYMENT_PENDING'].includes(tx.lifecycle_status)) {
    const existing = await retrieveCheckoutSession(env, tx.processor_account_id, tx.stripe_checkout_session_id);
    if (existing.status === 'open') {
      if (!existing.url) return json({ error: 'Existing Stripe Checkout Session has no usable payment URL' }, 502);
      return json({ url: existing.url, checkout_session_id: existing.id });
    }
    if (existing.status === 'complete') {
      return json({ error: 'Stripe Checkout is complete; payment confirmation is still being reconciled' }, 409);
    }
    if (existing.status === 'expired') {
      await env.DB.prepare(`
        UPDATE transactions
           SET stripe_checkout_url = NULL,
               stripe_checkout_expires_at = COALESCE(?, stripe_checkout_expires_at),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND stripe_checkout_session_id = ?
      `).bind(stripeTimestamp(existing.expires_at), tx.id, existing.id).run();
      await recordEvent(env, tx.id, 'CHECKOUT_EXPIRED', 'STRIPE', null, {
        checkout_session_id: existing.id,
      });
      tx = await findByPaymentToken(env, token);
    }
  }

  const session = await createTrackedCheckout(env, tx);
  const checkoutExpiresAt = stripeTimestamp(session.expires_at);
  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_checkout_session_id = ?,
           stripe_checkout_url = ?,
           stripe_checkout_expires_at = ?,
           payment_status = COALESCE(?, payment_status),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(session.id, session.url, checkoutExpiresAt, session.payment_status || null, tx.id).run();

  await advanceLifecycle(env, tx.id, 'PAYMENT_PENDING');
  await recordEvent(env, tx.id, 'CHECKOUT_CREATED', 'BUILTEGRITY', null, {
    checkout_session_id: session.id,
    expires_at: checkoutExpiresAt,
  });

  return json({ url: session.url, checkout_session_id: session.id });
}

async function handleSimulation(request, env, txId) {
  const body = await readJson(request);
  const action = String(body.action || '').toUpperCase();
  const tx = await getTransaction(env, txId);
  if (!tx) return json({ error: 'Transaction not found' }, 404);

  if (action === 'CONSENT') {
    if (!Number(tx.consent_accepted)) {
      const termsHash = await sha256Hex(tx.terms_snapshot || '');
      await env.DB.prepare(`
        UPDATE transactions SET consent_accepted = 1, consent_accepted_at = CURRENT_TIMESTAMP,
          consent_method = 'DEV_SIMULATOR', terms_snapshot_sha256 = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(termsHash, txId).run();
      await advanceLifecycle(env, txId, 'CONSENTED');
      await recordEvent(env, txId, 'TERMS_ACCEPTED', 'SYSTEM', null, { simulation: true });
    }
  } else if (action === 'CHECKOUT') {
    await env.DB.prepare(`
      UPDATE transactions SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?),
        payment_status = 'unpaid', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(`cs_test_sim_${txId}`, txId).run();
    await advanceLifecycle(env, txId, 'PAYMENT_PENDING');
    await recordEvent(env, txId, 'CHECKOUT_CREATED', 'SYSTEM', null, { simulation: true });
  } else if (action === 'PAYMENT') {
    await env.DB.prepare(`
      UPDATE transactions SET stripe_payment_intent_id = ?, stripe_charge_id = ?,
        stripe_balance_transaction_id = ?, stripe_application_fee_id = ?, payment_status = 'succeeded',
        payment_at = CURRENT_TIMESTAMP, customer_paid_cents = amount_cents,
        processor_fee_cents = 0, expected_merchant_net_cents = amount_cents - integrity_fee_earned_cents,
        integrity_fee_collected_cents = integrity_fee_earned_cents, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(`pi_test_sim_${txId}`, `ch_test_sim_${txId}`, `txn_test_sim_${txId}`, `fee_test_sim_${txId}`, txId).run();
    await advanceLifecycle(env, txId, 'PAID');
    await recordEvent(env, txId, 'PAYMENT_SUCCEEDED', 'SYSTEM', null, { simulation: true });
    await advanceLifecycle(env, txId, 'PAYOUT_PENDING');
    await recordEvent(env, txId, 'BALANCE_RECORDED', 'SYSTEM', null, { simulation: true });
    await resolveException(env, txId, 'PAYMENT_FAILED', 'Development simulator later marked payment successful.');
  } else if (action === 'PAYOUT') {
    await env.DB.prepare(`
      UPDATE transactions SET stripe_payout_id = ?, payout_accounted = 1,
        processor_payout_status = 'paid', transaction_payout_contribution_cents = expected_merchant_net_cents,
        actual_merchant_net_cents = expected_merchant_net_cents, payout_batch_total_cents = expected_merchant_net_cents,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(`po_test_sim_${txId}`, txId).run();
    await advanceLifecycle(env, txId, 'COMPLETE');
    await recordEvent(env, txId, 'PAYOUT_IDENTIFIED', 'SYSTEM', null, { simulation: true });
    await recordEvent(env, txId, 'PAYOUT_PAID', 'SYSTEM', null, { simulation: true });
  } else if (action === 'FAIL_PAYMENT') {
    await recordEvent(env, txId, 'PAYMENT_FAILED', 'SYSTEM', null, { simulation: true });
    await openException(env, txId, 'PAYMENT_FAILED', 'Development simulator payment failure.');
  } else if (action === 'OPEN_DISPUTE') {
    await recordEvent(env, txId, 'DISPUTE_OPENED', 'SYSTEM', null, {
      simulation: true,
      dispute_id: `dp_test_sim_${txId}`,
      status: 'needs_response',
    });
    await openException(env, txId, 'DISPUTE_OPENED', 'Development simulator dispute.');
  } else if (action === 'RESOLVE_DISPUTE') {
    await recordEvent(env, txId, 'DISPUTE_CLOSED', 'SYSTEM', null, {
      simulation: true,
      dispute_id: `dp_test_sim_${txId}`,
      status: 'won',
    });
    await resolveException(env, txId, 'DISPUTE_OPENED', 'Development simulator closed dispute.');
  } else if (action === 'PAYOUT_FAILED') {
    await env.DB.prepare(`UPDATE transactions SET processor_payout_status = 'failed' WHERE id = ?`).bind(txId).run();
    await recordEvent(env, txId, 'PAYOUT_FAILED', 'SYSTEM', null, { simulation: true });
    await openException(env, txId, 'PAYOUT_FAILED', 'Development simulator payout failure.');
  } else {
    return json({ error: 'Unknown simulation action' }, 400);
  }

  await recomputeIntegrity(env, txId);
  return json(await getTransaction(env, txId));
}

async function findByPaymentToken(env, token) {
  return env.DB.prepare(`
    SELECT
      t.*,
      p.merchant_reference,
      p.description AS purchase_description,
      m.name AS merchant_name,
      m.status AS merchant_status,
      m.processor AS merchant_processor,
      m.integration_mode AS merchant_integration_mode,
      m.processor_account_id,
      c.email AS customer_email
    FROM transactions t
    JOIN purchases p ON p.id = t.purchase_id
    JOIN merchants m ON m.id = t.merchant_id
    JOIN customers c ON c.id = t.customer_id
    WHERE t.payment_access_token = ?
    LIMIT 1
  `).bind(token).first();
}

function v1MerchantProblem(merchant, env) {
  const status = String(merchant.merchant_status || merchant.status || '').toUpperCase();
  const processor = String(merchant.merchant_processor || merchant.processor || '').toUpperCase();
  const integrationMode = String(merchant.merchant_integration_mode || merchant.integration_mode || '').toUpperCase();
  const accountId = String(merchant.processor_account_id || '');
  const testStage = String(env.WATCHDOG_STAGE || '').toUpperCase() === 'TEST';

  if (status === 'PAUSED' || status === 'DISCONNECTED') return `Merchant is ${status.toLowerCase()} and cannot create protected payments`;
  if (status !== 'ACTIVE' && !(testStage && status === 'TEST')) return 'Merchant is not enabled for Builtegrity payments';
  if (processor !== 'STRIPE') return 'Builtegrity V1 supports Stripe merchants only';
  if (integrationMode !== 'STRIPE_CONNECT') return 'Builtegrity V1 requires the Stripe Connect integration';
  if (!accountId.startsWith('acct_')) return 'Merchant does not have a usable Stripe connected account';
  return null;
}

function isPaid(tx) {
  return String(tx.payment_status || '').toLowerCase() === 'succeeded' ||
    ['PAID', 'PAYOUT_PENDING', 'COMPLETE'].includes(String(tx.lifecycle_status || '').toUpperCase());
}

function stripeTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function requireInternal(request, env) {
  if (env.DEV_MODE === 'true') return;
  if (!env.INTERNAL_ADMIN_TOKEN) {
    const error = new Error('Internal authentication is not configured');
    error.status = 503;
    throw error;
  }
  const provided = request.headers.get('X-Builtegrity-Admin') || '';
  if (!timingSafeEqual(provided, env.INTERNAL_ADMIN_TOKEN)) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isExpired(value) {
  return Boolean(value && Date.parse(value) <= Date.now());
}

async function readJson(request) {
  try { return await request.json(); } catch {
    const error = new Error('Invalid JSON request body');
    error.status = 400;
    throw error;
  }
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
