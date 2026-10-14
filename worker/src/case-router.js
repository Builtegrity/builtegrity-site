import { resolveInternalCaseForAlert, syncInternalCaseForAlert } from './cases.js';
import { runResolutionAutopilot } from './autopilot.js';
import { processAuthorizedPlatformCredits } from './platform-credits.js';

const INTERNAL_RULES = [
  { match: (a) => a.alert_key === 'watchdog:runner-failure', caseType: 'CATASTROPHIC_INCIDENT' },
  { match: (a) => a.alert_key.startsWith('config:'), caseType: 'PLATFORM_PROVIDER_ACTION_REQUIRED' },
  { match: (a) => a.alert_key.startsWith('webhook:failed:'), caseType: 'WEBHOOK_IRRECOVERABLE' },
  { match: (a) => a.alert_key.startsWith('tx:complete-not-accounted:'), caseType: 'DATA_INTEGRITY_FAILURE' },
  { match: (a) => a.alert_key.startsWith('tx:missing-processor-records:'), caseType: 'PROCESSOR_RECORD_MISMATCH' },
  { match: (a) => a.alert_key.startsWith('tx:fee-shortfall:'), caseType: 'FEE_RECONCILIATION_FAILURE' },
  { match: (a) => a.alert_key.startsWith('merchant:processor-account:'), caseType: 'DATA_INTEGRITY_FAILURE' },
  { match: (a) => a.alert_key.startsWith('merchant:financial-responsibility:'), caseType: 'FINANCIAL_SOLVENCY_RISK' },
  { match: (a) => a.alert_key === 'finance:solvency-brake', caseType: 'FINANCIAL_SOLVENCY_RISK' },
  { match: (a) => a.alert_key === 'dependency:clerk-jwks', caseType: 'PLATFORM_PROVIDER_ACTION_REQUIRED' },
  { match: (a) => a.alert_key === 'dependency:public-health-route', caseType: 'PLATFORM_PROVIDER_ACTION_REQUIRED' },
  { match: (a) => a.alert_key.startsWith('dependency:resend-'), caseType: 'PLATFORM_PROVIDER_ACTION_REQUIRED' },
  { match: (a) => a.alert_key.startsWith('resolution:'), caseType: 'UNKNOWN_EXCEPTION' },
  { match: (a) => a.alert_key.startsWith('workforce:'), caseType: 'UNKNOWN_EXCEPTION' },
];

const MERCHANT_RULES = [
  { match: (a) => a.alert_key.startsWith('tx:payout-failed:'), action: 'RESOLVE_STRIPE_PAYOUT' },
  { match: (a) => a.alert_key.startsWith('tx:payout-overdue:'), action: 'CHECK_STRIPE_PAYOUT' },
  { match: (a) => a.alert_key.startsWith('dependency:stripe-account:'), action: 'RESOLVE_WITH_STRIPE' },
];

export async function syncInternalCasesFromWatchdogs(env) {
  const alerts = await env.DB.prepare(`
    SELECT * FROM system_alerts
    ORDER BY last_seen_at DESC
    LIMIT 1000
  `).all();

  let internal = 0;
  let merchant = 0;
  let system = 0;
  let resolved = 0;

  for (const alert of alerts.results || []) {
    if (alert.status === 'RESOLVED') {
      if (alert.internal_case_id) {
        await resolveInternalCaseForAlert(env, alert.alert_key, 'Watchdog confirmed the originating alert cleared.');
        resolved += 1;
      }
      continue;
    }

    const route = classifyAlert(alert);
    await env.DB.prepare(`
      UPDATE system_alerts
         SET resolution_owner = ?, case_type_code = ?, merchant_action_code = ?
       WHERE alert_key = ?
    `).bind(route.owner, route.case_type || null, route.merchant_action || null, alert.alert_key).run();

    const routed = {
      ...alert,
      resolution_owner: route.owner,
      case_type_code: route.case_type || null,
      merchant_action_code: route.merchant_action || null,
    };

    if (route.owner === 'INTERNAL') {
      await syncInternalCaseForAlert(env, routed);
      internal += 1;
    } else if (route.owner === 'MERCHANT') {
      merchant += 1;
    } else {
      system += 1;
    }
  }

  // Machine-authorized platform-fault credits are processed before the resolver so any failure
  // immediately becomes a financial-safety alert in the same watchdog cycle. Stripe requests are
  // idempotent and arbitrary refunds remain impossible without a narrow authorization record.
  const platformCredits = await processAuthorizedPlatformCredits(env);

  // The resolver runs only after the watchdog and case router have established the source of truth.
  // It can notify the correct party, release abandoned fractional-fee reservations, and dispatch
  // machine-verifiable work to pre-approved variable-labor vendors. It never bypasses the case engine.
  const autopilot = await runResolutionAutopilot(env);
  return { internal, merchant, system, resolved, platform_credits: platformCredits, autopilot };
}

export function classifyAlert(alert) {
  for (const rule of INTERNAL_RULES) {
    if (rule.match(alert)) return { owner: 'INTERNAL', case_type: rule.caseType };
  }

  for (const rule of MERCHANT_RULES) {
    if (rule.match(alert)) return { owner: 'MERCHANT', merchant_action: rule.action };
  }

  // A stuck webhook is still inside its automated recovery window; do not wake a human yet.
  if (alert.alert_key.startsWith('webhook:stuck:')) return { owner: 'SYSTEM' };
  if (alert.alert_key.startsWith('tx:stale-payment-pending:')) return { owner: 'SYSTEM' };
  if (alert.alert_key === 'finance:solvency-warning') return { owner: 'SYSTEM' };

  // Unknown ERROR/CRITICAL conditions are engineering defects by definition. Lower-severity unknowns stay automated.
  if (['ERROR', 'CRITICAL'].includes(String(alert.severity || '').toUpperCase())) {
    return { owner: 'INTERNAL', case_type: 'UNKNOWN_EXCEPTION' };
  }
  return { owner: 'SYSTEM' };
}
