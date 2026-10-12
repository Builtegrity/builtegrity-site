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
    'STRIPE_API_VERSION',
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
    'STRIPE_API_VERSION',
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
    'STRIPE_API_VERSION',
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
  const stageValid = isKnownWatchdogStage(stage);
  const missingConfig = requiredConfig(env, stage);
  let database = false;
  let schemaReady = false;
  let lastWatchdog = null;
  let databaseError = null;

  try {
    if (env.DB) {
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      database = Number(row?.ok || 0) === 1;

      // Fail closed unless the current migration chain, including atomic audit
      // evidence triggers and connected-account uniqueness, is actually present in D1.
      await env.DB.prepare('SELECT stripe_checkout_expires_at, creation_idempotency_key FROM transactions LIMIT 1').first();
      await env.DB.prepare('SELECT id FROM system_watchdog_runs LIMIT 1').first();
      const consentTrigger = await env.DB.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'transactions_consent_audit_evidence'
      `).first();
      const checkoutTrigger = await env.DB.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'transactions_checkout_audit_evidence'
      `).first();
      const processorAccountIndex = await env.DB.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_merchants_unique_processor_account'
      `).first();
      if (!consentTrigger || !checkoutTrigger || !processorAccountIndex) {
        throw new Error('required transaction-integrity triggers or indexes are missing');
      }
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
  const watchdogFinishedAt = parseTimestamp(lastWatchdog?.finished_at);
  const watchdogAgeMinutes = Number.isFinite(watchdogFinishedAt)
    ? Math.max(0, (Date.now() - watchdogFinishedAt) / 60_000)
    : null;
  const watchdogHealthy = Boolean(
    lastWatchdog?.finished_at && ['OK', 'WARN'].includes(String(lastWatchdog.status || '').toUpperCase()),
  );
  const watchdogFresh = watchdogHealthy && watchdogAgeMinutes !== null && watchdogAgeMinutes <= maxAgeMinutes;

  const ok = stageValid &&
    database &&
    schemaReady &&
    missingConfig.length === 0 &&
    watchdogHealthy &&
    watchdogFresh;

  return {
    ok,
    stage,
    stage_valid: stageValid,
    database,
    schema_ready: schemaReady,
    database_error: databaseError,
    config_complete: stageValid && missingConfig.length === 0,
    missing_config_count: missingConfig.length,
    missing_config: missingConfig,
    watchdog_healthy: watchdogHealthy,
    watchdog_fresh: watchdogFresh,
    watchdog_age_minutes: watchdogAgeMinutes === null ? null : Math.round(watchdogAgeMinutes * 10) / 10,
    watchdog_max_age_minutes: maxAgeMinutes,
    last_watchdog: lastWatchdog || null,
  };
}

export function stageRequirements(stage) {
  return STAGE_REQUIREMENTS[String(stage || '').toUpperCase()] || [];
}

export function isKnownWatchdogStage(stage) {
  return Object.prototype.hasOwnProperty.call(STAGE_REQUIREMENTS, String(stage || '').toUpperCase());
}

export function requiredConfig(env, stage = watchdogStage(env)) {
  if (!isKnownWatchdogStage(stage)) return ['WATCHDOG_STAGE'];
  return stageRequirements(stage).filter((name) => !isConfiguredValue(env[name]));
}

export function watchdogStage(env) {
  return String(env.WATCHDOG_STAGE || 'PREVIEW').trim().toUpperCase();
}

export function transactionStageProblem(env) {
  const stage = watchdogStage(env);
  if (!isKnownWatchdogStage(stage)) {
    return `Builtegrity runtime stage ${stage || '(empty)'} is invalid`;
  }
  if (stage === 'PREVIEW') {
    return 'Builtegrity is in PREVIEW and protected payment operations are disabled';
  }
  return null;
}

function isConfiguredValue(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !/(?:REPLACE(?:_|\.|$)|CHANGE_ME|YOUR_)/i.test(text);
}

function watchdogMaxAgeMinutes(env) {
  const configured = Number(env.WATCHDOG_MAX_AGE_MINUTES || 45);
  return Number.isFinite(configured) && configured >= 15 ? configured : 45;
}

function parseTimestamp(value) {
  if (!value) return NaN;
  const text = String(value).trim();
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  return Date.parse(normalized);
}
