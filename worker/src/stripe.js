function requireSecret(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function addParam(search, key, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) search.append(key, String(item));
    return;
  }
  search.append(key, String(value));
}

export async function stripeRequest(env, path, options = {}) {
  const secret = requireSecret(env, 'STRIPE_SECRET_KEY');
  const method = options.method || 'GET';
  const accountId = options.accountId || null;
  const headers = {
    Authorization: `Bearer ${secret}`,
  };
  if (accountId) headers['Stripe-Account'] = accountId;

  let url = `https://api.stripe.com${path}`;
  const init = { method, headers };

  if (method === 'GET' && options.params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params)) addParam(search, key, value);
    const qs = search.toString();
    if (qs) url += `?${qs}`;
  } else if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) addParam(body, key, value);
    init.body = body.toString();
  }

  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Stripe API error ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.stripe = payload?.error || payload;
    throw error;
  }
  return payload;
}

export async function createTrackedCheckout(env, tx) {
  if (!tx.processor_account_id || !String(tx.processor_account_id).startsWith('acct_')) {
    throw new Error(`Merchant ${tx.merchant_id} does not have a usable Stripe connected account`);
  }
  if (Number(tx.consent_accepted) !== 1) {
    throw new Error('Customer consent must be recorded before Stripe Checkout is created');
  }

  const baseUrl = env.APP_BASE_URL || 'http://localhost:8787';
  const form = {
    mode: 'payment',
    success_url: `${baseUrl}/pay/success/?tx=${encodeURIComponent(tx.id)}`,
    cancel_url: `${baseUrl}/pay/?tx=${encodeURIComponent(tx.id)}`,
    client_reference_id: tx.id,
    customer_email: tx.customer_email || undefined,
    'metadata[builtegrity_tx_id]': tx.id,
    'metadata[builtegrity_purchase_id]': tx.purchase_id,
    'payment_intent_data[metadata][builtegrity_tx_id]': tx.id,
    'payment_intent_data[metadata][builtegrity_purchase_id]': tx.purchase_id,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': String(tx.currency || 'USD').toLowerCase(),
    'line_items[0][price_data][unit_amount]': Number(tx.amount_cents),
    'line_items[0][price_data][product_data][name]': tx.description,
  };

  if (
    tx.fee_collection_method === 'STRIPE_APPLICATION_FEE' &&
    Number(tx.integrity_fee_earned_cents) > 0
  ) {
    form['payment_intent_data[application_fee_amount]'] = Number(tx.integrity_fee_earned_cents);
  }

  return stripeRequest(env, '/v1/checkout/sessions', {
    method: 'POST',
    accountId: tx.processor_account_id,
    form,
  });
}

export async function retrievePaymentIntent(env, accountId, paymentIntentId) {
  return stripeRequest(env, `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    accountId,
    params: { 'expand[]': ['latest_charge'] },
  });
}

export async function retrieveCharge(env, accountId, chargeId) {
  return stripeRequest(env, `/v1/charges/${encodeURIComponent(chargeId)}`, {
    accountId,
    params: { 'expand[]': ['balance_transaction', 'application_fee'] },
  });
}

export async function retrieveConnectedAccount(env, accountId) {
  return stripeRequest(env, `/v1/accounts/${encodeURIComponent(accountId)}`);
}

export async function listPayoutBalanceTransactions(env, accountId, payoutId) {
  const all = [];
  let startingAfter = null;
  do {
    const params = { payout: payoutId, limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripeRequest(env, '/v1/balance_transactions', {
      accountId,
      params,
    });
    all.push(...(page.data || []));
    startingAfter = page.has_more && page.data?.length ? page.data[page.data.length - 1].id : null;
  } while (startingAfter);
  return all;
}

export async function verifyStripeSignature(rawBody, signatureHeader, endpointSecret, toleranceSeconds = 300) {
  if (!signatureHeader || !endpointSecret) return false;

  const parts = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(endpointSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = `${timestamp}.${rawBody}`;
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return signatures.some((candidate) => timingSafeEqual(expected, candidate));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
