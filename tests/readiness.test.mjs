import test from 'node:test';
import assert from 'node:assert/strict';

import { requiredConfig, systemReadiness } from '../worker/src/readiness.js';

function completeTestEnv(overrides = {}) {
  return {
    WATCHDOG_STAGE: 'TEST',
    APP_BASE_URL: 'https://builtegrity.com',
    ADMIN_BASE_URL: 'https://admin.builtegrity.com',
    ADMIN_HOSTNAME: 'admin.builtegrity.com',
    AUTH_PROVIDER: 'CLERK',
    STRIPE_SECRET_KEY: 'sk_test_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    STRIPE_CONNECT_CLIENT_ID: 'ca_example',
    STRIPE_API_VERSION: '2025-09-30.clover',
    CLERK_PUBLISHABLE_KEY: 'pk_test_example',
    CLERK_JWT_KEY: 'pem',
    CLERK_ISSUER: 'https://example.clerk.accounts.dev',
    CLERK_AUTHORIZED_PARTIES: 'https://builtegrity.com,https://admin.builtegrity.com',
    CLERK_ADMIN_USER_IDS: 'user_owner',
    CLERK_SIGN_IN_URL: 'https://example.accounts.dev/sign-in',
    ...overrides,
  };
}

function fakeDb({ schema = true, auditTriggers = true, connectedAccountIndex = true, watchdog = null } = {}) {
  return {
    prepare(sql) {
      return {
        async first() {
          if (sql.includes('SELECT 1 AS ok')) return { ok: 1 };
          if (sql.includes('stripe_checkout_expires_at') && sql.includes('creation_idempotency_key')) {
            if (!schema) throw new Error('no such column: creation_idempotency_key');
            return null;
          }
          if (sql.includes('SELECT id FROM system_watchdog_runs')) {
            if (!schema) throw new Error('no such table: system_watchdog_runs');
            return null;
          }
          if (sql.includes('transactions_consent_audit_evidence')) {
            return auditTriggers ? { name: 'transactions_consent_audit_evidence' } : null;
          }
          if (sql.includes('transactions_checkout_audit_evidence')) {
            return auditTriggers ? { name: 'transactions_checkout_audit_evidence' } : null;
          }
          if (sql.includes('idx_merchants_unique_processor_account')) {
            return connectedAccountIndex ? { name: 'idx_merchants_unique_processor_account' } : null;
          }
          if (sql.includes('FROM system_watchdog_runs') && sql.includes('ORDER BY started_at')) {
            if (!schema) throw new Error('no such table: system_watchdog_runs');
            return watchdog;
          }
          throw new Error(`Unexpected readiness SQL: ${sql}`);
        },
      };
    },
  };
}

test('TEST readiness requires configuration used by redirects, Stripe and Clerk auth', () => {
  const env = completeTestEnv({
    APP_BASE_URL: '',
    STRIPE_API_VERSION: '',
    CLERK_PUBLISHABLE_KEY: '',
    CLERK_AUTHORIZED_PARTIES: '',
    CLERK_SIGN_IN_URL: '',
  });
  const missing = requiredConfig(env, 'TEST');
  assert.ok(missing.includes('APP_BASE_URL'));
  assert.ok(missing.includes('STRIPE_API_VERSION'));
  assert.ok(missing.includes('CLERK_PUBLISHABLE_KEY'));
  assert.ok(missing.includes('CLERK_AUTHORIZED_PARTIES'));
  assert.ok(missing.includes('CLERK_SIGN_IN_URL'));
});

test('unknown WATCHDOG_STAGE fails closed instead of falling back to PREVIEW', async () => {
  const result = await systemReadiness(completeTestEnv({
    WATCHDOG_STAGE: 'LIV',
    DB: fakeDb({ watchdog: recentWatchdog() }),
  }));
  assert.equal(result.stage, 'LIV');
  assert.equal(result.stage_valid, false);
  assert.equal(result.config_complete, false);
  assert.ok(result.missing_config.includes('WATCHDOG_STAGE'));
  assert.equal(result.ok, false);
});

test('readiness fails when D1 is bound but current migrations are missing', async () => {
  const result = await systemReadiness(completeTestEnv({ DB: fakeDb({ schema: false }) }));
  assert.equal(result.database, true);
  assert.equal(result.schema_ready, false);
  assert.equal(result.ok, false);
});

test('readiness fails when atomic audit evidence triggers are missing', async () => {
  const result = await systemReadiness(completeTestEnv({
    DB: fakeDb({ schema: true, auditTriggers: false }),
  }));
  assert.equal(result.database, true);
  assert.equal(result.schema_ready, false);
  assert.match(result.database_error, /triggers or indexes/i);
  assert.equal(result.ok, false);
});

test('readiness fails when connected-account uniqueness migration is missing', async () => {
  const result = await systemReadiness(completeTestEnv({
    DB: fakeDb({ schema: true, connectedAccountIndex: false }),
  }));
  assert.equal(result.database, true);
  assert.equal(result.schema_ready, false);
  assert.match(result.database_error, /triggers or indexes/i);
  assert.equal(result.ok, false);
});

test('readiness fails before a watchdog has completed', async () => {
  const result = await systemReadiness(completeTestEnv({ DB: fakeDb({ schema: true, watchdog: null }) }));
  assert.equal(result.schema_ready, true);
  assert.equal(result.watchdog_healthy, false);
  assert.equal(result.ok, false);
});

test('readiness fails when the last watchdog is stale', async () => {
  const stale = new Date(Date.now() - 90 * 60_000).toISOString();
  const result = await systemReadiness(completeTestEnv({
    DB: fakeDb({
      watchdog: { run_kind: 'FAST', status: 'OK', started_at: stale, finished_at: stale },
    }),
  }));
  assert.equal(result.watchdog_healthy, true);
  assert.equal(result.watchdog_fresh, false);
  assert.equal(result.ok, false);
});

test('SQLite CURRENT_TIMESTAMP watchdog times are interpreted as UTC', async () => {
  const recent = sqliteTimestamp(new Date(Date.now() - 5 * 60_000));
  const result = await systemReadiness(completeTestEnv({
    DB: fakeDb({
      watchdog: { run_kind: 'FAST', status: 'OK', started_at: recent, finished_at: recent },
    }),
  }));
  assert.equal(result.watchdog_fresh, true);
});

test('readiness becomes true only with schema config audit constraints and a recent watchdog', async () => {
  const result = await systemReadiness(completeTestEnv({
    DB: fakeDb({ watchdog: recentWatchdog() }),
  }));
  assert.equal(result.config_complete, true);
  assert.equal(result.schema_ready, true);
  assert.equal(result.watchdog_healthy, true);
  assert.equal(result.watchdog_fresh, true);
  assert.equal(result.ok, true);
});

function recentWatchdog() {
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  return { run_kind: 'FAST', status: 'OK', started_at: recent, finished_at: recent };
}

function sqliteTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
