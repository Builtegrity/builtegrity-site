export async function authenticateClerkSession(request, env) {
  const token = readSessionToken(request);
  if (!token) return null;
  if (!env.CLERK_JWT_KEY || !env.CLERK_ISSUER) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (!header || !payload || header.alg !== 'RS256') return null;

  const verified = await verifyRs256(
    `${encodedHeader}.${encodedPayload}`,
    encodedSignature,
    env.CLERK_JWT_KEY,
  );
  if (!verified) return null;

  // Builtegrity accepts Clerk session tokens here, not arbitrary Clerk-signed JWT templates.
  // Clerk session tokens have a user subject, session ID and expiration claim.
  if (!String(payload.sub || '').trim() || !String(payload.sid || '').trim()) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) return null;
  if (payload.nbf !== undefined && payload.nbf !== null) {
    const nbf = Number(payload.nbf);
    if (!Number.isFinite(nbf) || nbf > now + 30) return null;
  }
  if (String(payload.iss || '') !== String(env.CLERK_ISSUER || '')) return null;

  const allowedParties = splitCsv(env.CLERK_AUTHORIZED_PARTIES);
  // Clerk documents azp as optional when the originating request had no Origin.
  if (payload.azp && allowedParties.length && !allowedParties.includes(String(payload.azp))) {
    return null;
  }

  return {
    sub: String(payload.sub),
    session_id: String(payload.sid),
    role: null,
    provider: 'CLERK',
    expires_at: new Date(exp * 1000).toISOString(),
    claims: payload,
  };
}

export async function authenticateClerkOperator(request, env) {
  const principal = await authenticateClerkSession(request, env);
  if (!principal?.sub) return null;

  const allowedAdmins = splitCsv(env.CLERK_ADMIN_USER_IDS);
  if (!allowedAdmins.includes(principal.sub)) return null;

  return {
    ...principal,
    role: 'OWNER',
  };
}

function readSessionToken(request) {
  const bearer = String(request.headers.get('authorization') || '');
  if (bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();

  const cookies = String(request.headers.get('cookie') || '').split(';');
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name === '__session') return rest.join('=');
  }
  return null;
}

async function verifyRs256(signingInput, encodedSignature, pem) {
  try {
    const keyBytes = pemToDer(String(pem));
    const key = await crypto.subtle.importKey(
      'spki',
      keyBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlDecode(encodedSignature),
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return false;
  }
}

function pemToDer(pem) {
  const normalized = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(value) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
  } catch {
    return null;
  }
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
