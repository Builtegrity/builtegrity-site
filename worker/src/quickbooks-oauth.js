import { encryptBooksSecret, decryptBooksSecret } from './books-crypto.js';

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';

export function quickBooksRedirectUri(env) {
  const base = requireEnv(env, 'ADMIN_BASE_URL').replace(/\/$/, '');
  return `${base}/api/accounting/quickbooks/callback`;
}

export async function createQuickBooksConnectUrl(env) {
  const clientId = requireEnv(env, 'QUICKBOOKS_CLIENT_ID');
  requireEnv(env, 'QUICKBOOKS_CLIENT_SECRET');
  requireEnv(env, 'ACCOUNTING_TOKEN_ENCRYPTION_KEY_B64');
  const state = randomToken();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO accounting_oauth_states(state_token,provider,expires_at)
    VALUES(?,'QUICKBOOKS_ONLINE',?)
  `).bind(state, expiresAt).run();
  await env.DB.prepare(`
    UPDATE accounting_connections SET status='CONNECTING',last_error=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id='BOOKS-PRIMARY'
  `).run();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ACCOUNTING_SCOPE);
  url.searchParams.set('redirect_uri', quickBooksRedirectUri(env));
  url.searchParams.set('state', state);
  return { authorize_url: url.toString(), expires_at: expiresAt };
}

export async function completeQuickBooksOAuth(env, url) {
  const state = url.searchParams.get('state');
  if (!state) throw badRequest('Missing QuickBooks OAuth state');
  const row = await env.DB.prepare(`
    SELECT * FROM accounting_oauth_states
    WHERE state_token=? AND provider='QUICKBOOKS_ONLINE' AND consumed_at IS NULL AND datetime(expires_at)>datetime('now')
  `).bind(state).first();
  if (!row) throw badRequest('QuickBooks OAuth state is invalid or expired');

  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    await consumeState(env, state);
    await env.DB.prepare(`UPDATE accounting_connections SET status='ERROR',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id='BOOKS-PRIMARY'`)
      .bind(url.searchParams.get('error_description') || oauthError).run();
    throw badRequest(url.searchParams.get('error_description') || oauthError);
  }

  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  if (!code || !realmId) throw badRequest('QuickBooks callback is missing code or realmId');
  const tokens = await tokenRequest(env, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: quickBooksRedirectUri(env),
  }));
  await storeTokens(env, tokens, realmId, null);
  await consumeState(env, state);
  return { realm_id: realmId, status: 'ACTIVE' };
}

export async function getQuickBooksAccessToken(env) {
  const connection = await env.DB.prepare(`SELECT * FROM accounting_connections WHERE id='BOOKS-PRIMARY'`).first();
  if (!connection || connection.status !== 'ACTIVE') {
    const error = new Error('QuickBooks Online is not actively connected');
    error.status = 409;
    throw error;
  }

  const expiresAt = Date.parse(connection.access_token_expires_at || '');
  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 5 * 60 * 1000) {
    return { token: await decryptBooksSecret(env, connection.access_token_ciphertext), connection };
  }

  const refresh = await decryptBooksSecret(env, connection.refresh_token_ciphertext);
  if (!refresh) {
    await markReauth(env, 'QuickBooks refresh token is unavailable');
    throw reauthError('QuickBooks must be reauthorized');
  }

  try {
    const tokens = await tokenRequest(env, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }));
    const saved = await storeTokens(env, tokens, connection.realm_id, connection.token_version);
    return { token: await decryptBooksSecret(env, saved.access_token_ciphertext), connection: saved };
  } catch (error) {
    if (error.status === 401 || error.status === 400) await markReauth(env, error.message);
    throw error;
  }
}

export async function disconnectQuickBooks(env) {
  await env.DB.prepare(`
    UPDATE accounting_connections
       SET status='DISCONNECTED',access_token_ciphertext=NULL,refresh_token_ciphertext=NULL,
           access_token_expires_at=NULL,refresh_token_expires_at=NULL,disconnected_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
     WHERE id='BOOKS-PRIMARY'
  `).run();
  return { disconnected: true };
}

async function tokenRequest(env, body) {
  const clientId = requireEnv(env, 'QUICKBOOKS_CLIENT_ID');
  const clientSecret = requireEnv(env, 'QUICKBOOKS_CLIENT_SECRET');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.error || `QuickBooks OAuth error ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!payload.access_token || !payload.refresh_token) throw new Error('QuickBooks token response is incomplete');
  return payload;
}

async function storeTokens(env, tokens, realmId, expectedVersion) {
  const accessCipher = await encryptBooksSecret(env, tokens.access_token);
  const refreshCipher = await encryptBooksSecret(env, tokens.refresh_token);
  const accessExpiry = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString();
  const refreshExpiry = new Date(Date.now() + Number(tokens.x_refresh_token_expires_in || 8640000) * 1000).toISOString();
  const scope = String(tokens.scope || ACCOUNTING_SCOPE);

  if (expectedVersion == null) {
    await env.DB.prepare(`
      UPDATE accounting_connections
         SET status='ACTIVE',realm_id=?,scope=?,access_token_ciphertext=?,refresh_token_ciphertext=?,
             access_token_expires_at=?,refresh_token_expires_at=?,token_version=token_version+1,
             last_error=NULL,disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE id='BOOKS-PRIMARY'
    `).bind(realmId, scope, accessCipher, refreshCipher, accessExpiry, refreshExpiry).run();
  } else {
    const result = await env.DB.prepare(`
      UPDATE accounting_connections
         SET status='ACTIVE',scope=?,access_token_ciphertext=?,refresh_token_ciphertext=?,
             access_token_expires_at=?,refresh_token_expires_at=?,token_version=token_version+1,
             last_error=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE id='BOOKS-PRIMARY' AND token_version=?
    `).bind(scope, accessCipher, refreshCipher, accessExpiry, refreshExpiry, expectedVersion).run();
    if (!Number(result.meta?.changes || 0)) {
      return env.DB.prepare(`SELECT * FROM accounting_connections WHERE id='BOOKS-PRIMARY'`).first();
    }
  }
  return env.DB.prepare(`SELECT * FROM accounting_connections WHERE id='BOOKS-PRIMARY'`).first();
}

async function markReauth(env, message) {
  await env.DB.prepare(`UPDATE accounting_connections SET status='REAUTH_REQUIRED',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id='BOOKS-PRIMARY'`)
    .bind(String(message || 'QuickBooks reauthorization required').slice(0, 1000)).run();
}
async function consumeState(env, state) { await env.DB.prepare(`UPDATE accounting_oauth_states SET consumed_at=CURRENT_TIMESTAMP WHERE state_token=?`).bind(state).run(); }
function requireEnv(env, name) { const value=String(env[name]||'').trim(); if(!value) throw new Error(`Missing required QuickBooks configuration: ${name}`); return value; }
function randomToken(){const bytes=crypto.getRandomValues(new Uint8Array(32));return [...bytes].map((b)=>b.toString(16).padStart(2,'0')).join('');}
function badRequest(message){const e=new Error(message);e.status=400;return e;}
function reauthError(message){const e=new Error(message);e.status=401;return e;}
