import { isKnownWatchdogStage, watchdogStage } from './readiness.js';

const PROTECTED_STAGES = new Set(['PILOT', 'LIVE']);
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileRequired(env) {
  const stage = watchdogStage(env);
  // An unknown runtime stage must never silently downgrade public protection.
  if (!isKnownWatchdogStage(stage)) return true;
  return PROTECTED_STAGES.has(stage);
}

export function publicTurnstileConfig(env) {
  const required = turnstileRequired(env);
  return {
    required,
    site_key: required ? String(env.TURNSTILE_SITE_KEY || '') : null,
  };
}

export async function requireTurnstile(request, env, responseToken, expectedAction = 'payment_consent') {
  if (!turnstileRequired(env)) return { success: true, skipped: true };
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    const error = new Error('Public abuse protection is not configured');
    error.status = 503;
    throw error;
  }

  const token = String(responseToken || '').trim();
  if (!token) {
    const error = new Error('Security verification is required');
    error.status = 403;
    throw error;
  }
  if (token.length > 2048) {
    const error = new Error('Security verification token is invalid');
    error.status = 403;
    throw error;
  }

  const form = new URLSearchParams({
    secret: String(env.TURNSTILE_SECRET_KEY),
    response: token,
  });
  const remoteIp = String(request.headers.get('CF-Connecting-IP') || '').trim();
  if (remoteIp) form.set('remoteip', remoteIp);

  let response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (cause) {
    const error = new Error('Security verification service is unavailable');
    error.status = 503;
    error.cause = cause;
    throw error;
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Security verification service returned HTTP ${response.status}`);
    error.status = 503;
    throw error;
  }
  if (result.success !== true) {
    const error = new Error('Security verification failed. Please complete the challenge again.');
    error.status = 403;
    error.turnstile_codes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
    throw error;
  }

  if (expectedAction && String(result.action || '') !== expectedAction) {
    const error = new Error('Security verification action did not match this payment step');
    error.status = 403;
    throw error;
  }

  const expectedHostname = appHostname(env.APP_BASE_URL);
  if (expectedHostname && result.hostname && String(result.hostname).toLowerCase() !== expectedHostname) {
    const error = new Error('Security verification hostname did not match Builtegrity');
    error.status = 403;
    throw error;
  }

  return result;
}

function appHostname(value) {
  try {
    return value ? new URL(String(value)).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
