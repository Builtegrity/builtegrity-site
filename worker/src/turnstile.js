const ENFORCED_STAGES = new Set(['PILOT', 'LIVE']);
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

export const TURNSTILE_ACTIONS = Object.freeze({
  CONSENT: 'payment_consent',
  CHECKOUT: 'payment_checkout',
});

export function publicTurnstileConfig(env) {
  const stage = releaseStage(env);
  const required = ENFORCED_STAGES.has(stage);
  return {
    required,
    site_key: required ? String(env.TURNSTILE_SITE_KEY || '').trim() || null : null,
  };
}

export async function verifyPublicMutationChallenge(request, env, token, expectedAction) {
  const stage = releaseStage(env);
  if (stage === 'INVALID') throw httpError(503, 'Public mutation protection is unavailable because the release stage is invalid.');
  if (!ENFORCED_STAGES.has(stage)) return { verified: false, skipped: true, stage };

  const secret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const allowedHostnames = hostnameAllowlist(env);
  if (!secret || !siteKey || allowedHostnames.size === 0) {
    throw httpError(503, 'Public mutation protection is not fully configured.');
  }

  const responseToken = String(token || '').trim();
  if (!responseToken || responseToken.length > MAX_TOKEN_LENGTH) {
    throw httpError(403, 'Security verification is required before continuing.');
  }

  let response;
  let outcome;
  try {
    const body = new URLSearchParams({
      secret,
      response: responseToken,
    });
    const remoteIp = String(request.headers.get('CF-Connecting-IP') || '').trim();
    if (remoteIp) body.set('remoteip', remoteIp);

    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Siteverify HTTP ${response.status}`);
    outcome = await response.json();
  } catch (error) {
    console.error('Turnstile Siteverify request failed', String(error?.message || error));
    throw httpError(503, 'Security verification is temporarily unavailable.');
  }

  if (!outcome?.success) throw httpError(403, 'Security verification failed or expired. Please try again.');
  if (String(outcome.action || '') !== String(expectedAction || '')) {
    throw httpError(403, 'Security verification did not match this action. Please try again.');
  }
  if (!allowedHostnames.has(String(outcome.hostname || '').toLowerCase())) {
    throw httpError(403, 'Security verification did not match this site. Please try again.');
  }

  return {
    verified: true,
    skipped: false,
    stage,
    action: String(outcome.action || ''),
    hostname: String(outcome.hostname || ''),
    challenge_ts: outcome.challenge_ts || null,
  };
}

function hostnameAllowlist(env) {
  return new Set(
    String(env.TURNSTILE_ALLOWED_HOSTNAMES || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function releaseStage(env) {
  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').trim().toUpperCase();
  return ['PREVIEW', 'TEST', 'PILOT', 'LIVE'].includes(stage) ? stage : 'INVALID';
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
