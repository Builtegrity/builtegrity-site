import { authenticateClerkSession } from './clerk-auth.js';
import { requireMerchantMembership } from './authorization.js';
import {
  getMerchantComplianceStatus,
  recordMerchantLegalAcceptances,
} from './legal-compliance.js';

export async function handleMerchantComplianceRoute(request, env) {
  const url = new URL(request.url);
  const statusMatch = url.pathname.match(/^\/api\/merchant\/merchants\/(MER-[A-Za-z0-9-]+)\/compliance$/);
  const acceptMatch = url.pathname.match(/^\/api\/merchant\/merchants\/(MER-[A-Za-z0-9-]+)\/legal-acceptance$/);
  if (!statusMatch && !acceptMatch) return null;

  const principal = await authenticateClerkSession(request, env);
  if (!principal?.sub) return json({ error: 'Merchant authentication required' }, 401);
  const merchantId = (statusMatch || acceptMatch)[1];

  if (statusMatch && request.method === 'GET') {
    await requireMerchantMembership(env, principal, merchantId, 'VIEWER');
    return json(await getMerchantComplianceStatus(env, merchantId));
  }

  if (acceptMatch && request.method === 'POST') {
    requireSameOrigin(request, url);
    await requireMerchantMembership(env, principal, merchantId, 'ADMIN');
    const body = await readJson(request);
    const result = await recordMerchantLegalAcceptances(
      env,
      merchantId,
      principal.sub,
      body,
      {
        // Raw network/browser evidence is never persisted. legal-compliance.js salts and
        // hashes these values before the immutable acceptance row is written.
        ip: request.headers.get('CF-Connecting-IP') || '',
        userAgent: request.headers.get('User-Agent') || '',
      },
    );
    return json(result, 201);
  }

  return json({ error: 'Method not allowed' }, 405, { Allow: statusMatch ? 'GET' : 'POST' });
}

function requireSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw statusError('Cross-origin merchant compliance request rejected', 403);
  const fetchSite = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  if (fetchSite === 'cross-site') throw statusError('Cross-site merchant compliance request rejected', 403);
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw statusError('Invalid JSON request body', 400); }
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}
