
import test from 'node:test';
import assert from 'node:assert/strict';
import { squareAuthorizeUrl,encryptSquareToken,decryptSquareToken,SQUARE_SCOPES } from '../worker/src/square-oauth.js';
import { verifySquareWebhook,createSquareCheckout } from '../worker/src/square.js';

const env={
  SQUARE_ENV:'sandbox',
  SQUARE_APP_ID:'sandbox-demo-app',
  APP_BASE_URL:'https://example.test',
  SQUARE_TOKEN_ENCRYPTION_KEY_B64:Buffer.alloc(32,21).toString('base64')
};

test('Square merchant authorization is scoped, unguessable state is preserved, uses sandbox host',()=>{
  const url=new URL(squareAuthorizeUrl(env,'random-opaque-state'));
  assert.equal(url.hostname,'connect.squareupsandbox.com');
  assert.equal(url.searchParams.get('state'),'random-opaque-state');
  assert.equal(url.searchParams.get('client_id'),env.SQUARE_APP_ID);
  for(const permission of SQUARE_SCOPES)
    assert.ok(url.searchParams.get('scope').split(' ').includes(permission));
  assert.match(squareAuthorizeUrl({...env,SQUARE_ENV:'production'},'opaque'),/session=false/);
});
test('OAuth token encryption round-trips without plaintext storage',async()=>{
  const saved=await encryptSquareToken(env,'test-sensitive-refresh-token');
  assert.ok(!saved.includes('test-sensitive'));
  assert.equal(await decryptSquareToken(env,saved),'test-sensitive-refresh-token');
  await assert.rejects(()=>decryptSquareToken({...env,SQUARE_TOKEN_ENCRYPTION_KEY_B64:Buffer.alloc(32,5).toString('base64')},saved));
});
test('Square webhook signature includes exact notification URL and exact raw bytes',async()=>{
  const url='https://example.test/api/webhooks/square';
  const raw='{"event_id":"example","merchant_id":"ABC"}';
  const signatureKey='sandbox-test-signature-key';
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(signatureKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(url+raw)))));
  assert.equal(await verifySquareWebhook(raw,signature,signatureKey,url),true);
  assert.equal(await verifySquareWebhook(raw+' ',signature,signatureKey,url),false);
  assert.equal(await verifySquareWebhook(raw,signature,signatureKey,url+'/'),false);
  assert.equal(await verifySquareWebhook(raw,'invalid',signatureKey,url),false);
});
test('Square payment creation fails closed until explicitly enabled',async()=>{
  await assert.rejects(()=>createSquareCheckout({...env,SQUARE_PAYMENT_LINKS_ENABLED:'false'},{processor:'SQUARE'}),/disabled/);
  await assert.rejects(()=>createSquareCheckout({...env,SQUARE_ENV:'production',SQUARE_PAYMENT_LINKS_ENABLED:'true',SQUARE_LIVE_ENABLED:'false'},{processor:'SQUARE'}),/not authorized/);
});
