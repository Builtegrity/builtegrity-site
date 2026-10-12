import core from './index.js';
import { authProvider, handleAuthRoute, requireOperator } from './auth.js';
import {
  buildStripeOAuthUrl,
  deauthorizeStripeAccount,
  exchangeStripeOAuthCode,
} from './stripe-oauth.js';
import { verifyStripeSignature } from './stripe.js';
import { processStripeWebhook } from './webhooks.js';
import { processStripeAccountWebhook } from './stripe-account-events.js';
import { getWatchdogStatus, runWatchdogs, systemReadiness } from './watchdogs.js';
import { handlePublicRecordRoute, serveOperatorTransactionPdf } from './records.js';
import {
  executeInternalCaseAction,
  getInternalCase,
  getInternalOperationsMetrics,
  listInternalCases,
  verifyInternalCase,
} from './cases.js';
import { syncInternalCasesFromWatchdogs } from './case-router.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Customer transaction records use unguessable Builtegrity-owned tokens.
      // They deliberately do not depend on Clerk users or Clerk Organizations.
      const publicRecordResponse = await handlePublicRecordRoute(request, env);
      if (publicRecordResponse) return publicRecordResponse;

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
          config_complete: readiness.config_complete,
          missing_config_count: readiness.missing_config_count,
          last_watchdog: readiness.last_watchdog,
        }, readiness.ok ? 200 : 503);
      }

      // Production webhook entrypoint. Account-level events are routed to merchant self-service;
      // transaction events continue through the transaction engine's idempotent processor.
      if (path === '/api/webhooks/stripe' && request.method === 'POST') {
        return handleRuntimeStripeWebhook(request, env);
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

      const disconnectMatch = path.match(/^\/api\/merchants\/(MER-[A-Za-z0-9-]+)\/stripe\/disconnect$/);
      if (disconnectMatch && request.method === 'POST') {
        await requireOperator(request, env);
        return handleDisconnect(env, disconnectMatch[1]);
      }

      const operatorPdfMatch = path.match(/^\/api\/transactions\/(TX-[A-Za-z0-9-]+)\/pdf$/);
      if (operatorPdfMatch && request.method === 'GET') {
        const principal = await requireOperator(request, env);
        return serveOperatorTransactionPdf(env, operatorPdfMatch[1], principal);
      }

      if (path === '/api/cases/metrics' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getInternalOperationsMetrics(env));
      }

      if (path === '/api/cases' && request.method === 'GET') {
        await requireOperator(request, env);
        return json({
          cases: await listInternalCases(env, {
            status: url.searchParams.get('status'),
            limit: url.searchParams.get('limit'),
          }),
        });
      }

      const caseMatch = path.match(/^\/api\/cases\/(CASE-[A-Za-z0-9-]+)$/);
      if (caseMatch && request.method === 'GET') {
        await requireOperator(request, env);
        const item = await getInternalCase(env, caseMatch[1]);
        return item ? json(item) : json({ error: 'Internal case not found' }, 404);
      }

      const caseActionMatch = path.match(/^\/api\/cases\/(CASE-[A-Za-z0-9-]+)\/actions\/([A-Z0-9_]+)$/);
      if (caseActionMatch && request.method === 'POST') {
        const principal = await requireOperator(request, env);
        const body = await readJson(request);
        const executed = await executeInternalCaseAction(env, caseActionMatch[1], caseActionMatch[2], principal, body);

        // Every operator action is verified by the machine; humans never decide that a technical alert is cleared.
        const watchdog = await runWatchdogs(env, { kind: 'FAST', trigger: `case:${caseActionMatch[1]}:${caseActionMatch[2]}` });
        const routing = await syncInternalCasesFromWatchdogs(env);
        const verified = await verifyInternalCase(env, caseActionMatch[1]);
        return json({ executed, watchdog, routing, case: verified });
      }

      if (path === '/api/watchdogs/status' && request.method === 'GET') {
        await requireOperator(request, env);
        return json(await getWatchdogStatus(env));
      }

      if (path === '/api/watchdogs/run' && request.method === 'POST') {
        await requireOperator(request, env);
        requireSameOriginBrowserRequest(request, url);
        const watchdog = await runWatchdogs(env, { kind: 'MANUAL', trigger: 'operator' });
        const routing = await syncInternalCasesFromWatchdogs(env);
        return json({ ...watchdog, case_routing: routing });
      }

      if (path.startsWith('/console')) {
        const principal = await requireOperatorOrRedirect(request, env, url);
        if (principal instanceof Response) return principal;
        return env.ASSETS.fetch(request);
      }

      // Catastrophic controls are enforced before requests enter the core engine.
      if (path === '/api/transactions' && request.method === 'POST') {
        await requireOperator(request, env);
        await requirePlatformControl(env, 'transaction_creation_enabled', 'New transaction creation');
        return forwardAuthenticatedToCore(request, env, ctx);
      }

      const publicCheckoutMatch = path.match(/^\/api\/payments\/[^/]+\/checkout$/);
      if (publicCheckoutMatch && request.method === 'POST') {
        await requirePlatformControl(env, 'payment_creation_enabled', 'New payment creation');
        return core.fetch(request, env, ctx);
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
    const routing = await syncInternalCasesFromWatchdogs(env);
    console.log('Builtegrity watchdog run', { ...result, case_routing: routing });
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
  if (path.startsWith('/api/records/')) return false;
  if (path === '/api/stripe/oauth/callback') return false;
  return true;
}

