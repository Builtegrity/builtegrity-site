import { requireReleasePlatformControl } from './release-controls.js';
import {
  publicTurnstileConfig,
  TURNSTILE_ACTIONS,
  verifyPublicMutationChallenge,
} from './turnstile.js';

export async function handlePublicSecurityRoute(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/payments/config' && request.method === 'GET') {
    return json({ turnstile: publicTurnstileConfig(env) });
  }

  const consentMatch = path.match(/^\/api\/payments\/[^/]+\/consent$/);
  if (consentMatch && request.method === 'POST') {
    const body = await request.clone().json().catch(() => ({}));
    await verifyPublicMutationChallenge(request, env, body.turnstile_token, TURNSTILE_ACTIONS.CONSENT);
    return null;
  }

  const checkoutMatch = path.match(/^\/api\/payments\/[^/]+\/checkout$/);
  if (checkoutMatch && request.method === 'POST') {
    const body = await request.clone().json().catch(() => ({}));
    await verifyPublicMutationChallenge(request, env, body.turnstile_token, TURNSTILE_ACTIONS.CHECKOUT);
    await requireReleasePlatformControl(env, 'payment_creation_enabled', 'New payment creation');
    return null;
  }

  return null;
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
