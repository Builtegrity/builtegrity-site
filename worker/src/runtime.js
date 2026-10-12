import core from './index.js';
import { authProvider, handleAuthRoute, requireOperator } from './auth.js';
import {
  buildStripeOAuthUrl,
  deauthorizeStripeAccount,
  exchangeStripeOAuthCode,
} from './stripe-oauth.js';
import { getWatchdogStatus, runWatchdogs } from './watchdogs.js';
import { systemReadiness } from './readiness.js';
import { createTransactionRequest } from './transaction-create.js';
import { verifyMerchantStripe } from './merchant-stripe.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (isAdminSurface(path) && !isAdminHost(url, env)) {
        return new Response('Not found', { status: 404 });
      }

      if (isAdminSurface(path) && isStateChanging(request.method)) {
        requireSameOriginBrowserRequest(request, url);
      }

      if (path === '/api/health/ready' && request.method === 'GET') {
        const readiness = await systemReadiness(env);
        return json({
          ok: readiness.ok,
          service: 'builtegrity-transaction-engine',
          stage: readiness.stage,
          database: readiness.database,
          schema_ready: readiness.schema_ready,
          config_complete: readiness.config_complete,
          missing_config_count: readiness.missing_config_count,
          watchdog_healthy: readiness.watchdog_healthy,
          watchdog_fresh: readiness.watchdog_fresh,
          watchdog_age_minutes: readiness.watchdog_age_minutes,
          last_watchdog: readiness.last_watchdog,
        }, readiness.ok ? 200 : 503);
      }

      const authResponse = await handleAuthRoute(request, env);
      if (authResponse) return authResponse;

      if (path === '/api/stripe/oauth/callback' && request.method === 'GET') {
        return handleOAuthCallback(url, env);
      }

      const connectMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/connect-url$/);
      if (connectMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return handleConnectUrl(env, connectMatch[1]);
      }

      const verifyMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/verify$/);
      if (verifyMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return verifyMerchantStripe(env, verifyMatch[1]);
      }

      const disconnectMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/disconnect$/);
      if (disconnectMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return handleDisconnect(env, disconnectMatch[1]);
      }

      if (path === '/api/transactions' && request.method === 'POST') {
        await requireOperator(request, env);
        return createTransactionRequest(request, env);
      }

      if (path === '/api/watchdogs/status' && request.method === 'GET') {
        await requireOperator(request, env);
        const status = await getWatchdogStatus(env);
        status.readiness = await systemReadiness(env);
        return json(status);
      }

      if (path === '/api/watchdogs/run' && request.method === 'POST') {
        await requireOperator(request, env);
        requireSameOriginBrowserRequest(request, url);
        return json(await runWatchdogs(env, { kind: 'MANUAL', trigger: 'operator' }));
      }

      if (path.startsWith('/console')) {
        const principal = await requireOperatorOrRedirect(request, env, url);
        if (principal instanceof Response) return principal;
        return env.ASSETS.fetch(request);
      }

      if (isInternalApi(path)) {
        await requireOperator(request, env);
        return forwardAuthenticatedToCore(request, env, ctx);
      }

      return core.fetch(request, env, ctx);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Internal error' }, error.status || 500);
    }
  },

  async scheduled(controller, env) {
    const kind = controller.cron === '17 13 * * *' ? 'DEEP' : 'FAST';
    const result = await runWatchdogs(env, { kind, trigger: controller.cron || 'cron' });
    console.log('Builtegrity watchdog run', result);
    if (result.status === 'FAIL') {
      throw new Error(`Builtegrity watchdog detected ${result.critical} critical alert(s)`);
    }
  },
};

function isInternalApi(path) {
  if (!path.startsWith('/api/')) return false;
  if (path.startsWith('/api/health')) return false;
  if (path === '/api/webhooks/stripe') return false;
  if (path.startsWith('/api/payments/')) return false;
  if (path === '/api/stripe/oauth/callback') return false;
  return true;
}

function isAdminSurface(path) {
  return path === '/login' ||
    path.startsWith('/login/') ||
    path.startsWith('/console') ||
    path.startsWith('/auth/') ||
    isInternalApi(path);
}

function isAdminHost(url, env) {
  const hostname = url.hostname.toLowerCase();
  const localDevelopmentHost = hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';

  if (env.DEV_MODE === 'true' && localDevelopmentHost) return true;

  const configured = String(env.ADMIN_HOSTNAME || '').trim().toLowerCase();
  if (!configured) return env.DEV_MODE === 'true';
  return hostname === configured;
}

