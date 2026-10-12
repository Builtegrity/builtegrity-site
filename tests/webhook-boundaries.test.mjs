import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { requireDirectTransactionAccount } from '../worker/src/webhook-runtime.js';

function dbWithTransaction(accountId = 'acct_expected') {
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first() {
          return { id: 'TX-0001', processor_account_id: accountId };
        },
      };
      return statement;
    },
  };
}

function checkoutEvent(account = 'acct_expected') {
  return {
    id: 'evt_test',
    type: 'checkout.session.completed',
    account,
    data: {
      object: {
        id: 'cs_test',
        metadata: { builtegrity_tx_id: 'TX-0001' },
      },
    },
  };
}

test('direct transaction webhook accepts the merchant connected account', async () => {
  await requireDirectTransactionAccount({ DB: dbWithTransaction() }, checkoutEvent());
});

test('direct transaction webhook rejects a different connected account', async () => {
  await assert.rejects(
    requireDirectTransactionAccount({ DB: dbWithTransaction() }, checkoutEvent('acct_other')),
    /connected-account boundary mismatch/,
  );
});

test('direct transaction webhook rejects missing connected-account context', async () => {
  await assert.rejects(
    requireDirectTransactionAccount({ DB: dbWithTransaction() }, checkoutEvent(null)),
    /connected-account boundary mismatch/,
  );
});

test('non-direct events are left to their correlation-specific handlers', async () => {
  const env = {
    DB: {
      prepare() {
        throw new Error('DB should not be queried for payout events');
      },
    },
  };
  await requireDirectTransactionAccount(env, { type: 'payout.paid', data: { object: {} } });
});

test('production webhook entrypoint uses the account-boundary wrapper', () => {
  const source = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/webhook-runtime\.js'/);
  assert.doesNotMatch(source, /import \{ processStripeWebhook \} from '\.\/webhooks\.js'/);
});
