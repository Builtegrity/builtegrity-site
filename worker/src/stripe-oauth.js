import { assertStripeEnvironment } from './launch-assurance.js';

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required Stripe configuration: ${name}`);
  return value;
}

export function stripeOAuthRedirectUri(env) {
  const baseUrl = requireEnv(env, 'APP_BASE_URL').replace(/\/$/, '');
  return `${baseUrl}/api/stripe/oauth/callback`;
}

export function buildStripeOAuthUrl(env, stateToken) {
  const clientId = requireEnv(env, 'STRIPE_CONNECT_CLIENT_ID');
  const redirectUri = stripeOAuthRedirectUri(env);
  const url = new URL('https://connect.stripe.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', stateToken);
  return url.toString();
}

export async function exchangeStripeOAuthCode(env, code) {
  assertStripeEnvironment(env);
  const secret = requireEnv(env, 'STRIPE_SECRET_KEY');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
  });

  const response = await fetch('https://connect.stripe.com/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${secret}:`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.error || `Stripe OAuth error ${response.status}`);
    error.status = 400;
    throw error;
  }
  if (!payload.stripe_user_id) throw new Error('Stripe OAuth response did not include stripe_user_id');
  return payload;
}

export async function deauthorizeStripeAccount(env, stripeUserId) {
  assertStripeEnvironment(env);
  const secret = requireEnv(env, 'STRIPE_SECRET_KEY');
  const clientId = requireEnv(env, 'STRIPE_CONNECT_CLIENT_ID');
  const body = new URLSearchParams({ client_id: clientId, stripe_user_id: stripeUserId });
  const response = await fetch('https://connect.stripe.com/oauth/deauthorize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.error || 'Stripe deauthorization failed');
  return payload;
}
