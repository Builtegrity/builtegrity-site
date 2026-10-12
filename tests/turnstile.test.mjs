import test from 'node:test';
import assert from 'node:assert/strict';

import { publicTurnstileConfig, requireTurnstile, turnstileRequired } from '../worker/src/turnstile.js';

function env(overrides = {}) {
  return {
    WATCHDOG_STAGE: 'PILOT',
    APP_BASE_URL: 'https://builtegrity.com',
    TURNSTILE_SITE_KEY: 'site_test',
    TURNSTILE_SECRET_KEY: 'secret_test',
    ...overrides,
  };
}

test('Turnstile is enforced only at PILOT and LIVE stages', () => {
  assert.equal(turnstileRequired(env({ WATCHDOG_STAGE: 'PREVIEW' })), false);
  assert.equal(turnstileRequired(env({ WATCHDOG_STAGE: 'TEST' })), false);
  assert.equal(turnstileRequired(env({ WATCHDOG_STAGE: 'PILOT' })), true);
  assert.equal(turnstileRequired(env({ WATCHDOG_STAGE: 'LIVE' })), true);
  assert.deepEqual(publicTurnstileConfig(env({ WATCHDOG_STAGE: 'TEST' })), { required: false, site_key: null });
});

test('unknown runtime stage fails closed and requires public protection', () => {
  assert.equal(turnstileRequired(env({ WATCHDOG_STAGE: 'LIV' })), true);
  assert.deepEqual(
    publicTurnstileConfig(env({ WATCHDOG_STAGE: 'LIV' })),
    { required: true, site_key: 'site_test' },
  );
});

test('missing Turnstile configuration fails closed in protected stages', async () => {
  await assert.rejects(
    requireTurnstile(new Request('https://builtegrity.com/pay/'), env({ TURNSTILE_SECRET_KEY: '' }), 'token'),
    (error) => error.status === 503,
  );
});

test('missing Turnstile token is rejected in protected stages', async () => {
  await assert.rejects(
    requireTurnstile(new Request('https://builtegrity.com/pay/'), env(), ''),
    (error) => error.status === 403,
  );
});

test('valid Turnstile token must match action and Builtegrity hostname', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      success: true,
      action: 'payment_consent',
      hostname: 'builtegrity.com',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const request = new Request('https://builtegrity.com/api/payments/token/consent', {
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    });
    const result = await requireTurnstile(request, env(), 'verified-token');
    assert.equal(result.success, true);
    assert.equal(captured.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const body = new URLSearchParams(captured.init.body);
    assert.equal(body.get('secret'), 'secret_test');
    assert.equal(body.get('response'), 'verified-token');
    assert.equal(body.get('remoteip'), '203.0.113.7');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('successful Turnstile response with the wrong action is rejected', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    action: 'different_action',
    hostname: 'builtegrity.com',
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    await assert.rejects(
      requireTurnstile(new Request('https://builtegrity.com/pay/'), env(), 'verified-token'),
      (error) => error.status === 403,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
