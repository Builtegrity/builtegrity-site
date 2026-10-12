import { authenticateClerkOperator } from './clerk-auth.js';
import { authenticateCloudflareAccess } from './cloudflare-access.js';

const COOKIE_NAME = 'builtegrity_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 12;

export async function handleAuthRoute(request, env) {
  const url = new URL(request.url);
  const provider = authProvider(env);

  if (url.pathname === '/auth/session' && request.method === 'GET') {
    const principal = await authenticateOperator(request, env);
    return principal
      ? json({ authenticated: true, principal })
      : json({ authenticated: false }, 401);
  }

  if (url.pathname === '/auth/login' && request.method === 'GET' && provider === 'CLERK') {
    if (!env.CLERK_SIGN_IN_URL) return json({ error: 'Clerk sign-in URL is not configured' }, 503);
    const returnTo = safeReturnTo(url.searchParams.get('return_to'));
    const redirect = new URL(String(env.CLERK_SIGN_IN_URL));
    redirect.searchParams.set('redirect_url', new URL(returnTo, url.origin).toString());
    return Response.redirect(redirect.toString(), 302);
  }

  if (url.pathname === '/auth/login' && request.method === 'POST') {
    if (provider === 'CLERK') {
      return json({ error: 'Clerk handles interactive sign-in. Use GET /auth/login.' }, 409);
    }
    if (provider === 'CLOUDFLARE_ACCESS') {
      return json({ error: 'Cloudflare Access handles interactive sign-in before Builtegrity receives the request.' }, 409);
    }
    if (provider !== 'OWNER_SESSION') {
      return json({ error: `Interactive login is unavailable for auth provider ${provider}` }, 409);
    }
    if (!env.OWNER_PASSWORD || !env.OWNER_SESSION_SECRET) {
      return json({ error: 'Owner authentication is not configured' }, 503);
    }

    const body = await request.json().catch(() => ({}));
    if (!timingSafeEqual(String(body.password || ''), String(env.OWNER_PASSWORD))) {
      return json({ error: 'Invalid credentials' }, 401);
    }

    const ttl = sessionTtl(env);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: 'owner',
      role: 'OWNER',
      provider: 'OWNER_SESSION',
      iat: now,
      exp: now + ttl,
      nonce: randomToken(16),
    };
    const token = await signSession(payload, env.OWNER_SESSION_SECRET);
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return new Response(JSON.stringify({ authenticated: true, principal: publicPrincipal(payload) }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl}${secure}`,
      },
    });
  }

  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    if (provider === 'CLERK') {
      return json({
        authenticated: false,
        redirect_url: env.CLERK_USER_URL || env.CLERK_SIGN_IN_URL || '/login/',
        note: 'Use Clerk Account Portal / ClerkJS to terminate the Clerk session.',
      });
    }
    if (provider === 'CLOUDFLARE_ACCESS') {
      return Response.redirect(`${url.origin}/cdn-cgi/access/logout`, 302);
    }

    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
      },
    });
  }

  return null;
}

export async function authenticateOperator(request, env) {
  const provider = authProvider(env);

  if (provider === 'CLERK') return authenticateClerkOperator(request, env);
  if (provider === 'CLOUDFLARE_ACCESS') return authenticateCloudflareAccess(request, env);

  if (provider === 'OWNER_SESSION') {
    if (!env.OWNER_SESSION_SECRET) return null;
    const token = readCookie(request.headers.get('cookie') || '', COOKIE_NAME);
    if (!token) return null;
    const payload = await verifySession(token, env.OWNER_SESSION_SECRET);
    if (!payload || payload.role !== 'OWNER') return null;
    return publicPrincipal(payload);
  }

  if (provider === 'DEV_BYPASS' && env.DEV_MODE === 'true') {
    return { sub: 'developer', role: 'OWNER', provider: 'DEV_BYPASS', expires_at: null };
  }

  return null;
}

export async function requireOperator(request, env) {
  const principal = await authenticateOperator(request, env);
  if (principal) return principal;
  const error = new Error('Unauthorized');
  error.status = 401;
  throw error;
}

export function authProvider(env) {
  return String(env.AUTH_PROVIDER || 'CLERK').trim().toUpperCase();
}

function safeReturnTo(value) {
  const candidate = String(value || '/console/');
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/console/';
  return candidate;
}

async function signSession(payload, secret) {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(encoded, secret);
  return `${encoded}.${signature}`;
}

async function verifySession(token, secret) {
  const [encoded, supplied] = String(token || '').split('.');
  if (!encoded || !supplied) return null;
  const expected = await hmac(encoded, secret);
  if (!timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || Number(payload.exp) <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function readCookie(cookieHeader, name) {
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function publicPrincipal(payload) {
  return {
    sub: payload.sub,
    email: payload.email || null,
    role: payload.role,
    provider: payload.provider,
    expires_at: payload.exp ? new Date(Number(payload.exp) * 1000).toISOString() : null,
  };
}

function sessionTtl(env) {
  const configured = Number(env.AUTH_SESSION_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  return Number.isFinite(configured) && configured >= 300 ? Math.floor(configured) : DEFAULT_TTL_SECONDS;
}

function randomToken(bytesLength = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
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
