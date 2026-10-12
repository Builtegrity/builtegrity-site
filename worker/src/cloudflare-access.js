let cachedJwks = null;
let cachedAt = 0;
const JWKS_TTL_MS = 5 * 60 * 1000;

export async function authenticateCloudflareAccess(request, env) {
  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = String(env.CF_ACCESS_AUD || '').trim();
  if (!teamDomain || !audience) return null;

  const token = request.headers.get('Cf-Access-Jwt-Assertion') || request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || !header.kid) return null;
  if (payload.iss !== teamDomain) return null;
  if (!audienceMatches(payload.aud, audience)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || Number(payload.exp) <= now) return null;
  if (payload.nbf && Number(payload.nbf) > now) return null;

  const jwk = await getJwk(teamDomain, header.kid);
  if (!jwk) return null;

  let key;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return null;
  }

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) return null;

  const email = String(payload.email || '').trim().toLowerCase();
  const allowlist = allowedEmails(env);
  if (allowlist.length && (!email || !allowlist.includes(email))) return null;

  return {
    sub: payload.sub || email || 'cloudflare-access-user',
    email: email || null,
    role: 'OWNER',
    provider: 'CLOUDFLARE_ACCESS',
    expires_at: new Date(Number(payload.exp) * 1000).toISOString(),
  };
}

async function getJwk(teamDomain, kid) {
  const jwks = await getJwks(teamDomain);
  return Array.isArray(jwks?.keys) ? jwks.keys.find((key) => key.kid === kid) || null : null;
}

async function getJwks(teamDomain) {
  if (cachedJwks && Date.now() - cachedAt < JWKS_TTL_MS && cachedJwks.teamDomain === teamDomain) {
    return cachedJwks.value;
  }

  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Unable to load Cloudflare Access signing keys (${response.status})`);
  const value = await response.json();
  cachedJwks = { teamDomain, value };
  cachedAt = Date.now();
  return value;
}

function normalizeTeamDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function audienceMatches(actual, expected) {
  if (Array.isArray(actual)) return actual.includes(expected);
  return String(actual || '') === expected;
}

function allowedEmails(env) {
  return String(env.CF_ACCESS_ALLOWED_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
