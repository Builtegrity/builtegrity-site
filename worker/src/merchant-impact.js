import { authenticateClerkSession } from './clerk-auth.js';
import { requireMerchantMembership } from './authorization.js';

const CAUSES = ['REFORESTATION', 'CARBON_REMOVAL', 'COMMUNITY_RELIEF'];
const MODES = ['BPS', 'FLAT_CENTS'];
const MAX_BODY = 2048;
const ROUTE = /^\/api\/merchant\/impact(?:\/(merchants|ledger))?\/?$/;

function failure(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw failure('Cross-origin action rejected', 403);
  const site = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (site && !['same-origin', 'none'].includes(site)) throw failure('Cross-site action rejected', 403);
}

export function normalizeImpactPolicy(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('Valid impact settings are required');
  if (typeof data.enabled !== 'boolean') throw failure('Explicit enabled boolean is required');
  const cause_code = String(data.cause_code || '');
  const contribution_mode = String(data.contribution_mode || '');
  const contribution_value = data.contribution_value;
  if (!CAUSES.includes(cause_code)) throw failure('Select a supported impact cause');
  if (!MODES.includes(contribution_mode)) throw failure('Select percentage or flat contribution');
  if (!Number.isSafeInteger(contribution_value) || contribution_value < 1 ||
      (contribution_mode === 'BPS' ? contribution_value > 1000 : contribution_value > 100000)) {
    throw failure('Contribution must be 1–1000 basis points or 1–100000 cents');
  }
  return { enabled: data.enabled, cause_code, contribution_mode, contribution_value };
}

// Amounts remain integer cents, including BPS rounding. A partially refunded
// flat contribution is proportional to the unrefunded transaction amount.
export function calculateImpactCents({ originalCents, refundedCents = 0, mode, value }) {
  if (!Number.isSafeInteger(originalCents) || originalCents <= 0) throw failure('Invalid transaction amount');
  if (!Number.isSafeInteger(refundedCents) || refundedCents < 0) throw failure('Invalid cumulative refunds');
  if (!Number.isSafeInteger(value) || value <= 0) throw failure('Invalid impact contribution rule');
  if (!MODES.includes(mode)) throw failure('Unknown impact contribution mode');
  const net = Math.max(0, originalCents - Math.min(originalCents, refundedCents));
  const cents = mode === 'BPS'
    ? Math.round(net * value / 10000)
    : Math.round(value * net / originalCents);
  if (!Number.isSafeInteger(cents)) throw failure('Impact calculation exceeds safe integer precision');
  return { eligible_amount_cents: net, commitment_cents: cents };
}

async function readSettings(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw failure('Settings request is too large', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY) throw failure('Settings request is too large', 413);
  try { return JSON.parse(raw); } catch { throw failure('Valid JSON required'); }
}

function requireMerchantId(raw) {
  const id = String(raw || '');
  if (!/^MER-[A-Za-z0-9-]+$/.test(id)) throw failure('Select a valid merchant');
  return id;
}

async function currentPolicy(env, merchantId) {
  return env.DB.prepare(
    'SELECT id,enabled,cause_code,contribution_mode,contribution_value,effective_at FROM merchant_impact_policies WHERE merchant_id=? AND ended_at IS NULL LIMIT 1'
  ).bind(merchantId).first();
}

async function summary(env, merchantId) {
  const sums = await env.DB.prepare(
    'SELECT COUNT(*) AS transactions,COALESCE(SUM(v.commitment_cents),0) AS committed_cents FROM merchant_impact_commitments c JOIN merchant_impact_current_valuations v ON v.transaction_id=c.transaction_id WHERE c.merchant_id=?'
  ).bind(merchantId).first();
  const funded = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS funded_cents FROM merchant_impact_funding_receipts WHERE merchant_id=?'
  ).bind(merchantId).first();
  return { transactions: Number(sums?.transactions || 0),
    tracked_commitment_cents: Number(sums?.committed_cents || 0),
    verified_funded_cents: Number(funded?.funded_cents || 0),
    currency: 'USD' };
}

