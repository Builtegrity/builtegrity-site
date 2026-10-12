import { openException, recomputeIntegrity, resolveException } from './db.js';
import { retrieveConnectedAccount } from './stripe.js';

const STAGE_REQUIREMENTS = {
  PREVIEW: [],
  TEST: [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CONNECT_CLIENT_ID',
    'CLERK_JWT_KEY',
    'CLERK_ISSUER',
    'CLERK_ADMIN_USER_IDS',
  ],
  PILOT: [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CONNECT_CLIENT_ID',
    'CLERK_JWT_KEY',
    'CLERK_ISSUER',
    'CLERK_ADMIN_USER_IDS',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
    'RESEND_API_KEY',
    'ALERT_EMAIL_FROM',
    'ALERT_EMAIL_TO',
  ],
  LIVE: [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CONNECT_CLIENT_ID',
    'CLERK_JWT_KEY',
    'CLERK_ISSUER',
    'CLERK_ADMIN_USER_IDS',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
    'RESEND_API_KEY',
    'ALERT_EMAIL_FROM',
    'ALERT_EMAIL_TO',
    'APP_BASE_URL',
    'ADMIN_BASE_URL',
    'ADMIN_HOSTNAME',
  ],
};

export async function systemReadiness(env) {
  const stage = watchdogStage(env);
  const missingConfig = requiredConfig(env, stage);
  let database = false;
  let lastWatchdog = null;

  try {
    if (env.DB) {
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      database = Number(row?.ok || 0) === 1;
      lastWatchdog = await env.DB.prepare(`
        SELECT run_kind, status, started_at, finished_at
        FROM system_watchdog_runs
        ORDER BY started_at DESC
        LIMIT 1
      `).first().catch(() => null);
    }
  } catch {
    database = false;
  }

  return {
    ok: database && missingConfig.length === 0 && lastWatchdog?.status !== 'FAIL',
    stage,
    database,
    config_complete: missingConfig.length === 0,
    missing_config_count: missingConfig.length,
    last_watchdog: lastWatchdog || null,
  };
}

export async function getWatchdogStatus(env) {
  const [alertsResult, runsResult] = await Promise.all([
    env.DB.prepare(`
      SELECT alert_key, category, severity, status, subject_type, subject_id,
             message, first_seen_at, last_seen_at, occurrences, last_notified_at
      FROM system_alerts
      WHERE status = 'OPEN'
      ORDER BY CASE severity
        WHEN 'CRITICAL' THEN 1 WHEN 'ERROR' THEN 2 WHEN 'WARN' THEN 3 ELSE 4 END,
        last_seen_at DESC
      LIMIT 200
    `).all(),
    env.DB.prepare(`
      SELECT * FROM system_watchdog_runs
      ORDER BY started_at DESC
      LIMIT 25
    `).all(),
  ]);

  return {
    readiness: await systemReadiness(env),
    open_alerts: alertsResult.results || [],
    recent_runs: runsResult.results || [],
  };
}

