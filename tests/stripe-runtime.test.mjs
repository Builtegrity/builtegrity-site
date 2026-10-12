import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTrackedCheckout,
  retrieveCheckoutSession,
  stripeRequest,
  verifyStripeSignature,
} from '../worker/src/stripe.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

test('stripeRequest applies account, idempotency, API version and form headers to POST', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ id: 'cs_test_123' });
  };

  const env = {
    STRIPE_SECRET_KEY: 'sk_test_example',
    STRIPE_API_VERSION: '2025-09-30.clover',
  };

  const result = await stripeRequest(env, '/v1/checkout/sessions', {
    method: 'POST',
    accountId: 'acct_test_123',
    idempotencyKey: 'builtegrity:checkout:TX-0002:initial',
    form: { mode: 'payment' },
  });

  assert.equal(result.id, 'cs_test_123');
  assert.equal(captured.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk_test_example');
  assert.equal(captured.init.headers['Stripe-Account'], 'acct_test_123');
  assert.equal(captured.init.headers['Idempotency-Key'], 'builtegrity:checkout:TX-0002:initial');
  assert.equal(captured.init.headers['Stripe-Version'], '2025-09-30.clover');
  assert.equal(captured.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(captured.init.body, 'mode=payment');
});

test('stripeRequest never sends Idempotency-Key on GET', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ id: 'acct_test_123' });
  };

  await stripeRequest({ STRIPE_SECRET_KEY: 'sk_test_example' }, '/v1/accounts/acct_test_123', {
    idempotencyKey: 'should-not-be-sent',
  });

  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.headers['Idempotency-Key'], undefined);
});

test('createTrackedCheckout uses a stable initial idempotency key', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({
      id: 'cs_test_initial',
      url: 'https://checkout.stripe.com/c/pay/cs_test_initial',
      payment_status: 'unpaid',
      expires_at: 1_800_000_000,
    });
  };

  const tx = {
    id: 'TX-0002',
    merchant_id: 'MER-0001',
    processor_account_id: 'acct_test_123',
    consent_accepted: 1,
    payment_access_token: 'token-123',
    purchase_id: 'PUR-0002',
    customer_email: 'buyer@example.com',
    currency: 'USD',
    amount_cents: 50000,
    description: 'Protected payment',
    fee_collection_method: 'STRIPE_APPLICATION_FEE',
    integrity_fee_earned_cents: 25,
    stripe_checkout_session_id: null,
  };

  await createTrackedCheckout({
    STRIPE_SECRET_KEY: 'sk_test_example',
    APP_BASE_URL: 'https://builtegrity.com',
  }, tx);

  assert.equal(captured.init.headers['Idempotency-Key'], 'builtegrity:checkout:TX-0002:initial');
  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get('client_reference_id'), 'TX-0002');
  assert.equal(body.get('payment_intent_data[metadata][builtegrity_tx_id]'), 'TX-0002');
  assert.equal(body.get('payment_intent_data[application_fee_amount]'), '25');
});

test('createTrackedCheckout rotates idempotency seed only after a stored prior session exists', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ id: 'cs_test_replacement', url: 'https://checkout.stripe.com/replacement' });
  };

  await createTrackedCheckout({ STRIPE_SECRET_KEY: 'sk_test_example' }, {
    id: 'TX-0002',
    merchant_id: 'MER-0001',
    processor_account_id: 'acct_test_123',
    consent_accepted: 1,
    payment_access_token: 'token-123',
    purchase_id: 'PUR-0002',
    currency: 'USD',
    amount_cents: 50000,
    description: 'Protected payment',
    fee_collection_method: 'STRIPE_APPLICATION_FEE',
    integrity_fee_earned_cents: 25,
    stripe_checkout_session_id: 'cs_test_expired',
  });

  assert.equal(captured.init.headers['Idempotency-Key'], 'builtegrity:checkout:TX-0002:cs_test_expired');
});

test('retrieveCheckoutSession is scoped to the connected account', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ id: 'cs_test_123', status: 'open' });
  };

  const session = await retrieveCheckoutSession(
    { STRIPE_SECRET_KEY: 'sk_test_example' },
    'acct_test_123',
    'cs_test_123',
  );

  assert.equal(session.status, 'open');
  assert.equal(captured.url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_123');
  assert.equal(captured.init.headers['Stripe-Account'], 'acct_test_123');
});

test('Stripe webhook signature verification accepts a valid current v1 signature and rejects tampering', async () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_test_123', type: 'payment_intent.succeeded' });
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const signature = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  assert.equal(
    await verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret),
    true,
  );
  assert.equal(
    await verifyStripeSignature(`${body} `, `t=${timestamp},v1=${signature}`, secret),
    false,
  );
});
