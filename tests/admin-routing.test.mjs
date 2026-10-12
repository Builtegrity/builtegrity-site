import test from 'node:test';
import assert from 'node:assert/strict';

import runtime from '../worker/src/runtime.js';

function env(overrides = {}) {
  return {
    DEV_MODE: 'false',
    ADMIN_HOSTNAME: 'admin.builtegrity.com',
    AUTH_PROVIDER: 'CLERK',
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, { status: 200 });
      },
    },
    ...overrides,
  };
}

test('public host cannot serve login, console or auth surfaces', async () => {
  for (const path of ['/login/', '/console/', '/auth/session']) {
    const response = await runtime.fetch(new Request(`https://builtegrity.com${path}`), env(), {});
    assert.equal(response.status, 404, path);
  }
});

test('configured admin host can serve the login asset', async () => {
  const response = await runtime.fetch(
    new Request('https://admin.builtegrity.com/login/'),
    env(),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/login/');
});

test('local DEV_BYPASS can reach the console even when production admin hostname is configured', async () => {
  const response = await runtime.fetch(
    new Request('http://localhost:8787/console/'),
    env({ DEV_MODE: 'true', AUTH_PROVIDER: 'DEV_BYPASS' }),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/console/');
});

test('non-local arbitrary host does not gain admin access in DEV_MODE', async () => {
  const response = await runtime.fetch(
    new Request('https://example.com/console/'),
    env({ DEV_MODE: 'true', AUTH_PROVIDER: 'DEV_BYPASS' }),
    {},
  );

  assert.equal(response.status, 404);
});
