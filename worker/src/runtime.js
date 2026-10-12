import core from './index.js';
import {
  buildStripeOAuthUrl,
  deauthorizeStripeAccount,
  exchangeStripeOAuthCode,
} from './stripe-oauth.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/stripe/oauth/callback' && request.method === 'GET') {
        return handleOAuthCallback(url, env);
      }

      const connectMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/connect-url$/);
      if (connectMatch && request.method === 'POST') {
        requireInternal(request, env);
        return handleConnectUrl(env, connectMatch[1]);
      }

      const disconnectMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/disconnect$/);
      if (disconnectMatch && request.method === 'POST') {
        requireInternal(request, env);
        return handleDisconnect(env, disconnectMatch[1]);
      }

      return core.fetch(request, env, ctx);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Internal error' }, error.status || 500);
    }
  },
};

async function handleConnectUrl(env, merchantId) {
  const merchant = await env.DB.prepare(`SELECT id, email FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);

  const stateToken = randomToken();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO stripe_oauth_states (state_token, merchant_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(stateToken, merchantId, expiresAt).run();

  return json({
    merchant_id: merchantId,
    authorize_url: buildStripeOAuthUrl(env, stateToken),
    expires_at: expiresAt,
  });
}

async function handleOAuthCallback(url, env) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  const oauthDescription = url.searchParams.get('error_description');

  if (!state) return new Response('Missing Stripe OAuth state.', { status: 400 });

  const stateRow = await env.DB.prepare(`
    SELECT * FROM stripe_oauth_states
    WHERE state_token = ?
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `).bind(state).first();

  if (!stateRow) return new Response('Stripe connection state is invalid or expired.', { status: 400 });

  if (oauthError) {
    await env.DB.prepare(`UPDATE stripe_oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_token = ?`).bind(state).run();
    return redirectToConsole(env, {
      stripe: 'denied',
      merchant: stateRow.merchant_id,
      reason: oauthDescription || oauthError,
    });
  }

  if (!code) return new Response('Missing Stripe authorization code.', { status: 400 });

  const result = await exchangeStripeOAuthCode(env, code);
  await env.DB.prepare(`
    UPDATE stripe_oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_token = ?
  `).bind(state).run();

  await env.DB.prepare(`
    UPDATE merchants
       SET processor_account_id = ?,
           integration_mode = 'STRIPE_CONNECT',
           status = 'TEST',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(result.stripe_user_id, stateRow.merchant_id).run();

  return redirectToConsole(env, {
    stripe: 'connected',
    merchant: stateRow.merchant_id,
  });
}

async function handleDisconnect(env, merchantId) {
  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);
  if (!merchant.processor_account_id) return json({ disconnected: true, already_disconnected: true });

  const result = await deauthorizeStripeAccount(env, merchant.processor_account_id);
  await env.DB.prepare(`
    UPDATE merchants
       SET processor_account_id = NULL,
           status = 'DISCONNECTED',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(merchantId).run();

  return json({ disconnected: true, stripe_user_id: result.stripe_user_id || null });
}

function redirectToConsole(env, values) {
  const base = String(env.APP_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
  const target = new URL(`${base}/console/`);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  return Response.redirect(target.toString(), 302);
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

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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
