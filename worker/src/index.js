import {
  advanceLifecycle,
  allocateId,
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
  retrieveConnectedAccount,
  verifyStripeSignature,
} from './stripe.js';
import { processStripeWebhook } from './webhooks.js';

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
        return handleStripeWebhook(request, env);
      }

      const publicMatch = path.match(/^\/api\/payments\/([^/]+)$/);
      if (publicMatch && request.method === 'GET') {
        return handlePublicPayment(env, decodeURIComponent(publicMatch[1]));
      }

      const consentMatch = path.match(/^\/api\/payments\/([^/]+)\/consent$/);
      if (consentMatch && request.method === 'POST') {
        return handleConsent(request, env, decodeURIComponent(consentMatch[1]));
      }

      const checkoutMatch = path.match(/^\/api\/payments\/([^/]+)\/checkout$/);
      if (checkoutMatch && request.method === 'POST') {
        return handleCheckout(env, decodeURIComponent(checkoutMatch[1]));
      }

      if (path.startsWith('/api/')) {
        requireInternal(request, env);
      }

      if (path === '/api/transactions' && request.method === 'GET') {
        return json({ transactions: await listTransactions(env, url.searchParams.get('limit')) });
      }

      if (path === '/api/transactions' && request.method === 'POST') {
        return handleCreateTransaction(request, env);
      }

      const txMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)$/);
      if (txMatch && request.method === 'GET') {
        const tx = await getTransaction(env, txMatch[1]);
        return tx ? json(tx) : json({ error: 'Transaction not found' }, 404);
      }

      const verifyMerchantMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/verify$/);
      if (verifyMerchantMatch && request.method === 'POST') {
        return handleVerifyMerchant(env, verifyMerchantMatch[1]);
      }

      const simulateMatch = path.match(/^\/api\/dev\/transactions\/(TX-[A-Za-z0-9-]+)\/simulate$/);
      if (simulateMatch && request.method === 'POST') {
        if (env.DEV_MODE !== 'true') return json({ error: 'Development simulator is disabled' }, 404);
        return handleSimulation(request, env, simulateMatch[1]);
      }

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error(error);
      const status = error.status && Number(error.status) >= 400 && Number(error.status) < 600
        ? Number(error.status)
        : 500;
      return json({ error: error.message || 'Internal error' }, status);
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
  });
}