function isStateChanging(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase());
}

function requireSameOriginBrowserRequest(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    const error = new Error('Cross-origin admin request rejected');
    error.status = 403;
    throw error;
  }

  const fetchSite = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    const error = new Error('Cross-site admin request rejected');
    error.status = 403;
    throw error;
  }
}

async function forwardAuthenticatedToCore(request, env, ctx) {
  const bridgeToken = randomToken();
  const headers = new Headers(request.headers);
  headers.set('X-Builtegrity-Admin', bridgeToken);
  const forwarded = new Request(request, { headers });
  const internalEnv = { ...env, INTERNAL_ADMIN_TOKEN: bridgeToken };
  return core.fetch(forwarded, internalEnv, ctx);
}

async function requireOperatorOrRedirect(request, env, url) {
  try {
    return await requireOperator(request, env);
  } catch (error) {
    if (error.status !== 401) throw error;
    if (authProvider(env) === 'CLOUDFLARE_ACCESS') {
      return new Response('Cloudflare Access authentication required', { status: 403 });
    }
    const login = new URL('/login/', url.origin);
    login.searchParams.set('return_to', `${url.pathname}${url.search}`);
    return Response.redirect(login.toString(), 302);
  }
}

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
  const alreadyBound = await env.DB.prepare(`
    SELECT id FROM merchants WHERE processor_account_id = ? LIMIT 1
  `).bind(result.stripe_user_id).first();

  if (alreadyBound && alreadyBound.id !== stateRow.merchant_id) {
    await env.DB.prepare(`
      UPDATE stripe_oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_token = ?
    `).bind(state).run();
    return redirectToConsole(env, {
      stripe: 'already_connected',
      merchant: stateRow.merchant_id,
      reason: 'That Stripe account is already attached to another Builtegrity merchant record.',
    });
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE merchants
           SET processor_account_id = ?,
               integration_mode = 'STRIPE_CONNECT',
               status = 'TEST',
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).bind(result.stripe_user_id, stateRow.merchant_id),
      env.DB.prepare(`
        UPDATE stripe_oauth_states
           SET consumed_at = CURRENT_TIMESTAMP
         WHERE state_token = ? AND consumed_at IS NULL
      `).bind(state),
    ]);
  } catch (error) {
    if (!alreadyBound) {
      try {
        await deauthorizeStripeAccount(env, result.stripe_user_id);
      } catch (rollbackError) {
        console.error('Stripe OAuth rollback failed after D1 persistence failure', rollbackError);
        error.message = `${error.message || 'Stripe OAuth persistence failed'}; Stripe rollback also failed and requires manual review`;
      }
    }
    throw error;
  }

  return redirectToConsole(env, {
    stripe: 'connected',
    merchant: stateRow.merchant_id,
  });
}

async function handleDisconnect(env, merchantId) {
  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);
  if (!merchant.processor_account_id) return json({ disconnected: true, already_disconnected: true });

  const priorStatus = merchant.status;
  await env.DB.prepare(`
    UPDATE merchants
       SET status = 'PAUSED', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(merchantId).run();

  let result;
  try {
    result = await deauthorizeStripeAccount(env, merchant.processor_account_id);
  } catch (error) {
    try {
      await env.DB.prepare(`
        UPDATE merchants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(priorStatus, merchantId).run();
    } catch (restoreError) {
      console.error('Failed to restore merchant status after Stripe disconnect failure', restoreError);
      error.message = `${error.message || 'Stripe disconnect failed'}; merchant remains fail-closed and requires manual review`;
    }
    throw error;
  }

  try {
    await env.DB.prepare(`
      UPDATE merchants
         SET processor_account_id = NULL,
             status = 'DISCONNECTED',
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(merchantId).run();
  } catch (error) {
    error.message = `${error.message || 'Stripe disconnected but Builtegrity state update failed'}; merchant was paused before deauthorization and requires manual reconciliation`;
    throw error;
  }

  return json({ disconnected: true, stripe_user_id: result.stripe_user_id || null });
}

function redirectToConsole(env, values) {
  const base = String(env.ADMIN_BASE_URL || env.APP_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
  const target = new URL(`${base}/console/`);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  return Response.redirect(target.toString(), 302);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
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