export async function runWatchdogs(env, options = {}) {
  if (!env.DB) throw new Error('Watchdog cannot run without D1 binding DB');

  const runId = crypto.randomUUID();
  const kind = ['FAST', 'DEEP', 'MANUAL'].includes(String(options.kind || '').toUpperCase())
    ? String(options.kind).toUpperCase()
    : 'FAST';
  const triggerSource = String(options.trigger || kind).slice(0, 200);
  const counters = { checks: 0, repairs: 0 };

  await env.DB.prepare(`
    INSERT INTO system_watchdog_runs (id, run_kind, trigger_source, status)
    VALUES (?, ?, ?, 'RUNNING')
  `).bind(runId, kind, triggerSource).run();

  try {
    await checkConfiguration(env, counters);
    await checkWebhookReceipts(env, counters);
    await checkTransactionState(env, counters);
    await checkMerchantState(env, counters);

    if (kind === 'DEEP' || kind === 'MANUAL') {
      await checkExternalDependencies(env, counters);
    }

    const counts = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'OPEN' AND severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical_count,
        SUM(CASE WHEN status = 'OPEN' AND severity = 'ERROR' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN status = 'OPEN' AND severity = 'WARN' THEN 1 ELSE 0 END) AS warn_count
      FROM system_alerts
    `).first();

    const summary = {
      open_alerts: Number(counts?.open_count || 0),
      critical: Number(counts?.critical_count || 0),
      errors: Number(counts?.error_count || 0),
      warnings: Number(counts?.warn_count || 0),
    };
    const status = summary.critical > 0 ? 'FAIL'
      : (summary.errors > 0 || summary.warnings > 0) ? 'WARN'
        : 'OK';

    await env.DB.prepare(`
      UPDATE system_watchdog_runs
         SET status = ?, finished_at = CURRENT_TIMESTAMP,
             checks_run = ?, repairs_made = ?, open_alerts = ?, summary_json = ?
       WHERE id = ?
    `).bind(
      status,
      counters.checks,
      counters.repairs,
      summary.open_alerts,
      JSON.stringify(summary),
      runId,
    ).run();

    return { run_id: runId, kind, status, checks_run: counters.checks, repairs_made: counters.repairs, ...summary };
  } catch (error) {
    const message = String(error?.message || error || 'Unknown watchdog error').slice(0, 2000);
    await env.DB.prepare(`
      UPDATE system_watchdog_runs
         SET status = 'FAIL', finished_at = CURRENT_TIMESTAMP,
             checks_run = ?, repairs_made = ?, error_text = ?
       WHERE id = ?
    `).bind(counters.checks, counters.repairs, message, runId).run().catch(() => {});
    await setAlert(env, {
      key: 'watchdog:runner-failure',
      category: 'WATCHDOG',
      severity: 'CRITICAL',
      message: `Watchdog runner failed: ${message}`,
    }).catch(() => {});
    throw error;
  }
}

async function checkConfiguration(env, counters) {
  counters.checks += 1;
  const stage = watchdogStage(env);
  const required = STAGE_REQUIREMENTS[stage] || [];
  const missing = new Set(requiredConfig(env, stage));

  for (const name of required) {
    const key = `config:${name}`;
    if (missing.has(name)) {
      await setAlert(env, {
        key,
        category: 'CONFIG',
        severity: stage === 'LIVE' ? 'CRITICAL' : 'ERROR',
        subjectType: 'CONFIG',
        subjectId: name,
        message: `${name} is required for WATCHDOG_STAGE=${stage} but is not configured.`,
      });
    } else {
      await resolveAlert(env, key);
    }
  }
}

async function checkWebhookReceipts(env, counters) {
  counters.checks += 1;
  const result = await env.DB.prepare(`
    SELECT event_id, event_type, status, attempts, updated_at, last_error
    FROM stripe_webhook_receipts
    WHERE status = 'FAILED'
       OR (status = 'PROCESSING' AND datetime(updated_at) < datetime('now', '-15 minutes'))
    ORDER BY updated_at ASC
    LIMIT 200
  `).all();

  for (const receipt of result.results || []) {
    const failedKey = `webhook:failed:${receipt.event_id}`;
    const stuckKey = `webhook:stuck:${receipt.event_id}`;
    if (receipt.status === 'FAILED') {
      await setAlert(env, {
        key: failedKey,
        category: 'WEBHOOK',
        severity: 'CRITICAL',
        subjectType: 'STRIPE_EVENT',
        subjectId: receipt.event_id,
        message: `Stripe webhook ${receipt.event_type} failed after ${receipt.attempts} attempt(s): ${receipt.last_error || 'no error text recorded'}`,
      });
      await resolveAlert(env, stuckKey);
    } else {
      await setAlert(env, {
        key: stuckKey,
        category: 'WEBHOOK',
        severity: 'ERROR',
        subjectType: 'STRIPE_EVENT',
        subjectId: receipt.event_id,
        message: `Stripe webhook ${receipt.event_type} has remained PROCESSING for more than 15 minutes.`,
      });
    }
  }

  const open = await env.DB.prepare(`
    SELECT alert_key, subject_id
    FROM system_alerts
    WHERE status = 'OPEN' AND category = 'WEBHOOK'
  `).all();
  for (const alert of open.results || []) {
    const receipt = await env.DB.prepare(`SELECT status FROM stripe_webhook_receipts WHERE event_id = ?`).bind(alert.subject_id).first();
    if (receipt?.status === 'PROCESSED') await resolveAlert(env, alert.alert_key);
  }
}

async function checkTransactionState(env, counters) {
  counters.checks += 1;
  const result = await env.DB.prepare(`
    SELECT t.*, m.automatic_payouts_required
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.lifecycle_status <> 'CREATED'
       OR t.integrity_status <> 'INCOMPLETE'
       OR t.payment_status IS NOT NULL
    ORDER BY t.created_at DESC
    LIMIT 500
  `).all();

  for (const tx of result.results || []) {
    let current = tx;

    if (current.integrity_status === 'ACCOUNTED' || current.lifecycle_status === 'COMPLETE') {
      const before = `${current.integrity_status}:${current.exception_status}`;
      await recomputeIntegrity(env, current.id);
      current = await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(current.id).first();
      const after = `${current.integrity_status}:${current.exception_status}`;
      if (before !== after) counters.repairs += 1;
    }

    const completeKey = `tx:complete-not-accounted:${current.id}`;
    if (current.lifecycle_status === 'COMPLETE' && current.exception_status === 'NONE' && current.integrity_status !== 'ACCOUNTED') {
      await setAlert(env, {
        key: completeKey,
        category: 'TRANSACTION',
        severity: 'CRITICAL',
        subjectType: 'TRANSACTION',
        subjectId: current.id,
        message: `${current.id} is COMPLETE with no open exception but is not ACCOUNTED.`,
      });
    } else {
      await resolveAlert(env, completeKey);
    }

    const missingProcessorKey = `tx:missing-processor-records:${current.id}`;
    const paidLongEnough = current.payment_at && hoursAgo(current.payment_at) >= 1;
    const missingProcessorRecords = String(current.payment_status || '').toLowerCase() === 'succeeded' &&
      paidLongEnough &&
      (!current.stripe_payment_intent_id || !current.stripe_charge_id || !current.stripe_balance_transaction_id);
    if (missingProcessorRecords) {
      await setAlert(env, {
        key: missingProcessorKey,
        category: 'TRANSACTION',
        severity: 'CRITICAL',
        subjectType: 'TRANSACTION',
        subjectId: current.id,
        message: `${current.id} is marked paid but required Stripe processor records are still incomplete after one hour.`,
      });
    } else {
      await resolveAlert(env, missingProcessorKey);
    }

    const feeKey = `tx:fee-shortfall:${current.id}`;
    const feeShortfall = String(current.payment_status || '').toLowerCase() === 'succeeded' &&
      paidLongEnough &&
      current.fee_collection_method === 'STRIPE_APPLICATION_FEE' &&
      Number(current.integrity_fee_earned_cents || 0) > Number(current.integrity_fee_collected_cents || 0);
    if (feeShortfall) {
      const existed = await hasOpenException(env, current.id, 'UNEXPECTED_FEE');
      await openException(env, current.id, 'UNEXPECTED_FEE', 'Expected Builtegrity application fee has not been fully recorded after payment success.');
      if (!existed) counters.repairs += 1;
      await setAlert(env, {
        key: feeKey,
        category: 'ECONOMICS',
        severity: 'ERROR',
        subjectType: 'TRANSACTION',
        subjectId: current.id,
        message: `${current.id} has an integrity-fee shortfall after successful payment.`,
      });
    } else {
      await resolveAlert(env, feeKey);
    }

    const payoutFailedKey = `tx:payout-failed:${current.id}`;
    if (String(current.processor_payout_status || '').toLowerCase() === 'failed') {
      const existed = await hasOpenException(env, current.id, 'PAYOUT_FAILED');
      await openException(env, current.id, 'PAYOUT_FAILED', 'Processor payout is marked failed; watchdog ensured the transaction exception exists.');
      if (!existed) counters.repairs += 1;
      await setAlert(env, {
        key: payoutFailedKey,
        category: 'PAYOUT',
        severity: 'CRITICAL',
        subjectType: 'TRANSACTION',
        subjectId: current.id,
        message: `${current.id} is attached to a failed processor payout.`,
      });
    } else {
      await resolveAlert(env, payoutFailedKey);
    }

    const payoutOverdueKey = `tx:payout-overdue:${current.id}`;
    const payoutPaid = String(current.processor_payout_status || '').toLowerCase() === 'paid';
    const expectedOverdue = current.expected_payout_arrival && !payoutPaid && hoursAgo(current.expected_payout_arrival) >= 12;
    const noPayoutAfterThreeDays = !payoutPaid && !current.stripe_payout_id && Number(current.automatic_payouts_required) === 1 &&
      current.payment_at && hoursAgo(current.payment_at) >= 72;

    if (expectedOverdue || noPayoutAfterThreeDays) {
      const existed = await hasOpenException(env, current.id, 'EXPECTED_PAYOUT_NOT_FOUND');
      await openException(env, current.id, 'EXPECTED_PAYOUT_NOT_FOUND', 'Expected automatic payout has not been reconciled within the watchdog tolerance window.');
      if (!existed) counters.repairs += 1;
      await setAlert(env, {
        key: payoutOverdueKey,
        category: 'PAYOUT',
        severity: 'ERROR',
        subjectType: 'TRANSACTION',
        subjectId: current.id,
        message: `${current.id} has not reconciled to the expected automatic payout on time.`,
      });
    } else {
      if (payoutPaid) {
        const existed = await hasOpenException(env, current.id, 'EXPECTED_PAYOUT_NOT_FOUND');
        if (existed) {
          await resolveException(env, current.id, 'EXPECTED_PAYOUT_NOT_FOUND', 'Watchdog observed the payout as paid and cleared the overdue-payout exception.');
          counters.repairs += 1;
        }
      }
      await resolveAlert(env, payoutOverdueKey);
    }
  }
}

async function checkMerchantState(env, counters) {
  counters.checks += 1;
  const result = await env.DB.prepare(`
    SELECT id, status, processor, processor_account_id
    FROM merchants
    WHERE status = 'ACTIVE'
    LIMIT 500
  `).all();

  for (const merchant of result.results || []) {
    const key = `merchant:processor-account:${merchant.id}`;
    if (merchant.processor === 'STRIPE' && !merchant.processor_account_id) {
      await setAlert(env, {
        key,
        category: 'MERCHANT',
        severity: 'CRITICAL',
        subjectType: 'MERCHANT',
        subjectId: merchant.id,
        message: `${merchant.id} is ACTIVE but has no Stripe connected account ID.`,
      });
    } else {
      await resolveAlert(env, key);
    }
  }
}

async function checkExternalDependencies(env, counters) {
  counters.checks += 1;

  if (env.CLERK_ISSUER) {
    const key = 'dependency:clerk-jwks';
    try {
      const jwksUrl = new URL('/.well-known/jwks.json', String(env.CLERK_ISSUER)).toString();
      const response = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await resolveAlert(env, key);
    } catch (error) {
      await setAlert(env, {
        key,
        category: 'DEPENDENCY',
        severity: 'ERROR',
        subjectType: 'SERVICE',
        subjectId: 'CLERK',
        message: `Clerk JWKS dependency probe failed: ${String(error?.message || error)}`,
      });
    }
  }

  if (env.APP_BASE_URL) {
    const key = 'dependency:public-health-route';
    try {
      const url = `${String(env.APP_BASE_URL).replace(/\/$/, '')}/api/health`;
      const response = await fetch(url, { headers: { 'user-agent': 'Builtegrity-Watchdog/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await resolveAlert(env, key);
    } catch (error) {
      await setAlert(env, {
        key,
        category: 'DEPENDENCY',
        severity: 'CRITICAL',
        subjectType: 'SERVICE',
        subjectId: 'PUBLIC_RUNTIME',
        message: `Public Builtegrity health route is unreachable: ${String(error?.message || error)}`,
      });
    }
  }

  if (env.STRIPE_SECRET_KEY) {
    const merchants = await env.DB.prepare(`
      SELECT id, processor_account_id
      FROM merchants
      WHERE status = 'ACTIVE' AND processor = 'STRIPE' AND processor_account_id IS NOT NULL
      ORDER BY id
      LIMIT 100
    `).all();

    for (const merchant of merchants.results || []) {
      const key = `dependency:stripe-account:${merchant.id}`;
      try {
        const account = await retrieveConnectedAccount(env, merchant.processor_account_id);
        const payoutInterval = account.settings?.payouts?.schedule?.interval || null;
        if (!account.charges_enabled || !account.payouts_enabled || payoutInterval === 'manual') {
          throw new Error(`charges_enabled=${Boolean(account.charges_enabled)}, payouts_enabled=${Boolean(account.payouts_enabled)}, payout_interval=${payoutInterval || 'unknown'}`);
        }
        await resolveAlert(env, key);
      } catch (error) {
        await setAlert(env, {
          key,
          category: 'DEPENDENCY',
          severity: 'CRITICAL',
          subjectType: 'MERCHANT',
          subjectId: merchant.id,
          message: `${merchant.id} Stripe compatibility probe failed: ${String(error?.message || error)}`,
        });
      }
    }
  }
}

async function hasOpenException(env, transactionId, exceptionType) {
  const row = await env.DB.prepare(`
    SELECT id FROM transaction_exceptions
    WHERE transaction_id = ? AND exception_type = ? AND status = 'OPEN'
    LIMIT 1
  `).bind(transactionId, exceptionType).first();
  return Boolean(row);
}

async function setAlert(env, alert) {
  await env.DB.prepare(`
    INSERT INTO system_alerts
      (alert_key, category, severity, status, subject_type, subject_id, message)
    VALUES (?, ?, ?, 'OPEN', ?, ?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      category = excluded.category,
      severity = excluded.severity,
      status = 'OPEN',
      subject_type = excluded.subject_type,
      subject_id = excluded.subject_id,
      message = excluded.message,
      last_seen_at = CURRENT_TIMESTAMP,
      resolved_at = NULL,
      occurrences = system_alerts.occurrences + 1,
      last_notified_at = CASE
        WHEN system_alerts.status = 'RESOLVED' THEN NULL
        ELSE system_alerts.last_notified_at
      END
  `).bind(
    alert.key,
    alert.category,
    alert.severity,
    alert.subjectType || null,
    alert.subjectId || null,
    String(alert.message || 'Watchdog alert').slice(0, 2000),
  ).run();

  const row = await env.DB.prepare(`SELECT * FROM system_alerts WHERE alert_key = ?`).bind(alert.key).first();
  await maybeNotify(env, row);
  return row;
}

async function resolveAlert(env, key) {
  await env.DB.prepare(`
    UPDATE system_alerts
       SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
     WHERE alert_key = ? AND status = 'OPEN'
  `).bind(key).run();
}

async function maybeNotify(env, alert) {
  if (!alert || !env.RESEND_API_KEY || !env.ALERT_EMAIL_FROM || !env.ALERT_EMAIL_TO) return;
  if (!shouldNotify(alert)) return;

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
        subject: `[Builtegrity ${alert.severity}] ${alert.category} watchdog`,
        text: [
          `Severity: ${alert.severity}`,
          `Category: ${alert.category}`,
          `Subject: ${alert.subject_type || 'SYSTEM'} ${alert.subject_id || ''}`.trim(),
          `Alert: ${alert.message}`,
          `First seen: ${alert.first_seen_at}`,
          `Occurrences: ${alert.occurrences}`,
          '',
          'This message was generated by the Builtegrity runtime watchdog. The alert remains deduplicated until resolved.',
        ].join('\n'),
      }),
    });
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
    await env.DB.prepare(`UPDATE system_alerts SET last_notified_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(alert.id).run();
  } catch (error) {
    console.error('Watchdog alert delivery failed', error);
  }
}

function shouldNotify(alert) {
  if (!alert.last_notified_at) return true;
  return hoursAgo(alert.last_notified_at) >= 24;
}

function watchdogStage(env) {
  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').trim().toUpperCase();
  return stage in STAGE_REQUIREMENTS ? stage : 'PREVIEW';
}

function requiredConfig(env, stage = watchdogStage(env)) {
  return (STAGE_REQUIREMENTS[stage] || []).filter((name) => !String(env[name] || '').trim());
}

function hoursAgo(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, (Date.now() - time) / 3_600_000);
}
