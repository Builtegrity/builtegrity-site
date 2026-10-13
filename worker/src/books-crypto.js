function requireSecret(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing required books secret: ${name}`);
  return value;
}

export async function encryptBooksSecret(env, plaintext) {
  if (!plaintext) return null;
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(String(plaintext));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
  return `v1.${base64(iv)}.${base64(ciphertext)}`;
}

export async function decryptBooksSecret(env, envelope) {
  if (!envelope) return null;
  const [version, ivValue, cipherValue] = String(envelope).split('.');
  if (version !== 'v1' || !ivValue || !cipherValue) throw new Error('Unsupported books-secret envelope');
  const key = await encryptionKey(env);
  const iv = unbase64(ivValue);
  const ciphertext = unbase64(cipherValue);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function encryptionKey(env) {
  const raw = unbase64(requireSecret(env, 'ACCOUNTING_TOKEN_ENCRYPTION_KEY_B64'));
  if (raw.byteLength !== 32) throw new Error('ACCOUNTING_TOKEN_ENCRYPTION_KEY_B64 must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function unbase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
