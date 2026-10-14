// Company launch policy, not a statement that these measures guarantee immunity.
export const LAUNCH_ASSURANCE_IDS = Object.freeze([
  'POLICY-LIMITED-LIABILITY-ENTITY',
  'POLICY-TECH-EO-CYBER-COVERAGE',
  'POLICY-PROCESSOR-LOSS-ALLOCATION',
]);

export async function launchAssuranceBlockers(env) {
  let rows;
  try {
    rows = (await env.DB.prepare(`
      SELECT id, status, evidence_ref, verified_at, next_review_due_at
      FROM compliance_obligations WHERE id IN (?,?,?)
    `).bind(...LAUNCH_ASSURANCE_IDS).all()).results || [];
  } catch {
    return ['LAUNCH_ASSURANCE_UNAVAILABLE'];
  }
  const now = Date.now();
  return LAUNCH_ASSURANCE_IDS.filter((id) => {
    const row = rows.find((item) => item.id === id);
    const verified = Date.parse(row?.verified_at || '');
    const due = Date.parse(row?.next_review_due_at || '');
    return !row || row.status !== 'SATISFIED' || !String(row.evidence_ref || '').trim()
      || !Number.isFinite(verified) || verified > now
      || !Number.isFinite(due) || due <= now || due <= verified;
  }).map((id) => `LAUNCH_ASSURANCE_NOT_CURRENT:${id}`);
}

export function assertStripeEnvironment(env) {
  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').trim().toUpperCase();
  const key = String(env.STRIPE_SECRET_KEY || '');
  if (!['PREVIEW', 'TEST', 'PILOT', 'LIVE'].includes(stage)
      || !/^(sk|rk)_(test|live)_\S+$/.test(key)
      || (['PREVIEW', 'TEST'].includes(stage) && !/^(sk|rk)_test_/.test(key))) {
    const error = new Error('Stripe credential mode is incompatible with the release stage.');
    error.status = 503;
    throw error;
  }
}