export async function handleMerchantImpactRoute(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if (!match) return null;
  const segment = match[1] || 'settings';
  const allowed = segment === 'settings' ? ['GET', 'PUT'] : ['GET'];
  if (!allowed.includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: allowed.join(', ') });
  if (request.method === 'PUT') sameOrigin(request);
  const principal = await authenticateClerkSession(request, env);
  if (!principal?.sub || principal.claims?.act) return json({ error: 'Merchant sign-in required' }, 401);

  if (segment === 'merchants') {
    const rows = await env.DB.prepare(
      "SELECT m.id,m.name,a.role FROM merchant_access a JOIN merchants m ON m.id=a.merchant_id WHERE a.external_user_id=? AND a.status='ACTIVE' ORDER BY m.name LIMIT 100"
    ).bind(principal.sub).all();
    return json({ merchants: rows.results || [] });
  }

  let submitted = null;
  if (request.method === 'PUT') submitted = await readSettings(request);
  const merchantId = requireMerchantId(request.method === 'PUT' ? submitted?.merchant_id : url.searchParams.get('merchant_id'));
  await requireMerchantMembership(env, principal, merchantId, request.method === 'PUT' ? 'ADMIN' : 'VIEWER');

  if (request.method === 'PUT') {
    const policy = normalizeImpactPolicy(submitted);
    const before = await currentPolicy(env, merchantId);
    if (before && Number(before.enabled) === Number(policy.enabled) &&
        before.cause_code === policy.cause_code &&
        before.contribution_mode === policy.contribution_mode &&
        Number(before.contribution_value) === policy.contribution_value) {
      return json({ merchant_id: merchantId, changed: false, policy: before, tracking_active: env.IMPACT_RECONCILIATION_ENABLED === 'true' });
    }
    const id = 'IMPACT-POL-' + crypto.randomUUID();
    // D1 batch executes atomically: at most one currently effective policy.
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE merchant_impact_policies SET ended_at=CURRENT_TIMESTAMP WHERE merchant_id=? AND ended_at IS NULL'
      ).bind(merchantId),
      env.DB.prepare(
        'INSERT INTO merchant_impact_policies (id,merchant_id,enabled,cause_code,contribution_mode,contribution_value,created_by) VALUES (?,?,?,?,?,?,?)'
      ).bind(id,merchantId,policy.enabled ? 1 : 0,policy.cause_code,policy.contribution_mode,policy.contribution_value,principal.sub),
    ]);
    return json({ merchant_id: merchantId, changed: true, policy: await currentPolicy(env, merchantId),
      tracking_active: env.IMPACT_RECONCILIATION_ENABLED === 'true' });
  }

  if (segment === 'ledger') {
    const rows = await env.DB.prepare(
      'SELECT c.transaction_id,c.payment_at,p.cause_code,c.transaction_amount_cents,v.cumulative_refunded_cents,v.eligible_amount_cents,v.commitment_cents,v.calculated_at FROM merchant_impact_commitments c JOIN merchant_impact_policies p ON p.id=c.policy_id JOIN merchant_impact_current_valuations v ON v.transaction_id=c.transaction_id WHERE c.merchant_id=? ORDER BY c.payment_at DESC,c.transaction_id DESC LIMIT 50'
    ).bind(merchantId).all();
    return json({ merchant_id: merchantId, entries: rows.results || [], funding_status: 'NOT_AUTOMATED' });
  }

  return json({ merchant_id: merchantId,
    policy: await currentPolicy(env, merchantId),
    summary: await summary(env, merchantId),
    tracking_active: env.IMPACT_RECONCILIATION_ENABLED === 'true',
    funding_status: 'NOT_AUTOMATED',
    available_causes: CAUSES });
}

// Bounded, replay-safe sweep of paid transactions. Reads transaction facts only;
// intentionally never modifies transactions, platform fee ledgers or checkout.
export async function reconcileMerchantImpact(env, { limit = 100 } = {}) {
  if (env.IMPACT_RECONCILIATION_ENABLED !== 'true') return { enabled: false, commitments: 0, valuations: 0 };
  const batchLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const candidates = await env.DB.prepare(
    "SELECT t.id,t.merchant_id,t.amount_cents,t.payment_at,t.refunded_cents,p.id AS policy_id " +
    "FROM transactions t JOIN merchant_impact_policies p ON p.merchant_id=t.merchant_id " +
    "AND p.enabled=1 AND datetime(t.payment_at)>=datetime(p.effective_at) " +
    "AND (p.ended_at IS NULL OR datetime(t.payment_at)<datetime(p.ended_at)) " +
    "WHERE t.currency='USD' AND t.payment_at IS NOT NULL AND t.customer_paid_cents>0 " +
    "AND LOWER(COALESCE(t.payment_status,'')) IN ('succeeded','paid','partially_refunded','refunded') " +
    "AND NOT EXISTS (SELECT 1 FROM merchant_impact_commitments c WHERE c.transaction_id=t.id) " +
    "ORDER BY t.payment_at ASC,t.id ASC LIMIT ?"
  ).bind(batchLimit).all();
  let commitments = 0;
  for (const tx of candidates.results || []) {
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO merchant_impact_commitments (transaction_id,merchant_id,policy_id,transaction_amount_cents,payment_at) VALUES (?,?,?,?,?)'
    ).bind(tx.id,tx.merchant_id,tx.policy_id,tx.amount_cents,tx.payment_at).run();
    commitments += Number(inserted.meta?.changes || 0);
  }

  // This includes new commitments and refund revisions. Each (transaction,
  // cumulative refund) is unique. The latest cumulative refund is authoritative.
  const pending = await env.DB.prepare(
    "SELECT c.transaction_id,c.transaction_amount_cents,p.contribution_mode,p.contribution_value," +
    "COALESCE(t.refunded_cents,0) AS refunded_cents FROM merchant_impact_commitments c " +
    "JOIN transactions t ON t.id=c.transaction_id JOIN merchant_impact_policies p ON p.id=c.policy_id " +
    "WHERE NOT EXISTS (SELECT 1 FROM merchant_impact_valuations v WHERE v.transaction_id=c.transaction_id " +
    "AND v.cumulative_refunded_cents=COALESCE(t.refunded_cents,0)) " +
    "ORDER BY c.recorded_at ASC,c.transaction_id ASC LIMIT ?"
  ).bind(batchLimit).all();
  let valuations = 0;
  for (const item of pending.results || []) {
    const refunded = Math.max(0, Number(item.refunded_cents || 0));
    const calc = calculateImpactCents({
      originalCents: Number(item.transaction_amount_cents),
      refundedCents: refunded, mode: item.contribution_mode,
      value: Number(item.contribution_value),
    });
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO merchant_impact_valuations (transaction_id,cumulative_refunded_cents,eligible_amount_cents,commitment_cents) VALUES (?,?,?,?)'
    ).bind(item.transaction_id,refunded,calc.eligible_amount_cents,calc.commitment_cents).run();
    valuations += Number(inserted.meta?.changes || 0);
  }
  return { enabled: true, commitments, valuations };
}
