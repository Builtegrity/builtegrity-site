import { allocateId, getTransaction } from './db.js';

export async function createTransactionRequest(request, env) {
  const body = await readJson(request);
  if (!body.merchant_id) return json({ error: 'merchant_id is required' }, 400);

  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(body.merchant_id).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);

  const merchantProblem = v1MerchantProblem(merchant, env);
  if (merchantProblem) return json({ error: merchantProblem }, 409);

  const creationKey = String(request.headers.get('Idempotency-Key') || body.idempotency_key || '').trim();
  if (!creationKey && env.DEV_MODE !== 'true') {
    return json({ error: 'Idempotency-Key is required when creating a transaction' }, 400);
  }
  if (creationKey.length > 200) return json({ error: 'Idempotency-Key must be 200 characters or fewer' }, 400);

  if (creationKey) {
    const existing = await findExisting(env, merchant.id, creationKey);
    if (existing) return existingResponse(env, existing);
  }

  const txInput = body.transaction || {};
  if (!Number.isInteger(txInput.amount_cents) || txInput.amount_cents <= 0) {
    return json({ error: 'transaction.amount_cents must be a positive integer' }, 400);
  }
  if (!txInput.description || !txInput.terms_snapshot) {
    return json({ error: 'transaction.description and transaction.terms_snapshot are required' }, 400);
  }

  const txCurrency = String(txInput.currency || 'USD').toUpperCase();
  if (txCurrency !== 'USD') return json({ error: 'Builtegrity V1 currently supports USD transactions only' }, 400);

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

  const statements = [];
  let customerId = body.customer_id || null;
  if (!customerId) {
    const customer = body.customer || {};
    if (!customer.name) return json({ error: 'customer.name is required when customer_id is omitted' }, 400);
    customerId = await allocateId(env, 'CUST');
    statements.push(env.DB.prepare(`
      INSERT INTO customers (id, merchant_id, name, email, merchant_customer_reference)
      VALUES (?, ?, ?, ?, ?)
    `).bind(customerId, merchant.id, customer.name, customer.email || null, customer.reference || null));
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
    if (purchase.total_value_cents !== undefined &&
        (!Number.isInteger(purchase.total_value_cents) || purchase.total_value_cents < 0)) {
      return json({ error: 'purchase.total_value_cents must be a non-negative integer when provided' }, 400);
    }

    purchaseId = await allocateId(env, 'PUR');
    statements.push(env.DB.prepare(`
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
    ));
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
  const eventId = await allocateId(env, 'EVT', 6);
  const paymentToken = randomToken();
  const termsHash = await sha256Hex(txInput.terms_snapshot);
  const sourceEventId = `create:${merchant.id}:${creationKey || txId}`;

  statements.push(env.DB.prepare(`
    INSERT INTO transactions (
      id, purchase_id, merchant_id, customer_id,
      transaction_type, description, amount_cents, currency,
      terms_version, terms_snapshot, terms_snapshot_sha256,
      refund_policy_snapshot, cancellation_policy_snapshot,
      integrity_fee_earned_cents, fee_collection_method,
      payment_access_token, payment_access_expires_at, creation_idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    creationKey || null,
  ));

  statements.push(env.DB.prepare(`
    INSERT INTO transaction_events
      (id, transaction_id, event_type, source, source_event_id, event_data_json)
    VALUES (?, ?, 'TX_CREATED', 'BUILTEGRITY', ?, ?)
  `).bind(
    eventId,
    txId,
    sourceEventId,
    JSON.stringify({ purchase_id: purchaseId, merchant_id: merchant.id }),
  ));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (creationKey) {
      const existing = await findExisting(env, merchant.id, creationKey);
      if (existing) return existingResponse(env, existing);
    }
    throw error;
  }

  return json({
    transaction: await getTransaction(env, txId),
    payment_path: `/pay/?token=${encodeURIComponent(paymentToken)}`,
  }, 201);
}

async function findExisting(env, merchantId, creationKey) {
  return env.DB.prepare(`
    SELECT id, payment_access_token
    FROM transactions
    WHERE merchant_id = ? AND creation_idempotency_key = ?
    LIMIT 1
  `).bind(merchantId, creationKey).first();
}

async function existingResponse(env, existing) {
  return json({
    transaction: await getTransaction(env, existing.id),
    payment_path: existing.payment_access_token
      ? `/pay/?token=${encodeURIComponent(existing.payment_access_token)}`
      : null,
    idempotent_replay: true,
  });
}

function v1MerchantProblem(merchant, env) {
  const status = String(merchant.status || '').toUpperCase();
  const processor = String(merchant.processor || '').toUpperCase();
  const integrationMode = String(merchant.integration_mode || '').toUpperCase();
  const accountId = String(merchant.processor_account_id || '');
  const testStage = env.DEV_MODE === 'true' || String(env.WATCHDOG_STAGE || '').toUpperCase() === 'TEST';

  if (status === 'PAUSED' || status === 'DISCONNECTED') return `Merchant is ${status.toLowerCase()} and cannot create protected payments`;
  if (status !== 'ACTIVE' && !(testStage && status === 'TEST')) return 'Merchant is not enabled for Builtegrity payments';
  if (processor !== 'STRIPE') return 'Builtegrity V1 supports Stripe merchants only';
  if (integrationMode !== 'STRIPE_CONNECT') return 'Builtegrity V1 requires the Stripe Connect integration';
  if (!accountId.startsWith('acct_')) return 'Merchant does not have a usable Stripe connected account';
  return null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  try { return await request.json(); } catch {
    return null;
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
