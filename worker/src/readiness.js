const STAGE_REQUIREMENTS = {
  PREVIEW: [],
  TEST: [
    'APP_BASE_URL',
    'ADMIN_BASE_URL',
    'ADMIN_HOSTNAME',
    'AUTH_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CONNECT_CLIENT_ID',
    'CLERK_PUBLISHABLE_KEY',
    'CLERK_JWT_KEY',
    'CLERK_ISSUER',
    'CLERK_AUTHORIZED_PARTIES',
    'CLERK_ADMIN_USER_IDS',
    'CLERK_SIGN_IN_URL',
  ],
  PILOT: [
    'APP_BASE_URL',
    'ADMIN_BASE_URL',
    'ADMIN_HOSTNAME',
    'AUTH_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CONNECT_CLIENT_ID',
    'CLERK_PUBLISHABLE_KEY',
    'CLERK_JWT_KEY',
    'CLERK_ISSUER',
    'CLERK_AUTHORIZED_PARTIES',
    'CLERK_ADMIN_USER_IDS',
    'CLERK_SIGN_IN_URL',
    'CLERK_USER_URL',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
    'RESEND_API_KEY',
    'ALERT_EMAIL_FROM',
    'ALERT_EMAIL_TO',
  ],
  LIVE: [
    'APP_BASE_URL',
    'ADMIN_BASE_URL',
    'ADMIN_HOSTNAME',
    'AUTH_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CONNECT_CLIENT_ID',
    'CLERK_PUBLISHABLE_KEY',
    'CLERK_JWT_KEY',
    'CLERK_ISSUER',
    'CLERK_AUTHORIZED_PARTIES',
    'CLERK_ADMIN_USER_IDS',
    'CLERK_SIGN_IN_URL',
    'CLERK_USER_URL',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
    'RESEND_API_KEY',
    'ALERT_EMAIL_FROM',
    'ALERT_EMAIL_TO',
  ],
};

export async function systemReadiness(env) {
  const stage = watchdogStage(env);
  const missingConfig = requiredConfig(env, stage);
  let database = false;
  let schemaReady = false;
  let lastWatchdog = null;
  let databaseError = null;

  try {
    if (env.DB) {
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      database = Number(row?.ok || 0) === 1;

      // This column only exists after the current migration chain. Querying it is a
      // cheap fail-closed check that the transaction schema is not merely an empty D1.
      await env.DB.prepare('SELECT stripe_checkout_expires_at FROM transactions LIMIT 1').first();
      await env.DB.prepare('SELECT id FROM system_watchdog_runs LIMIT 1').first();
      schemaReady = true;

      lastWatchdog = await env.DB.prepare(`
        SELECT run_kind, status, started_at, finished_at
        FROM system_watchdog_runs
        ORDER BY started_at DESC
        LIMIT 1
      `).first();
    }
  } catch (error) {
    databaseError = String(error?.message || error || 'D1 readiness probe failed').slice(0, 500);
  }

  const maxAgeMinutes = watchdogMaxAgeMinutes(env);
  const watchdogFinishedAt = lastWatchdog?.finished_at ? Date.parse(lastWatchdog.finished_at) : NaN;
  const watchdogAgeMinutes = Number.isFinite(watchdogFinishedAt)
    ? Math.max(0, (Date.now() - watchdogFinishedAt) / 60_000)
    : null;
  const watchdogHealthy = Boolean(
    lastWatchdog?.finished_at && ['OK', 'WARN'].includes(String(lastWatchdog.status || '').toUpperCase()),
  );
  const watchdogFresh = watchdogHealthy && watchdogAgeMinutes !== null && watchdogAgeMinutes <= maxAgeMinutes;

  const ok = database &&
    schemaReady &&
    missingConfig.length === 0 &&
    watchdogHealthy &&
    watchdogFresh;

  return {
    ok,
    stage,
    database,
    schema_ready: schemaReady,
    database_error: databaseError,
    config_complete: missingConfig.length === 0,
    missing_config_count: missingConfig.length,
    missing_config: missingConfig,
    watchdog_healthy: watchdogHealthy,
    watchdog_fresh: watchdogFresh,
    watchdog_age_minutes: watchdogAgeMinutes === null ? null : Math.round(watchdogAgeMinutes * 10) / 10,
    watchdog_max_age_minutes: maxAgeMinutes,
    last_watchdog: lastWatchdog || null,
  };
}

export function requiredConfig(env, stage = watchdogStage(env)) {
  return (STAGE_REQUIREMENTS[stage] || []).filter((name) => !String(env[name] || '').trim());
}

export function watchdogStage(env) {
  const stage = String(env.WATCHDOG_STAGE || 'PREVIEW').trim().toUpperCase();
  return stage in STAGE_REQUIREMENTS ? stage : 'PREVIEW';
}

function watchdogMaxAgeMinutes(env) {
  const configured = Number(env.WATCHDOG_MAX_AGE_MINUTES || 45);
  return Number.isFinite(configured) && configured >= 15 ? configured : 45;
}
