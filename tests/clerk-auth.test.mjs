import test from 'node:test';
import assert from 'node:assert/strict';

import { authenticateClerkSession } from '../worker/src/clerk-auth.js';

const issuer = 'https://example.clerk.accounts.dev';

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function keyFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const body = Buffer.from(spki).toString('base64').match(/.{1,64}/g).join('\n');
  return {
    privateKey: pair.privateKey,
    publicPem: `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`,
  };
}

async function signedToken(privateKey, claims) {
  const header = base64Url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(Buffer.from(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function request(token) {
  return new Request('https://admin.builtegrity.com/auth/session', {
    headers: { authorization: `Bearer ${token}` },
  });
}

function env(publicPem) {
  return {
    CLERK_JWT_KEY: publicPem,
    CLERK_ISSUER: issuer,
    CLERK_AUTHORIZED_PARTIES: 'https://admin.builtegrity.com',
  };
}

test('valid Clerk session token is accepted', async () => {
  const keys = await keyFixture();
  const now = Math.floor(Date.now() / 1000);
  const token = await signedToken(keys.privateKey, {
    sub: 'user_owner',
    sid: 'sess_123',
    iss: issuer,
    azp: 'https://admin.builtegrity.com',
    iat: now,
    nbf: now - 5,
    exp: now + 60,
  });

  const principal = await authenticateClerkSession(request(token), env(keys.publicPem));
  assert.equal(principal?.sub, 'user_owner');
  assert.equal(principal?.session_id, 'sess_123');
});

test('Clerk-signed JWT without a session ID is rejected', async () => {
  const keys = await keyFixture();
  const now = Math.floor(Date.now() / 1000);
  const token = await signedToken(keys.privateKey, {
    sub: 'user_owner',
    iss: issuer,
    azp: 'https://admin.builtegrity.com',
    exp: now + 60,
  });

  assert.equal(await authenticateClerkSession(request(token), env(keys.publicPem)), null);
});

test('Clerk-signed JWT without expiration is rejected', async () => {
  const keys = await keyFixture();
  const token = await signedToken(keys.privateKey, {
    sub: 'user_owner',
    sid: 'sess_123',
    iss: issuer,
    azp: 'https://admin.builtegrity.com',
  });

  assert.equal(await authenticateClerkSession(request(token), env(keys.publicPem)), null);
});

test('session token from an unauthorized party is rejected', async () => {
  const keys = await keyFixture();
  const now = Math.floor(Date.now() / 1000);
  const token = await signedToken(keys.privateKey, {
    sub: 'user_owner',
    sid: 'sess_123',
    iss: issuer,
    azp: 'https://evil.example',
    exp: now + 60,
  });

  assert.equal(await authenticateClerkSession(request(token), env(keys.publicPem)), null);
});
