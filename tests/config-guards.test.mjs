import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('deployment scripts target the configured D1 database and cannot remotely seed TX-0001', async () => {
  const pkg = JSON.parse(await text('package.json'));
  assert.match(pkg.scripts['db:migrate:local'], /builtegrity-v1/);
  assert.match(pkg.scripts['db:migrate:remote'], /builtegrity-v1/);
  assert.match(pkg.scripts['db:seed:local'], /builtegrity-v1/);
  assert.equal(pkg.scripts['db:seed:remote'], undefined);
});

test('public homepage exposes neither operator console nor seeded test payment token', async () => {
  const homepage = await text('public/index.html');
  assert.doesNotMatch(homepage, /\/console\//);
  assert.doesNotMatch(homepage, /test-tx-0001-token/);
});

test('Stripe post-payment events that can invalidate accounting are explicitly handled', async () => {
  const webhooks = await text('worker/src/webhooks.js');
  assert.match(webhooks, /application_fee\.refunded/);
  assert.match(webhooks, /APPLICATION_FEE_REFUNDED/);
  assert.match(webhooks, /charge\.refunded/);
  assert.match(webhooks, /REFUND_RECORDED/);
  assert.match(webhooks, /DISPUTE_LOST/);
  assert.match(webhooks, /payout\.canceled/);
  assert.match(webhooks, /PAYOUT_CANCELED/);
});

test('non-preview readiness requires a pinned Stripe API version', async () => {
  const readiness = await text('worker/src/readiness.js');
  const config = await text('wrangler.toml.example');
  assert.match(readiness, /STRIPE_API_VERSION/);
  assert.match(config, /STRIPE_API_VERSION = "2025-09-30\.clover"/);
});
