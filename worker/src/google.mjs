import { base64UrlToBytes, decryptSecret, encryptSecret, safeEqual } from './security.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const encoder = new TextEncoder();
let jwksCache = { expiresAt: 0, keys: [] };

function oauthError(message, code = 'oauth_failed', status = 401) {
  return Object.assign(new Error(message), { code, status });
}

function decodePart(value) {
  try { return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))); }
  catch { throw oauthError('Google 身分憑證格式錯誤'); }
}

function cacheSeconds(header) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header || '');
  return match ? Math.min(86400, Math.max(60, Number(match[1]))) : 3600;
}

async function googleKeys(fetchImpl, now) {
  if (jwksCache.expiresAt > now && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetchImpl(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw oauthError('暫時無法驗證 Google 身分', 'google_jwks_unavailable', 503);
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw oauthError('Google 驗證金鑰回應無效', 'google_jwks_invalid', 503);
  jwksCache = { keys: body.keys, expiresAt: now + cacheSeconds(response.headers.get('cache-control')) * 1000 };
  return jwksCache.keys;
}

export function resetGoogleKeyCache() { jwksCache = { expiresAt: 0, keys: [] }; }

export async function verifyGoogleIdToken(token, { clientId, nonce, fetchImpl = fetch, now = Date.now(), cryptoObject = globalThis.crypto } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw oauthError('Google 未回傳有效的身分憑證');
  const header = decodePart(parts[0]); const claims = decodePart(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw oauthError('Google 身分憑證演算法不受支援');
  const keyData = (await googleKeys(fetchImpl, now)).find(key => key.kid === header.kid && key.kty === 'RSA');
  if (!keyData) { resetGoogleKeyCache(); throw oauthError('找不到 Google 身分憑證簽章金鑰', 'google_key_not_found', 503); }
  const key = await cryptoObject.subtle.importKey('jwk', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const verified = await cryptoObject.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!verified) throw oauthError('Google 身分憑證簽章驗證失敗');
  const seconds = Math.floor(now / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) throw oauthError('Google 身分憑證簽發者錯誤');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw oauthError('Google 身分憑證對象錯誤');
  if (!Number.isFinite(claims.exp) || claims.exp < seconds - 60 || Number(claims.iat || 0) > seconds + 60) throw oauthError('Google 身分憑證已過期或時間無效');
  if (!safeEqual(claims.nonce || '', nonce || '')) throw oauthError('Google 登入 nonce 驗證失敗');
  if (!claims.sub || !claims.email || claims.email_verified !== true) throw oauthError('Google 帳號缺少已驗證的身分資訊');
  return claims;
}

export async function exchangeAuthorizationCode({ code, verifier, redirectUri, env, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier
  });
  const response = await fetchImpl(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token || !result.id_token) throw oauthError('Google 授權碼交換失敗', result.error === 'invalid_grant' ? 'invalid_grant' : 'token_exchange_failed');
  return result;
}

export async function refreshGoogleAccessToken(credential, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!credential || credential.revoked_at || credential.reauth_required) throw oauthError('Google Drive 授權已失效，請重新登入', 'reauth_required');
  if (credential.access_token_cipher && Number(credential.access_token_expires_at) > now + 60_000) return decryptSecret(credential.access_token_cipher, env);
  if (credential.refresh_token_expires_at && Number(credential.refresh_token_expires_at) <= now) throw oauthError('Google 長期授權已到期，請重新登入', 'reauth_required');
  const refreshToken = await decryptSecret(credential.refresh_token_cipher, env);
  const body = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' });
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { response = await fetchImpl(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
    catch (error) {
      if (attempt === 2) throw oauthError('Google 暫時無法更新授權，請稍後重試', 'google_unavailable', 503);
      continue;
    }
    if (response.ok || response.status < 500) break;
  }
  const result = await response.json().catch(() => ({}));
  if (!response?.ok || !result.access_token) {
    if (result.error === 'invalid_grant') throw oauthError('Google 授權已撤銷或失效，請重新登入', 'reauth_required');
    throw oauthError('Google 暫時無法更新授權，請稍後重試', 'google_refresh_failed', 503);
  }
  return {
    accessToken: result.access_token,
    accessTokenCipher: await encryptSecret(result.access_token, env),
    accessTokenExpiresAt: now + Math.max(60, Number(result.expires_in || 3600)) * 1000,
    refreshTokenCipher: result.refresh_token ? await encryptSecret(result.refresh_token, env) : null,
    refreshTokenExpiresAt: result.refresh_token_expires_in ? now + Number(result.refresh_token_expires_in) * 1000 : null,
    scope: result.scope || credential.scope
  };
}

export async function revokeGoogleToken(refreshTokenCipher, env, fetchImpl = fetch) {
  if (!refreshTokenCipher) return false;
  const token = await decryptSecret(refreshTokenCipher, env);
  const response = await fetchImpl(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
  return response.ok;
}

export function googleAuthorizationUrl({ env, state, challenge, nonce, redirectUri, loginHint = '' }) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `openid email profile ${DRIVE_SCOPE}`,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${GOOGLE_AUTH_URL}?${params}`;
}
