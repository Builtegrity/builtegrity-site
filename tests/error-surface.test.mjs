import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import core from '../worker/src/index.js';
import runtime from '../worker/src/runtime.js';

function throwingDb(message) {
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first() { throw new Error(message); },
        async run() { throw new Error(message); },
        async all() { throw new Error(message); },
      };
      return statement;
    },
  };
}

test('public core routes do not expose unexpected backend error details', async () => {
  const marker = 'SQLITE_INTERNAL_TABLE_NAME_should_never_escape';
  const response = await core.fetch(
    new Request('https://builtegrity.com/api/payments/test-token'),
    { DB: throwingDb(marker) },
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, 'Internal error');
  assert.doesNotMatch(JSON.stringify(body), new RegExp(marker));
});

test('runtime wrapper does not expose unexpected backend error details', async () => {
  const marker = 'D1_OAUTH_INTERNAL_DETAIL_should_never_escape';
  const response = await runtime.fetch(
    new Request('https://builtegrity.com/api/stripe/oauth/callback?state=test&code=test'),
    { DB: throwingDb(marker) },
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, 'Internal error');
  assert.doesNotMatch(JSON.stringify(body), new RegExp(marker));
});

test('explicit client errors remain useful while server errors are sanitized', async () => {
  const response = await core.fetch(
    new Request('https://builtegrity.com/api/transactions'),
    { INTERNAL_ADMIN_TOKEN: 'expected-token' },
  );
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error, 'Unauthorized');
});

test('development dispute simulation emits production-shaped dispute outcomes', () => {
  const source = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
  assert.match(source, /dispute_id: `dp_test_sim_\$\{txId\}`/);
  assert.match(source, /status: 'needs_response'/);
  assert.match(source, /status: 'won'/);
});
