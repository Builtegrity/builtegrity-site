const FINANCIAL_DECISION_MAX_AGE_MINUTES = 30;
const KNOWN_STAGES = new Set(['PREVIEW', 'TEST', 'PILOT', 'LIVE']);
const STRICT_STAGES = new Set(['PILOT', 'LIVE']);
const CONTROL_COLUMNS = Object.freeze({
  merchant_onboarding_enabled: 'merchant_onboarding_allowed',
  transaction_creation_enabled: 'transaction_creation_allowed',
  payment_creation_enabled: 'payment_creation_allowed',
});

export async function requireReleasePlatformControl(env, column, label) {
  const financialColumn = CONTROL_COLUMNS[column];
  if (!financialColumn) throw new Error(`Unknown platform control: ${column}`);

  const stage = releaseStage(env);
  if (stage === 'INVALID') {
    throw httpError(503, `${label} is paused because the release stage is invalid.`);
  }
  const strict = STRICT_STAGES.has(stage);

  const controls = await env.DB.prepare(`
    SELECT ${column} AS enabled, reason
    FROM platform_controls
    WHERE id='GLOBAL'
  `).first().catch(() => null);

  if (!controls && strict) {
    throw httpError(503, `${label} is paused because platform safety controls are unavailable.`);
  }
  if (controls && Number(controls.enabled) !== 1) {
    throw httpError(503, `${label} is temporarily paused by Builtegrity safety controls${controls.reason ? `: ${controls.reason}` : ''}`);
  }

  const financial = await env.DB.prepare(`
    SELECT state, enforcement_active, ${financialColumn} AS allowed, reason_codes_json, evaluated_at
    FROM financial_safety_state
    WHERE id='GLOBAL'
  `).first().catch(() => null);

  if (!financial) {
    if (strict) throw httpError(503, `${label} is paused because the financial safety engine is unavailable.`);
    return { stage, strict, platform_control_present: Boolean(controls), financial_control_present: false };
  }

  if (strict && Number(financial.enforcement_active) !== 1) {
    throw httpError(503, `${label} is paused until the financial safety engine completes an enforced evaluation.`);
  }

  if (strict && minutesAgo(financial.evaluated_at) > FINANCIAL_DECISION_MAX_AGE_MINUTES) {
    throw httpError(503, `${label} is paused because the financial safety decision is stale. The monitor must complete a fresh evaluation before activity resumes.`);
  }

  if (Number(financial.enforcement_active) === 1 && Number(financial.allowed) !== 1) {
    const reasons = parseReasonCodes(financial.reason_codes_json);
    throw httpError(503, `${label} is paused by Builtegrity financial safety${reasons.length ? `: ${reasons.join(', ')}` : ''}`);
  }

  return {
    stage,
    strict,
    platform_control_present: Boolean(controls),
    financial_control_present: true,
  };
}

export function releaseControlForRequest(path, method) {
  if (String(method || '').toUpperCase() !== 'POST') return null;
  if (path === '/api/transactions') {
    return { column: 'transaction_creation_enabled', label: 'New transaction creation' };
  }
  if (/^\/api\/merchants\/MER-[A-Za-z0-9-]+\/stripe\/connect-url$/.test(path)) {
    return { column: 'merchant_onboarding_enabled', label: 'Merchant onboarding' };
  }
  if (/^\/api\/payments\/[^/]+\/checkout$/.test(path)) {
    return { column: 'payment_creation_enabled', label: 'New payment creation' };
  }
  return null;
}

export function releaseStage(env) {
  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').trim().toUpperCase();
  return KNOWN_STAGES.has(stage) ? stage : 'INVALID';
}

function minutesAgo(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - time) / 60000);
}

function parseReasonCodes(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(0, 10).map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