function isAdminSurface(path) {
  return path.startsWith('/console') ||
    path.startsWith('/auth/') ||
    isInternalApi(path);
}

function isAdminHost(url, env) {
  const configured = String(env.ADMIN_HOSTNAME || '').trim().toLowerCase();
  if (!configured) return env.DEV_MODE === 'true';
  return url.hostname.toLowerCase() === configured;
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

async function handleRuntimeStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Stripe webhook secret is not configured' }, 503);
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature');
  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'Invalid Stripe signature' }, 400);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const accountEvent = event.type === 'account.updated' || event.type === 'account.application.deauthorized';
  const result = accountEvent
    ? await processStripeAccountWebhook(env, event)
    : await processStripeWebhook(env, event);
  return json({ received: true, ...result });
}

async function handleConnectUrl(env, merchantId) {
  await requirePlatformControl(env, 'merchant_onboarding_enabled', 'Merchant onboarding');

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

  const controls = await env.DB.prepare(`SELECT merchant_onboarding_enabled FROM platform_controls WHERE id = 'GLOBAL'`).first().catch(() => null);
  const merchantStatus = controls && Number(controls.merchant_onboarding_enabled) !== 1 ? 'PAUSED' : 'TEST';

  await env.DB.prepare(`
    UPDATE merchants
       SET processor_account_id = ?,
           integration_mode = 'STRIPE_CONNECT',
           status = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(result.stripe_user_id, merchantStatus, stateRow.merchant_id).run();

  return redirectToConsole(env, {
    stripe: 'connected',
    merchant: stateRow.merchant_id,
    status: merchantStatus,
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
           stripe_charges_enabled = NULL,
           stripe_payouts_enabled = NULL,
           stripe_details_submitted = NULL,
           stripe_payout_interval = NULL,
           stripe_requirements_due_json = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(merchantId).run();

  return json({ disconnected: true, stripe_user_id: result.stripe_user_id || null });
}

async function requirePlatformControl(env, column, label) {
  const allowed = new Set(['transaction_creation_enabled', 'payment_creation_enabled', 'merchant_onboarding_enabled']);
  if (!allowed.has(column)) throw new Error(`Unknown platform control: ${column}`);
  const controls = await env.DB.prepare(`SELECT ${column} AS enabled, reason FROM platform_controls WHERE id = 'GLOBAL'`).first().catch(() => null);
  if (!controls || Number(controls.enabled) === 1) return;
  const error = new Error(`${label} is temporarily paused by Builtegrity safety controls${controls.reason ? `: ${controls.reason}` : ''}`);
  error.status = 503;
  throw error;
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
