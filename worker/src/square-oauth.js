
// Square is an independent adapter. OAuth credentials never enter public assets or log output.
export const SQUARE_SCOPES = Object.freeze([
  'MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'PAYMENTS_WRITE',
  'PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS', 'ORDERS_READ', 'ORDERS_WRITE',
  'PAYOUTS_READ', 'SETTLEMENTS_READ'
]);
export function squareBase(env) {
  return String(env.SQUARE_ENV || 'sandbox').toLowerCase()==='production'
    ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
}
export function squareRedirectUri(env) {
  if(!env.APP_BASE_URL) throw new Error('APP_BASE_URL is required for Square OAuth');
  return env.APP_BASE_URL.replace(/\/$/,'')+'/api/square/oauth/callback';
}
export function squareAuthorizeUrl(env,state) {
  if(!env.SQUARE_APP_ID) throw new Error('SQUARE_APP_ID is not configured');
  const url=new URL(squareBase(env)+'/oauth2/authorize');
  url.searchParams.set('client_id',env.SQUARE_APP_ID);
  url.searchParams.set('scope',SQUARE_SCOPES.join(' '));
  url.searchParams.set('state',state);
  if(String(env.SQUARE_ENV).toLowerCase()==='production')url.searchParams.set('session','false');
  return url.toString();
}
async function key(env) {
  const b64=env.SQUARE_TOKEN_ENCRYPTION_KEY_B64;
  if(!b64) throw new Error('SQUARE_TOKEN_ENCRYPTION_KEY_B64 is not configured');
  const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  if(bytes.length!==32) throw new Error('Square OAuth token encryption key must be 32 bytes');
  return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
}
export async function encryptSquareToken(env,plain) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),new TextEncoder().encode(plain)));
  return 'v1.'+Array.from(iv,b=>b.toString(16).padStart(2,'0')).join('')+'.'+Array.from(ciphertext,b=>b.toString(16).padStart(2,'0')).join('');
}
export async function decryptSquareToken(env,stored) {
  if(!stored||!stored.startsWith('v1.')) throw new Error('Square token format is unsupported');
  const [_,ivHex,ctHex]=stored.split('.');
  const iv=Uint8Array.from(ivHex.match(/../g)||[],h=>parseInt(h,16));
  const ct=Uint8Array.from(ctHex.match(/../g)||[],h=>parseInt(h,16));
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},await key(env),ct));
}
export async function squareTokenExchange(env,grant_type,value) {
  if(!env.SQUARE_APP_ID||!env.SQUARE_APP_SECRET) throw new Error('Square OAuth credentials are missing');
  const payload={client_id:env.SQUARE_APP_ID,client_secret:env.SQUARE_APP_SECRET,grant_type};
  if(grant_type==='authorization_code')payload.code=value;
  else if(grant_type==='refresh_token')payload.refresh_token=value;
  else throw new Error('Invalid Square OAuth grant');
  const response=await fetch(squareBase(env)+'/oauth2/token',{
    method:'POST',headers:{'Content-Type':'application/json','Square-Version':'2026-09-16'},
    body:JSON.stringify(payload)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw Object.assign(new Error('Square OAuth token exchange failed'),{status:502});
  return data;
}
export async function saveSquareConnection(env,merchantId,token,locationId) {
  if(!token?.merchant_id||!token?.access_token||!token?.refresh_token)throw new Error('Incomplete Square OAuth grant');
  const [encryptedAccess,encryptedRefresh]=await Promise.all([
    encryptSquareToken(env,token.access_token),encryptSquareToken(env,token.refresh_token)
  ]);
  await env.DB.prepare(`
    INSERT INTO merchant_processor_connections
     (id,merchant_id,processor,external_account_id,location_id,status,scopes,encrypted_access_token,encrypted_refresh_token,access_expires_at)
    VALUES (?,?,'SQUARE',?,?,'TEST',?,?,?,?)
    ON CONFLICT(merchant_id,processor) DO UPDATE SET
      external_account_id=excluded.external_account_id,location_id=excluded.location_id,
      status='TEST',scopes=excluded.scopes,
      encrypted_access_token=excluded.encrypted_access_token,
      encrypted_refresh_token=excluded.encrypted_refresh_token,
      access_expires_at=excluded.access_expires_at,updated_at=CURRENT_TIMESTAMP
  `).bind('PCONN-SQUARE-'+merchantId,merchantId,token.merchant_id,locationId,
    SQUARE_SCOPES.join(' '),encryptedAccess,encryptedRefresh,token.expires_at||null).run();
}
export async function squareConnection(env,merchantId) {
  const row=await env.DB.prepare(`
   SELECT * FROM merchant_processor_connections WHERE merchant_id=? AND processor='SQUARE'
  `).bind(merchantId).first();
  if(!row||!['TEST','ACTIVE'].includes(row.status)||!row.encrypted_access_token)throw Object.assign(new Error('Square merchant connection is unavailable'),{status:409});
  return row;
}
export async function squareAccessToken(env,merchantId) {
  const connection=await squareConnection(env,merchantId);
  const expires=connection.access_expires_at?Date.parse(connection.access_expires_at):0;
  if(expires && expires>Date.now()+5*86400000)return {token:await decryptSquareToken(env,connection.encrypted_access_token),connection};
  const refresh=await decryptSquareToken(env,connection.encrypted_refresh_token);
  const renewed=await squareTokenExchange(env,'refresh_token',refresh);
  const [encryptedAccess,encryptedRefresh]=await Promise.all([
    encryptSquareToken(env,renewed.access_token),
    encryptSquareToken(env,renewed.refresh_token||refresh)
  ]);
  await env.DB.prepare(`
   UPDATE merchant_processor_connections
   SET encrypted_access_token=?,encrypted_refresh_token=?,access_expires_at=?,updated_at=CURRENT_TIMESTAMP
   WHERE id=?
  `).bind(encryptedAccess,encryptedRefresh,renewed.expires_at||null,connection.id).run();
  return {token:renewed.access_token,connection:{...connection,access_expires_at:renewed.expires_at}};
}
export async function squareApi(env,merchantId,path,{method='GET',body}={}) {
  const {token}=await squareAccessToken(env,merchantId);
  const response=await fetch(squareBase(env)+path,{
    method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Square-Version':'2026-09-16'},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error('Square API request failed: '+String(payload.errors?.[0]?.code||response.status));
    error.status=response.status>=500?502:response.status; throw error;
  }
  return payload;
}
export async function squareAuthorizeLocation(env,token) {
  const response=await fetch(squareBase(env)+'/v2/locations',{
    headers:{Authorization:'Bearer '+token,'Square-Version':'2026-09-16'}
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error('Could not retrieve Square merchant locations'),{status:502});
  const location=(payload.locations||[]).find(l=>l.status==='ACTIVE'&&l.country==='US'&&l.currency==='USD');
  if(!location?.id)throw Object.assign(new Error('This Square account needs an active US/USD location'),{status:409});
  return location.id;
}