async function handleConsent(request, env, token) {
  const tx = await findByPaymentToken(env, token);
  if (!tx) return json({ error: 'Payment link not found' }, 404);
  if (isExpired(tx.payment_access_expires_at)) return json({ error: 'Payment link expired' }, 410);
  if (isPaid(tx)) return json({ error: 'This transaction has already been paid' }, 409);

  const body = await readJson(request);
  if (body.accepted !== true) return json({ error: 'Explicit acceptance is required' }, 400);
  if (!tx.terms_snapshot) return json({ error: 'No terms snapshot exists for this transaction' }, 409);

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
  let tx = await findByPaymentToken(env, token);
  if (!tx) return json({ error: 'Payment link not found' }, 404);
  if (isExpired(tx.payment_access_expires_at)) return json({ error: 'Payment link expired' }, 410);
  if (!Number(tx.consent_accepted)) return json({ error: 'Terms must be accepted before payment' }, 409);
  if (isPaid(tx)) return json({ error: 'This transaction has already been paid' }, 409);

  const merchantProblem = v1MerchantProblem(tx);
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

async function handleCreateTransaction(request, env) {
  const body = await readJson(request);
  if (!body.merchant_id) return json({ error: 'merchant_id is required' }, 400);
  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(body.merchant_id).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);

  const merchantProblem = v1MerchantProblem(merchant);
  if (merchantProblem) return json({ error: merchantProblem }, 409);

  const txInput = body.transaction || {};
  if (!Number.isInteger(txInput.amount_cents) || txInput.amount_cents <= 0) {
    return json({ error: 'transaction.amount_cents must be a positive integer' }, 400);
  }
  if (!txInput.description || !txInput.terms_snapshot) {
    return json({ error: 'transaction.description and transaction.terms_snapshot are required' }, 400);
  }

  const txCurrency = String(txInput.currency || 'USD').toUpperCase();
  if (txCurrency !== 'USD') {
    return json({ error: 'Builtegrity V1 currently supports USD transactions only' }, 400);
  }

  const integrityFee = Number.isInteger(txInput.integrity_fee_earned_cents)
    ? txInput.integrity_fee_earned_cents
    : 0;
  if (integrityFee < 0 || integrityFee > txInput.amount_cents) {
    return json({ error: 'transaction.integrity_fee_earned_cents must be between 0 and the transaction amount' }, 400);
  }

  const collectionMethod = txInput.fee_collection_method || 'STRIPE_APPLICATION_FEE';
  if (collectionMethod !== 'STRIPE_APPLICATION_FEE') {
    return json({ error: 'Builtegrity V1 only supports STRIPE_APPLICATION_FEE fee collection' }, 400);
  }

  let customerId = body.customer_id || null;
  if (!customerId) {
    const customer = body.customer || {};
    if (!customer.name) return json({ error: 'customer.name is required when customer_id is omitted' }, 400);
    customerId = await allocateId(env, 'CUST');
    await env.DB.prepare(`
      INSERT INTO customers (id, merchant_id, name, email, merchant_customer_reference)
      VALUES (?, ?, ?, ?, ?)
    `).bind(customerId, merchant.id, customer.name, customer.email || null, customer.reference || null).run();
  } else {
    const existing = await env.DB.prepare(`
      SELECT id FROM customers WHERE id = ? AND merchant_id = ?
    `).bind(customerId, merchant.id).first();
    if (!existing) return json({ error: 'Customer does not belong to this merchant' }, 400);
  }

  let purchaseId = body.purchase_id || null;
  if (!purchaseId) {
    const purchase = body.purchase || {};
    const purchaseCurrency = String(purchase.currency || txCurrency).toUpperCase();
    if (purchaseCurrency !== 'USD') return json({ error: 'Builtegrity V1 purchases must use USD' }, 400);

    purchaseId = await allocateId(env, 'PUR');
    await env.DB.prepare(`
      INSERT INTO purchases
        (id, merchant_id, customer_id, merchant_reference, purchase_type, description, total_value_cents, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      purchaseId,
      merchant.id,
      customerId,
      purchase.merchant_reference || null,
      purchase.purchase_type || null,
      purchase.description || txInput.description,
      Number.isInteger(purchase.total_value_cents) ? purchase.total_value_cents : null,
      purchaseCurrency,
    ).run();
  } else {
    const existing = await env.DB.prepare(`
      SELECT id, currency FROM purchases WHERE id = ? AND merchant_id = ? AND customer_id = ?
    `).bind(purchaseId, merchant.id, customerId).first();
    if (!existing) return json({ error: 'Purchase does not belong to this merchant/customer relationship' }, 400);
    if (String(existing.currency || '').toUpperCase() !== txCurrency) {
      return json({ error: 'Transaction currency must match the existing purchase currency' }, 400);
    }
  }

  const txId = await allocateId(env, 'TX');
  const paymentToken = randomToken();
  const termsHash = await sha256Hex(txInput.terms_snapshot);

  await env.DB.prepare(`
    INSERT INTO transactions (
      id, purchase_id, merchant_id, customer_id,
      transaction_type, description, amount_cents, currency,
      terms_version, terms_snapshot, terms_snapshot_sha256,
      refund_policy_snapshot, cancellation_policy_snapshot,
      integrity_fee_earned_cents, fee_collection_method,
      payment_access_token, payment_access_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    txId,
    purchaseId,
    merchant.id,
    customerId,
    txInput.transaction_type || 'PAYMENT',
    txInput.description,
    txInput.amount_cents,
    txCurrency,
    txInput.terms_version || 'TERMS-001',
    txInput.terms_snapshot,
    termsHash,
    txInput.refund_policy_snapshot || null,
    txInput.cancellation_policy_snapshot || null,
    integrityFee,
    collectionMethod,
    paymentToken,
    txInput.payment_access_expires_at || null,
  ).run();

  await recordEvent(env, txId, 'TX_CREATED', 'BUILTEGRITY', null, {
    purchase_id: purchaseId,
    merchant_id: merchant.id,
  });

  return json({
    transaction: await getTransaction(env, txId),
    payment_path: `/pay/?token=${encodeURIComponent(paymentToken)}`,
  }, 201);
}

async function handleVerifyMerchant(env, merchantId) {
  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);
  if (!merchant.processor_account_id || !String(merchant.processor_account_id).startsWith('acct_')) {
    return json({ compatible: false, reason: 'No Stripe connected account is stored for this merchant' }, 409);
  }

  const account = await retrieveConnectedAccount(env, merchant.processor_account_id);
  const payoutInterval = account.settings?.payouts?.schedule?.interval || null;
  const automaticPayouts = payoutInterval ? payoutInterval !== 'manual' : null;
  const compatible = Boolean(account.charges_enabled && account.payouts_enabled && automaticPayouts !== false);

  await env.DB.prepare(`
    UPDATE merchants
       SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(compatible ? 'ACTIVE' : 'TEST', merchantId).run();

  return json({
    compatible,
    account_id: account.id,
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    payout_interval: payoutInterval,
    automatic_payouts: automaticPayouts,
    details_submitted: Boolean(account.details_submitted),
  });
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
    await recordEvent(env, txId, 'DISPUTE_OPENED', 'SYSTEM', null, { simulation: true });
    await openException(env, txId, 'DISPUTE_OPENED', 'Development simulator dispute.');
  } else if (action === 'RESOLVE_DISPUTE') {
    await recordEvent(env, txId, 'DISPUTE_CLOSED', 'SYSTEM', null, { simulation: true });
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

function v1MerchantProblem(merchant) {
  const status = String(merchant.merchant_status || merchant.status || '').toUpperCase();
  const processor = String(merchant.merchant_processor || merchant.processor || '').toUpperCase();
  const integrationMode = String(merchant.merchant_integration_mode || merchant.integration_mode || '').toUpperCase();
  const accountId = String(merchant.processor_account_id || '');

  if (status === 'PAUSED' || status === 'DISCONNECTED') return `Merchant is ${status.toLowerCase()} and cannot create protected payments`;
  if (!['TEST', 'ACTIVE'].includes(status)) return 'Merchant is not enabled for Builtegrity payments';
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

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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
