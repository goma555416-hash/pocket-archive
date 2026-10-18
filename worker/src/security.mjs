const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE = '__Host-pa_session';
export const CSRF_COOKIE = '__Host-pa_csrf';
export const OAUTH_COOKIE = '__Host-pa_oauth';

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomToken(size = 32, cryptoObject = globalThis.crypto) {
  return bytesToBase64Url(cryptoObject.getRandomValues(new Uint8Array(size)));
}

export async function sha256Text(value, cryptoObject = globalThis.crypto) {
  return bytesToBase64Url(new Uint8Array(await cryptoObject.subtle.digest('SHA-256', encoder.encode(String(value)))));
}

export function safeEqual(left, right) {
  const a = encoder.encode(String(left)); const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function encryptionKey(env, version) {
  const current = Number(env.TOKEN_ENCRYPTION_KEY_VERSION || 1);
  if (Number(version) === current) return env.TOKEN_ENCRYPTION_KEY;
  if (Number(version) === Number(env.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION)) return env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  return null;
}

async function importEncryptionKey(raw, cryptoObject = globalThis.crypto) {
  if (!raw) throw new Error('伺服器缺少 Token 加密金鑰');
  const bytes = base64UrlToBytes(raw);
  if (bytes.length !== 32) throw new Error('Token 加密金鑰必須是 32-byte base64url');
  return cryptoObject.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value, env, cryptoObject = globalThis.crypto) {
  const version = Number(env.TOKEN_ENCRYPTION_KEY_VERSION || 1);
  const iv = cryptoObject.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encryptionKey(env, version), cryptoObject);
  const ciphertext = new Uint8Array(await cryptoObject.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`pocket-archive:v${version}`) }, key, encoder.encode(String(value))));
  return `v${version}.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export async function decryptSecret(value, env, cryptoObject = globalThis.crypto) {
  const match = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(value || ''));
  if (!match) throw new Error('加密憑證格式錯誤');
  const version = Number(match[1]);
  const key = await importEncryptionKey(encryptionKey(env, version), cryptoObject);
  try {
    const plaintext = await cryptoObject.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(match[2]), additionalData: encoder.encode(`pocket-archive:v${version}`) }, key, base64UrlToBytes(match[3]));
    return decoder.decode(plaintext);
  } catch { throw new Error('無法解密伺服器憑證；請檢查金鑰版本'); }
}

export async function pkceChallenge(verifier, cryptoObject = globalThis.crypto) {
  return sha256Text(verifier, cryptoObject);
}

export function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('='); if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    try { result[key] = decodeURIComponent(part.slice(separator + 1).trim()); } catch { /* malformed cookie */ }
  }
  return result;
}

export function cookie(name, value, { maxAge = 0, httpOnly = true, sameSite = 'Lax' } = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'Secure', `SameSite=${sameSite}`, `Max-Age=${Math.max(0, Math.floor(maxAge))}`];
  if (httpOnly) attributes.push('HttpOnly');
  return attributes.join('; ');
}

export function clearCookie(name, { httpOnly = true, sameSite = 'Lax' } = {}) {
  return cookie(name, '', { maxAge: 0, httpOnly, sameSite });
}

export function appendCookie(headers, value) { headers.append('Set-Cookie', value); }

export function safeReturnTo(value) {
  const candidate = String(value || '/');
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\') || candidate.length > 512) return '/';
  return candidate;
}

export function expectedOrigin(request, env) {
  const configured = String(env.APP_ORIGIN || '').replace(/\/$/, '');
  return configured || new URL(request.url).origin;
}

export function assertSameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (origin && origin !== expectedOrigin(request, env)) throw Object.assign(new Error('拒絕跨來源請求'), { status: 403, code: 'origin_rejected' });
  if (fetchSite === 'cross-site') throw Object.assign(new Error('拒絕跨網站請求'), { status: 403, code: 'cross_site_rejected' });
}

export function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

export function publicError(error) {
  const status = Number(error?.status) || 500;
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const code = error?.code || (safeStatus === 500 ? 'internal_error' : 'request_failed');
  const message = safeStatus === 500 ? '伺服器暫時無法完成要求' : String(error?.message || '要求失敗');
  return json({ ok: false, error: { code, message } }, safeStatus);
}

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
