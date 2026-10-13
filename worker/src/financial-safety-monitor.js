import { evaluateFinancialSafety } from './financial-safety.js';

const WARNING_KEY = 'finance:solvency-warning';
const BRAKE_KEY = 'finance:solvency-brake';

export async function monitorFinancialSafety(env, options = {}) {
  const safety = await evaluateFinancialSafety(env, options);
  await syncFinancialSafetyAlerts(env, safety);
  return safety;
}

export async function syncFinancialSafetyAlerts(env, safety) {
  if (!safety) return;
  const state = String(safety.state || 'UNKNOWN').toUpperCase();
  const reasons = Array.isArray(safety.reason_codes) ? safety.reason_codes : [];
  const reasonText = reasons.length ? reasons.join(', ') : 'No reason codes were recorded';

  if (state === 'GREEN') {
    await resolveAlert(env, WARNING_KEY);
    await resolveAlert(env, BRAKE_KEY);
    return;
  }

  if (state === 'YELLOW') {
    await resolveAlert(env, BRAKE_KEY);
    const alert = await upsertAlert(env, {
      key: WARNING_KEY,
      severity: 'WARN',
      owner: 'SYSTEM',
      caseType: null,
      message: `Builtegrity financial safety is YELLOW. ${reasonText}. Growth is still permitted, but the safety margin has degraded and must not be ignored.`,
    });
    await maybeNotify(env, alert, safety);
    return;
  }

  await resolveAlert(env, WARNING_KEY);
  const severity = state === 'RED' ? 'CRITICAL' : 'ERROR';
  const alert = await upsertAlert(env, {
    key: BRAKE_KEY,
    severity,
    owner: 'INTERNAL',
    caseType: 'FINANCIAL_SOLVENCY_RISK',
    message: `Builtegrity financial safety brake is ${state}. ${reasonText}. Allowed actions: onboarding=${Boolean(safety.merchant_onboarding_allowed)}, new_transactions=${Boolean(safety.transaction_creation_allowed)}, new_payments=${Boolean(safety.payment_creation_allowed)}. Do not bypass the brake; correct the underlying economics or financial inputs and let the machine re-evaluate.`,
  });
  await maybeNotify(env, alert, safety);
}

async function upsertAlert(env, values) {
  await env.DB.prepare(`
    INSERT INTO system_alerts (
      alert_key, category, severity, status, subject_type, subject_id, message,
      resolution_owner, case_type_code, merchant_action_code
    ) VALUES (?, 'FINANCE', ?, 'OPEN', 'PLATFORM', 'BUILTEGRITY', ?, ?, ?, NULL)
    ON CONFLICT(alert_key) DO UPDATE SET
      category='FINANCE',
      severity=excluded.severity,
      status='OPEN',
      subject_type='PLATFORM',
      subject_id='BUILTEGRITY',
      message=excluded.message,
      resolution_owner=excluded.resolution_owner,
      case_type_code=excluded.case_type_code,
      merchant_action_code=NULL,
      last_seen_at=CURRENT_TIMESTAMP,
      resolved_at=NULL,
      occurrences=system_alerts.occurrences+1,
      last_notified_at=CASE WHEN system_alerts.status='RESOLVED' THEN NULL ELSE system_alerts.last_notified_at END
  `).bind(values.key, values.severity, values.message, values.owner, values.caseType).run();
  return env.DB.prepare(`SELECT * FROM system_alerts WHERE alert_key=?`).bind(values.key).first();
}

async function resolveAlert(env, key) {
  await env.DB.prepare(`
    UPDATE system_alerts
       SET status='RESOLVED', resolved_at=CURRENT_TIMESTAMP, last_seen_at=CURRENT_TIMESTAMP
     WHERE alert_key=? AND status='OPEN'
  `).bind(key).run();
}

async function maybeNotify(env, alert, safety) {
  if (!alert) return;
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_FROM || !env.ALERT_EMAIL_TO) {
    console.error('Financial safety alert could not be emailed because Resend alert configuration is incomplete', {
      alert_key: alert.alert_key,
      state: safety?.state,
    });
    return;
  }
  if (alert.last_notified_at && hoursAgo(alert.last_notified_at) < 24) return;

  const metrics = safety?.metrics || {};
  const lines = [
    `Financial safety state: ${safety.state}`,
    `Reasons: ${(safety.reason_codes || []).join(', ') || 'none recorded'}`,
    `Enforcement active: ${Boolean(safety.enforcement_active)}`,
    `Merchant onboarding allowed: ${Boolean(safety.merchant_onboarding_allowed)}`,
    `New transaction creation allowed: ${Boolean(safety.transaction_creation_allowed)}`,
    `New payment creation allowed: ${Boolean(safety.payment_creation_allowed)}`,
    `Safe runway months: ${metrics.runway_months ?? 'unknown'}`,
    `Reserve surplus micros: ${metrics.reserve_surplus_micros ?? 'unknown'}`,
    `Stripe platform available micros: ${metrics.processor_available_micros ?? 'unknown'}`,
    `Stripe Connect reserve micros: ${metrics.processor_connect_reserved_micros ?? 'unknown'}`,
    `Floor planning margin ppm: ${metrics.floor_planning_margin_ppm ?? 'unknown'}`,
    `Observed human-touch ppm: ${metrics.observed_human_touch_ppm ?? 'unknown'}`,
    '',
    'The machine has already applied the permitted financial safety brakes. Do not bypass them; correct the source condition and re-evaluate.',
  ];

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: String(env.ALERT_EMAIL_FROM),
        to: String(env.ALERT_EMAIL_TO).split(',').map((value) => value.trim()).filter(Boolean),
        subject: `[Builtegrity ${safety.state}] Financial safety ${safety.state === 'YELLOW' ? 'warning' : 'brake engaged'}`,
        text: lines.join('\n'),
      }),
    });
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
    await env.DB.prepare(`UPDATE system_alerts SET last_notified_at=CURRENT_TIMESTAMP WHERE alert_key=?`).bind(alert.alert_key).run();
  } catch (error) {
    console.error('Financial safety alert delivery failed', error);
  }
}

function hoursAgo(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - time) / 3600000);
}
