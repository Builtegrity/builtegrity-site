import test from 'node:test';
import assert from 'node:assert/strict';

import { disputeOutcomeRequiresReview, openException } from '../worker/src/db.js';

function closed(disputeId, status) {
  return { event_data_json: JSON.stringify({ dispute_id: disputeId, status }) };
}

test('favorable Stripe dispute closure statuses do not require post-settlement review', () => {
  assert.equal(disputeOutcomeRequiresReview([closed('dp_1', 'won')]), false);
  assert.equal(disputeOutcomeRequiresReview([closed('dp_1', 'warning_closed')]), false);
});

test('latest closure for the same dispute is authoritative', () => {
  assert.equal(disputeOutcomeRequiresReview([
    closed('dp_1', 'lost'),
    closed('dp_1', 'won'),
  ]), false);
});

test('a different dispute with an adverse outcome still requires review', () => {
  assert.equal(disputeOutcomeRequiresReview([
    closed('dp_1', 'won'),
    closed('dp_2', 'lost'),
  ]), true);
});

test('unknown or malformed dispute closure fails closed', () => {
  assert.equal(disputeOutcomeRequiresReview([closed('dp_1', 'needs_response')]), true);
  assert.equal(disputeOutcomeRequiresReview([{ event_data_json: '{bad-json' }]), true);
});

test('openException converges on the canonical row when a concurrent insert wins', async () => {
  let openLookupCount = 0;
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes('UPDATE id_counters')) return { value: 42 };
            if (sql.includes('SELECT id FROM transaction_exceptions')) {
              openLookupCount += 1;
              return openLookupCount === 1 ? null : { id: 'EXC-WINNER' };
            }
            if (sql.includes('SELECT * FROM transactions')) {
              return {
                id: 'TX-0001',
                lifecycle_status: 'PAID',
                consent_accepted: 0,
                terms_snapshot: 'terms',
                terms_snapshot_sha256: null,
                payment_status: 'succeeded',
                amount_cents: 100,
                customer_paid_cents: 100,
                fee_collection_method: 'STRIPE_APPLICATION_FEE',
                integrity_fee_collected_cents: 0,
                integrity_fee_earned_cents: 0,
              };
            }
            if (sql.includes('SELECT COUNT(*) AS count')) return { count: 1 };
            throw new Error(`Unexpected first() SQL: ${sql}`);
          },
          async all() {
            if (sql.includes("event_type = 'DISPUTE_CLOSED'")) return { results: [] };
            throw new Error(`Unexpected all() SQL: ${sql}`);
          },
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO transaction_exceptions')) {
              return { meta: { changes: 0 } };
            }
            if (sql.includes('UPDATE transactions')) return { meta: { changes: 1 } };
            throw new Error(`Unexpected run() SQL: ${sql}`);
          },
        };
        return statement;
      },
    },
  };

  const id = await openException(env, 'TX-0001', 'PAYMENT_FAILED', 'failure');
  assert.equal(id, 'EXC-WINNER');
  assert.equal(openLookupCount, 2);
});
