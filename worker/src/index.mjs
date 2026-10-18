import {
  CSRF_COOKIE, OAUTH_COOKIE, SESSION_COOKIE, appendCookie, assertSameOrigin, clearCookie, cookie,
  decryptSecret, encryptSecret, expectedOrigin, json, parseCookies, pkceChallenge, publicError,
  randomToken, safeEqual, safeReturnTo, sha256Text, withSecurityHeaders
} from './security.mjs';
import {
  exchangeAuthorizationCode, googleAuthorizationUrl, refreshGoogleAccessToken, revokeGoogleToken,
  verifyGoogleIdToken
} from './google.mjs';
import { normalizeUrl } from '../../lib.mjs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,version,appProperties,parents';
const encoder = new TextEncoder();

function httpError(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function nowMs(env) { return typeof env.__now === 'function' ? env.__now() : Date.now(); }
function fetcher(env) { return typeof env.__fetch === 'function' ? env.__fetch : fetch; }

function requireConfiguration(env) {
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY']) if (!env[name]) throw httpError(503, 'server_not_configured', `伺服器尚未設定 ${name}`);
  if (!env.DB) throw httpError(503, 'database_not_configured', '伺服器尚未連結 D1');
}

async function readJson(request, maxBytes = 64 * 1024) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw httpError(413, 'request_too_large', '要求內容過大');
  const text = await request.text();
  if (encoder.encode(text).length > maxBytes) throw httpError(413, 'request_too_large', '要求內容過大');
  try { return text ? JSON.parse(text) : {}; } catch { throw httpError(400, 'invalid_json', '要求內容不是有效 JSON'); }
}

function redirectUri(request, env) { return `${expectedOrigin(request, env)}/api/auth/callback`; }

async function beginAuthorization(request, env, ctx) {
  requireConfiguration(env); assertSameOrigin(request, env);
  const url = new URL(request.url); const createdAt = nowMs(env);
  const state = randomToken(); const binding = randomToken(); const verifier = randomToken(48); const nonce = randomToken();
  const stateHash = await sha256Text(state); const cookieHash = await sha256Text(binding);
  await env.DB.prepare(`INSERT INTO oauth_attempts (state_hash,cookie_hash,verifier_cipher,nonce,return_to,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(stateHash, cookieHash, await encryptSecret(verifier, env), nonce, safeReturnTo(url.searchParams.get('return_to')), createdAt, createdAt + 10 * 60_000).run();
  ctx?.waitUntil?.(env.DB.prepare('DELETE FROM oauth_attempts WHERE expires_at < ? OR used_at IS NOT NULL').bind(createdAt - 60_000).run());
  const headers = new Headers({ Location: googleAuthorizationUrl({ env, state, challenge: await pkceChallenge(verifier), nonce, redirectUri: redirectUri(request, env) }), 'Cache-Control': 'no-store' });
  appendCookie(headers, cookie(OAUTH_COOKIE, binding, { maxAge: 600, httpOnly: true, sameSite: 'Lax' }));
  return new Response(null, { status: 302, headers });
}

function authResultRedirect(request, env, returnTo, result, headers = new Headers()) {
  const target = new URL(safeReturnTo(returnTo), expectedOrigin(request, env));
  target.searchParams.set('auth', result);
  headers.set('Location', target.toString()); headers.set('Cache-Control', 'no-store');
  appendCookie(headers, clearCookie(OAUTH_COOKIE));
  return new Response(null, { status: 302, headers });
}

function deviceName(request) {
  const ua = request.headers.get('User-Agent') || '';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone / iPad';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh/i.test(ua)) return 'Mac';
  return '瀏覽器裝置';
}

async function createSession(env, userId, request, now) {
  const raw = randomToken(); const csrf = randomToken(); const publicId = randomToken(12);
  const idleDays = Math.max(1, Math.min(30, Number(env.SESSION_IDLE_DAYS || 14)));
  const absoluteDays = Math.max(idleDays, Math.min(90, Number(env.SESSION_ABSOLUTE_DAYS || 30)));
  const absoluteExpiresAt = now + absoluteDays * 86_400_000;
  await env.DB.prepare(`INSERT INTO sessions (id_hash,public_id,user_id,csrf_hash,device_name,created_at,last_seen_at,rotate_after,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(await sha256Text(raw), publicId, userId, await sha256Text(csrf), deviceName(request), now, now, now + 24 * 3_600_000, now + idleDays * 86_400_000, absoluteExpiresAt).run();
  return { raw, csrf, publicId, maxAge: Math.floor((absoluteExpiresAt - now) / 1000) };
}

function appendSessionCookies(headers, session) {
  appendCookie(headers, cookie(SESSION_COOKIE, session.raw, { maxAge: session.maxAge, httpOnly: true, sameSite: 'Lax' }));
  appendCookie(headers, cookie(CSRF_COOKIE, session.csrf, { maxAge: session.maxAge, httpOnly: false, sameSite: 'Strict' }));
}

async function finishAuthorization(request, env) {
  requireConfiguration(env);
  const url = new URL(request.url); const now = nowMs(env); const state = url.searchParams.get('state') || '';
  const binding = parseCookies(request.headers.get('Cookie'))[OAUTH_COOKIE] || '';
  if (!state || !binding) return authResultRedirect(request, env, '/', 'state_error');
  const attempt = await env.DB.prepare('SELECT * FROM oauth_attempts WHERE state_hash = ?').bind(await sha256Text(state)).first();
  const returnTo = attempt?.return_to || '/';
  if (!attempt || Number(attempt.expires_at) < now || !safeEqual(attempt.cookie_hash, await sha256Text(binding))) return authResultRedirect(request, env, returnTo, 'state_error');
  if (attempt.used_at) return authResultRedirect(request, env, returnTo, 'replay_error');
  const used = await env.DB.prepare('UPDATE oauth_attempts SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at >= ?').bind(now, attempt.state_hash, now).run();
  if (Number(used.meta?.changes || 0) !== 1) return authResultRedirect(request, env, returnTo, 'replay_error');
  if (url.searchParams.get('error')) return authResultRedirect(request, env, returnTo, 'denied');
  try {
    const verifier = await decryptSecret(attempt.verifier_cipher, env);
    const token = await exchangeAuthorizationCode({ code: url.searchParams.get('code') || '', verifier, redirectUri: redirectUri(request, env), env, fetchImpl: fetcher(env) });
    const claims = await verifyGoogleIdToken(token.id_token, { clientId: env.GOOGLE_CLIENT_ID, nonce: attempt.nonce, fetchImpl: fetcher(env), now });
    const proposedId = `user_${randomToken(18)}`;
    await env.DB.prepare(`INSERT INTO users (id,google_sub,email,display_name,picture_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,picture_url=excluded.picture_url,updated_at=excluded.updated_at`)
      .bind(proposedId, claims.sub, claims.email, claims.name || '', claims.picture || '', now, now).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(claims.sub).first();
    const existing = await env.DB.prepare('SELECT * FROM oauth_credentials WHERE user_id = ?').bind(user.id).first();
    const refreshCipher = token.refresh_token ? await encryptSecret(token.refresh_token, env) : existing?.refresh_token_cipher;
    if (!refreshCipher) throw httpError(401, 'missing_refresh_token', 'Google 未回傳長期授權，請撤銷舊授權後重試');
    const refreshExpiresAt = token.refresh_token_expires_in ? now + Number(token.refresh_token_expires_in) * 1000 : existing?.refresh_token_expires_at || null;
    await env.DB.prepare(`INSERT INTO oauth_credentials (user_id,refresh_token_cipher,access_token_cipher,access_token_expires_at,refresh_token_expires_at,scope,reauth_required,revoked_at,updated_at) VALUES (?,?,?,?,?,?,0,NULL,?) ON CONFLICT(user_id) DO UPDATE SET refresh_token_cipher=excluded.refresh_token_cipher,access_token_cipher=excluded.access_token_cipher,access_token_expires_at=excluded.access_token_expires_at,refresh_token_expires_at=excluded.refresh_token_expires_at,scope=excluded.scope,reauth_required=0,revoked_at=NULL,updated_at=excluded.updated_at`)
      .bind(user.id, refreshCipher, await encryptSecret(token.access_token, env), now + Number(token.expires_in || 3600) * 1000, refreshExpiresAt, token.scope || '', now).run();
    const session = await createSession(env, user.id, request, now); const headers = new Headers(); appendSessionCookies(headers, session);
    return authResultRedirect(request, env, returnTo, 'success', headers);
  } catch (error) {
    return authResultRedirect(request, env, returnTo, error?.code || 'failed');
  }
}

async function authenticate(request, env, { csrf = false } = {}) {
  requireConfiguration(env); const cookies = parseCookies(request.headers.get('Cookie')); const raw = cookies[SESSION_COOKIE];
  if (!raw) throw httpError(401, 'not_authenticated', '尚未登入');
  const hash = await sha256Text(raw); const now = nowMs(env);
  const session = await env.DB.prepare(`SELECT s.*,u.email,u.display_name,u.picture_url,c.reauth_required FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN oauth_credentials c ON c.user_id=s.user_id WHERE (s.id_hash=? OR (s.previous_id_hash=? AND s.previous_valid_until>?)) LIMIT 1`).bind(hash, hash, now).first();
  if (!session || session.revoked_at || Number(session.idle_expires_at) <= now || Number(session.absolute_expires_at) <= now) {
    if (session && !session.revoked_at) await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE public_id=?').bind(now, session.public_id).run();
    throw httpError(401, 'session_expired', '工作階段已失效，請重新登入');
  }
  if (csrf) {
    assertSameOrigin(request, env); const token = request.headers.get('X-PA-CSRF') || ''; const csrfCookie = cookies[CSRF_COOKIE] || '';
    if (!token || !csrfCookie || !safeEqual(token, csrfCookie) || !safeEqual(await sha256Text(token), session.csrf_hash)) throw httpError(403, 'csrf_rejected', '安全驗證失敗，請重新載入 App');
  }
  const idleDays = Math.max(1, Math.min(30, Number(env.SESSION_IDLE_DAYS || 14))); const nextIdle = Math.min(Number(session.absolute_expires_at), now + idleDays * 86_400_000);
  await env.DB.prepare('UPDATE sessions SET last_seen_at=?,idle_expires_at=? WHERE public_id=?').bind(now, nextIdle, session.public_id).run();
  let rotated = null;
  if (Number(session.rotate_after) <= now && safeEqual(hash, session.id_hash)) {
    const nextRaw = randomToken(); const nextHash = await sha256Text(nextRaw);
    await env.DB.prepare('UPDATE sessions SET previous_id_hash=id_hash,previous_valid_until=?,id_hash=?,rotate_after=? WHERE public_id=?').bind(now + 5 * 60_000, nextHash, now + 24 * 3_600_000, session.public_id).run();
    rotated = { raw: nextRaw, csrf: cookies[CSRF_COOKIE], maxAge: Math.max(0, Math.floor((Number(session.absolute_expires_at) - now) / 1000)) };
  }
  return { ...session, rotated };
}

function sessionHeaders(session) { const headers = new Headers(); if (session.rotated) appendSessionCookies(headers, session.rotated); return headers; }

async function sessionStatus(request, env) {
  const session = await authenticate(request, env); const headers = sessionHeaders(session);
  return json({ ok: true, authenticated: true, user: { email: session.email, displayName: session.display_name, pictureUrl: session.picture_url }, session: { id: session.public_id, deviceName: session.device_name, createdAt: session.created_at, expiresAt: session.absolute_expires_at }, reauthRequired: Boolean(session.reauth_required) }, 200, headers);
}

async function listSessions(request, env) {
  const session = await authenticate(request, env); const now = nowMs(env);
  const result = await env.DB.prepare('SELECT public_id,device_name,created_at,last_seen_at,absolute_expires_at FROM sessions WHERE user_id=? AND revoked_at IS NULL AND idle_expires_at>? AND absolute_expires_at>? ORDER BY last_seen_at DESC LIMIT 20').bind(session.user_id, now, now).all();
  return json({ ok: true, currentSessionId: session.public_id, sessions: (result.results || []).map(item => ({ id: item.public_id, deviceName: item.device_name, createdAt: item.created_at, lastSeenAt: item.last_seen_at, expiresAt: item.absolute_expires_at })) }, 200, sessionHeaders(session));
}

async function revokeSession(request, env, publicId) {
  const session = await authenticate(request, env, { csrf: true }); const now = nowMs(env);
  const result = await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE public_id=? AND user_id=? AND revoked_at IS NULL').bind(now, publicId, session.user_id).run();
  if (!Number(result.meta?.changes || 0)) throw httpError(404, 'session_not_found', '找不到可撤銷的裝置工作階段');
  const headers = sessionHeaders(session);
  if (publicId === session.public_id) { appendCookie(headers, clearCookie(SESSION_COOKIE)); appendCookie(headers, clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: 'Strict' })); }
  return json({ ok: true, revoked: publicId }, 200, headers);
}

async function logout(request, env) { const session = await authenticate(request, env, { csrf: true }); return revokeSession(request, env, session.public_id); }

async function revokeGrant(request, env) {
  const session = await authenticate(request, env, { csrf: true }); const now = nowMs(env);
  const credential = await env.DB.prepare('SELECT * FROM oauth_credentials WHERE user_id=?').bind(session.user_id).first();
  try { await revokeGoogleToken(credential?.refresh_token_cipher, env, fetcher(env)); } catch { /* local revocation remains authoritative */ }
  await env.DB.prepare('UPDATE oauth_credentials SET revoked_at=?,reauth_required=1,access_token_cipher=NULL,updated_at=? WHERE user_id=?').bind(now, now, session.user_id).run();
  await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now, session.user_id).run();
  const headers = new Headers(); appendCookie(headers, clearCookie(SESSION_COOKIE)); appendCookie(headers, clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: 'Strict' }));
  return json({ ok: true, revoked: true }, 200, headers);
}

async function createCaptureCredential(request, env) {
  const session = await authenticate(request, env, { csrf: true }); const body = await readJson(request); const now = nowMs(env);
  const name = String(body.name || 'iPhone 捷徑').trim().slice(0, 80) || 'iPhone 捷徑';
  const days = Math.max(1, Math.min(365, Number(body.expiresInDays || 180))); const id = randomToken(12); const secret = randomToken(32);
  await env.DB.prepare('INSERT INTO shortcut_credentials (id,user_id,token_hash,name,created_at,expires_at) VALUES (?,?,?,?,?,?)')
    .bind(id, session.user_id, await sha256Text(secret), name, now, now + days * 86_400_000).run();
  return json({ ok: true, credential: { id, name, createdAt: now, expiresAt: now + days * 86_400_000, scope: 'capture:create' }, token: `pa_capture_${id}.${secret}`, warning: '此憑證只顯示一次；捷徑內的文字並非 Secure Enclave，裝置遺失時請立即撤銷。' }, 201, sessionHeaders(session));
}

async function listCaptureCredentials(request, env) {
  const session = await authenticate(request, env); const result = await env.DB.prepare('SELECT id,name,created_at,last_used_at,expires_at,revoked_at FROM shortcut_credentials WHERE user_id=? ORDER BY created_at DESC LIMIT 30').bind(session.user_id).all();
  return json({ ok: true, credentials: (result.results || []).map(item => ({ id: item.id, name: item.name, createdAt: item.created_at, lastUsedAt: item.last_used_at, expiresAt: item.expires_at, revoked: Boolean(item.revoked_at) })) }, 200, sessionHeaders(session));
}

async function revokeCaptureCredential(request, env, id) {
  const session = await authenticate(request, env, { csrf: true }); const now = nowMs(env);
  const result = await env.DB.prepare('UPDATE shortcut_credentials SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').bind(now, id, session.user_id).run();
  if (!Number(result.meta?.changes || 0)) throw httpError(404, 'credential_not_found', '找不到可撤銷的快捷收藏憑證');
  return json({ ok: true, revoked: id }, 200, sessionHeaders(session));
}

async function authenticateCapture(request, env) {
  if ([...new URL(request.url).searchParams.keys()].some(key => /token|auth|key|secret/i.test(key))) throw httpError(400, 'credential_in_query', '憑證不可放在 URL query');
  const match = /^Bearer\s+pa_capture_([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get('Authorization') || '');
  if (!match) throw httpError(401, 'shortcut_unauthorized', '快捷收藏憑證無效或缺少');
  const now = nowMs(env); const credential = await env.DB.prepare('SELECT * FROM shortcut_credentials WHERE id=?').bind(match[1]).first();
  if (!credential || credential.revoked_at || Number(credential.expires_at) <= now || !safeEqual(credential.token_hash, await sha256Text(match[2]))) throw httpError(401, 'shortcut_expired', '快捷收藏憑證已失效，請在 Pocket Archive 重新配對');
  const windowStart = Math.floor(now / 60_000) * 60_000;
  await env.DB.prepare(`INSERT INTO capture_rate_limits (credential_id,window_start,request_count) VALUES (?,?,1) ON CONFLICT(credential_id,window_start) DO UPDATE SET request_count=request_count+1`).bind(credential.id, windowStart).run();
  const rate = await env.DB.prepare('SELECT request_count FROM capture_rate_limits WHERE credential_id=? AND window_start=?').bind(credential.id, windowStart).first();
  if (Number(rate?.request_count || 0) > 30) throw httpError(429, 'rate_limited', '快捷收藏送出過於頻繁，請稍後重試');
  await env.DB.prepare('UPDATE shortcut_credentials SET last_used_at=? WHERE id=?').bind(now, credential.id).run();
  return credential;
}

function sharedUrl(body) {
  const explicit = typeof body.url === 'string' ? body.url.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 3000) : '';
  const match = text.match(/https?:\/\/[^\s<>"']+/i); const raw = explicit || (match ? match[0].replace(/[),，。]+$/g, '') : '');
  if (!raw) throw httpError(422, 'no_valid_url', '分享內容沒有有效的 HTTP/HTTPS 網址');
  if (raw.length > 2048) throw httpError(413, 'url_too_large', '分享網址過長');
  try { return { raw, canonical: normalizeUrl(raw), text }; }
  catch { throw httpError(422, 'no_valid_url', '分享內容沒有有效的 HTTP/HTTPS 網址'); }
}

async function submitCapture(request, env) {
  const credential = await authenticateCapture(request, env); const idempotencyKey = request.headers.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw httpError(400, 'idempotency_required', '需要 8–128 字元的 Idempotency-Key');
  const body = await readJson(request, 16 * 1024); const value = sharedUrl(body); const now = nowMs(env);
  const replay = await env.DB.prepare('SELECT id,status,result FROM capture_jobs WHERE credential_id=? AND idempotency_key=?').bind(credential.id, idempotencyKey).first();
  if (replay) return json({ ok: true, status: 'duplicate', jobId: replay.id, message: '此請求已收件，未重複建立' }, 200);
  const duplicate = await env.DB.prepare(`SELECT id,status FROM capture_jobs WHERE user_id=? AND canonical_url=? AND created_at>? AND status NOT IN ('failed','expired') ORDER BY created_at DESC LIMIT 1`).bind(credential.user_id, value.canonical, now - 86_400_000).first();
  if (duplicate) return json({ ok: true, status: 'duplicate', jobId: duplicate.id, message: '相同網址已在近期收件佇列中' }, 200);
  const id = `capture_${randomToken(15)}`; const title = String(body.title || '').trim().slice(0, 160); const source = String(body.source || 'ios-shortcut').trim().slice(0, 80) || 'ios-shortcut';
  try {
    await env.DB.prepare(`INSERT INTO capture_jobs (id,user_id,credential_id,idempotency_key,canonical_url,original_url,shared_text,title,source,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .bind(id, credential.user_id, credential.id, idempotencyKey, value.canonical, value.raw, value.text, title, source, now, now + 30 * 86_400_000).run();
  } catch {
    const raced = await env.DB.prepare('SELECT id FROM capture_jobs WHERE credential_id=? AND idempotency_key=?').bind(credential.id, idempotencyKey).first();
    if (raced) return json({ ok: true, status: 'duplicate', jobId: raced.id, message: '此請求已收件，未重複建立' }, 200);
    throw httpError(503, 'capture_store_failed', '暫時無法寫入收件佇列，尚未收件');
  }
  return json({ ok: true, status: 'accepted', jobId: id, message: '已安全送入收件佇列；尚未完成裝置同步' }, 202);
}

async function claimCaptureJobs(request, env) {
  const session = await authenticate(request, env, { csrf: true }); const now = nowMs(env); const limit = Math.max(1, Math.min(20, Number(new URL(request.url).searchParams.get('limit') || 20)));
  await env.DB.prepare(`DELETE FROM capture_jobs WHERE user_id=? AND ((status='completed' AND completed_at<?) OR (status IN ('failed','expired') AND expires_at<?))`).bind(session.user_id, now - 7 * 86_400_000, now).run();
  await env.DB.prepare(`UPDATE capture_jobs SET status='expired',last_error='retention_expired' WHERE user_id=? AND expires_at<=? AND status IN ('pending','leased')`).bind(session.user_id, now).run();
  const candidates = await env.DB.prepare(`SELECT id FROM capture_jobs WHERE user_id=? AND (status='pending' OR (status='leased' AND lease_expires_at<=?)) AND expires_at>? ORDER BY created_at LIMIT ?`).bind(session.user_id, now, now, limit).all();
  const jobs = [];
  for (const candidate of candidates.results || []) {
    const result = await env.DB.prepare(`UPDATE capture_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1 WHERE id=? AND user_id=? AND (status='pending' OR (status='leased' AND lease_expires_at<=?))`).bind(session.public_id, now + 2 * 60_000, candidate.id, session.user_id, now).run();
    if (!Number(result.meta?.changes || 0)) continue;
    const job = await env.DB.prepare('SELECT id,canonical_url,original_url,shared_text,title,source,created_at,attempt_count FROM capture_jobs WHERE id=?').bind(candidate.id).first();
    jobs.push({ id: job.id, url: job.canonical_url, originalUrl: job.original_url, text: job.shared_text, title: job.title, source: job.source, createdAt: job.created_at, attemptCount: job.attempt_count });
  }
  return json({ ok: true, jobs, leaseSeconds: 120 }, 200, sessionHeaders(session));
}

async function acknowledgeCaptureJob(request, env, id) {
  const session = await authenticate(request, env, { csrf: true }); const body = await readJson(request); const now = nowMs(env);
  if (body.status === 'completed') {
    const result = await env.DB.prepare(`UPDATE capture_jobs SET status='completed',result=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,original_url='',shared_text='',title='' WHERE id=? AND user_id=? AND status='leased' AND lease_owner=?`).bind(String(body.result || 'saved').slice(0, 64), now, id, session.user_id, session.public_id).run();
    if (!Number(result.meta?.changes || 0)) throw httpError(409, 'lease_lost', '此收件工作已由另一裝置處理或租約已失效');
  } else if (body.status === 'retry') {
    const job = await env.DB.prepare('SELECT attempt_count FROM capture_jobs WHERE id=? AND user_id=? AND status=\'leased\' AND lease_owner=?').bind(id, session.user_id, session.public_id).first();
    if (!job) throw httpError(409, 'lease_lost', '此收件工作已由另一裝置處理或租約已失效');
    const nextStatus = Number(job.attempt_count) >= 10 ? 'failed' : 'pending';
    await env.DB.prepare('UPDATE capture_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error=? WHERE id=?').bind(nextStatus, String(body.error || 'client_retry').slice(0, 160), id).run();
  } else throw httpError(400, 'invalid_ack', '收件確認狀態無效');
  return json({ ok: true }, 200, sessionHeaders(session));
}

async function accessTokenFor(session, env) {
  const credential = await env.DB.prepare('SELECT * FROM oauth_credentials WHERE user_id=?').bind(session.user_id).first(); const now = nowMs(env);
  try {
    const refreshed = await refreshGoogleAccessToken(credential, env, { fetchImpl: fetcher(env), now });
    if (typeof refreshed === 'string') return refreshed;
    await env.DB.prepare(`UPDATE oauth_credentials SET access_token_cipher=?,access_token_expires_at=?,refresh_token_cipher=COALESCE(?,refresh_token_cipher),refresh_token_expires_at=COALESCE(?,refresh_token_expires_at),scope=?,reauth_required=0,updated_at=? WHERE user_id=?`)
      .bind(refreshed.accessTokenCipher, refreshed.accessTokenExpiresAt, refreshed.refreshTokenCipher, refreshed.refreshTokenExpiresAt, refreshed.scope || credential.scope, now, session.user_id).run();
    return refreshed.accessToken;
  } catch (error) {
    if (error.code === 'reauth_required') await env.DB.prepare('UPDATE oauth_credentials SET reauth_required=1,access_token_cipher=NULL,updated_at=? WHERE user_id=?').bind(now, session.user_id).run();
    throw error;
  }
}

function validFileId(value) { if (!/^[A-Za-z0-9_-]{4,256}$/.test(String(value || ''))) throw httpError(400, 'invalid_file_id', 'Google Drive 檔案 ID 無效'); return value; }
function escapeDriveQuery(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function cleanAppProperties(value) {
  const result = {}; if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value).slice(0, 40)) if (/^[A-Za-z0-9_.:-]{1,64}$/.test(key) && typeof item === 'string' && item.length <= 256) result[key] = item;
  return result;
}
function cleanMetadata(value, creating = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'invalid_metadata', 'Drive metadata 無效');
  const result = {};
  if (creating || value.name !== undefined) { if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 240) throw httpError(400, 'invalid_filename', 'Drive 檔名無效'); result.name = value.name.trim(); }
  if (value.mimeType !== undefined) { if (typeof value.mimeType !== 'string' || value.mimeType.length > 160) throw httpError(400, 'invalid_mime', 'Drive MIME type 無效'); result.mimeType = value.mimeType; }
  if (value.parents !== undefined) { if (!Array.isArray(value.parents) || value.parents.length > 1) throw httpError(400, 'invalid_parent', 'Drive parent 無效'); result.parents = value.parents.map(validFileId); }
  if (value.appProperties !== undefined) result.appProperties = cleanAppProperties(value.appProperties);
  if (value.trashed !== undefined) result.trashed = Boolean(value.trashed);
  return result;
}

async function googleDriveFetch(request, env, session, target, options = {}) {
  const token = await accessTokenFor(session, env); const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${token}`);
  let response;
  try { response = await fetcher(env)(target, { ...options, headers }); }
  catch { throw httpError(503, 'drive_unavailable', 'Google Drive 暫時無法連線'); }
  if (response.status === 401) {
    await env.DB.prepare('UPDATE oauth_credentials SET access_token_cipher=NULL,access_token_expires_at=NULL WHERE user_id=?').bind(session.user_id).run();
    throw httpError(401, 'reauth_required', 'Google Drive 授權已失效，請重新登入');
  }
  return response;
}

async function relayGoogle(response, raw = false) {
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const message = details?.error?.message || 'Google Drive 要求失敗';
    throw httpError(response.status >= 500 ? 503 : response.status, `drive_${response.status}`, message);
  }
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': response.headers.get('content-type') || (raw ? 'application/octet-stream' : 'application/json') });
  if (response.headers.get('content-length')) headers.set('Content-Length', response.headers.get('content-length'));
  return new Response(response.body, { status: response.status, headers });
}

async function driveRoute(request, env, path) {
  const csrf = !['GET', 'HEAD'].includes(request.method); const session = await authenticate(request, env, { csrf });
  if (path === '/api/drive/about' && request.method === 'GET') return relayGoogle(await googleDriveFetch(request, env, session, `${DRIVE_API}/about?fields=user(displayName,emailAddress,photoLink)`));
  if (path === '/api/drive/list' && request.method === 'POST') {
    const body = await readJson(request); const clauses = ['trashed = false'];
    if (body.parentId) clauses.push(`'${escapeDriveQuery(validFileId(body.parentId))}' in parents`);
    if (body.name) { if (typeof body.name !== 'string' || body.name.length > 240) throw httpError(400, 'invalid_filename', 'Drive 檔名無效'); clauses.push(`name = '${escapeDriveQuery(body.name)}'`); }
    if (body.appRole) { if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(body.appRole)) throw httpError(400, 'invalid_role', 'Drive appRole 無效'); clauses.push(`appProperties has { key='paRole' and value='${escapeDriveQuery(body.appRole)}' }`); }
    if (body.mimeType) { if (typeof body.mimeType !== 'string' || body.mimeType.length > 160) throw httpError(400, 'invalid_mime', 'Drive MIME type 無效'); clauses.push(`mimeType = '${escapeDriveQuery(body.mimeType)}'`); }
    const params = new URLSearchParams({ q: clauses.join(' and '), spaces: 'drive', orderBy: body.orderBy === 'createdTime desc' ? body.orderBy : 'modifiedTime desc', pageSize: String(Math.max(1, Math.min(100, Number(body.pageSize || 100)))), fields: `nextPageToken,files(${FILE_FIELDS})` });
    return relayGoogle(await googleDriveFetch(request, env, session, `${DRIVE_API}/files?${params}`));
  }
  if (path === '/api/drive/files' && request.method === 'POST') {
    const metadata = cleanMetadata(await readJson(request), true);
    return relayGoogle(await googleDriveFetch(request, env, session, `${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) }));
  }
  const match = /^\/api\/drive\/files\/([A-Za-z0-9_-]{4,256})(\/content)?$/.exec(path);
  if (!match) throw httpError(404, 'not_found', '找不到 Drive API 路徑');
  const id = validFileId(match[1]); const content = Boolean(match[2]);
  if (!content && request.method === 'GET') return relayGoogle(await googleDriveFetch(request, env, session, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`));
  if (!content && request.method === 'PATCH') {
    const metadata = cleanMetadata(await readJson(request), false);
    return relayGoogle(await googleDriveFetch(request, env, session, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) }));
  }
  if (content && request.method === 'GET') return relayGoogle(await googleDriveFetch(request, env, session, `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`), true);
  if (content && request.method === 'PUT') {
    const mime = (request.headers.get('Content-Type') || 'application/octet-stream').slice(0, 160); const size = Number(request.headers.get('Content-Length') || request.headers.get('X-PA-Content-Length') || 0);
    if (size > 100 * 1024 * 1024) throw httpError(413, 'file_too_large', '檔案超過 100 MB Worker 請求限制');
    if (size > 5 * 1024 * 1024) {
      const start = await googleDriveFetch(request, env, session, `${DRIVE_UPLOAD}/files/${encodeURIComponent(id)}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mime, ...(size ? { 'X-Upload-Content-Length': String(size) } : {}) }, body: '{}' });
      if (!start.ok) return relayGoogle(start); const location = start.headers.get('Location'); if (!location) throw httpError(503, 'drive_upload_failed', 'Google Drive 未回傳續傳位置');
      const uploadHeaders = { 'Content-Type': mime }; if (size) uploadHeaders['Content-Range'] = `bytes 0-${size - 1}/${size}`;
      return relayGoogle(await googleDriveFetch(request, env, session, location, { method: 'PUT', headers: uploadHeaders, body: request.body, duplex: 'half' }));
    }
    return relayGoogle(await googleDriveFetch(request, env, session, `${DRIVE_UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'PATCH', headers: { 'Content-Type': mime }, body: request.body, duplex: 'half' }));
  }
  throw httpError(405, 'method_not_allowed', '不支援的 Drive API 方法');
}

export async function fetchHandler(request, env, ctx = {}) {
  const url = new URL(request.url); const path = url.pathname;
  try {
    let response;
    if (path === '/api/auth/start' && request.method === 'GET') response = await beginAuthorization(request, env, ctx);
    else if (path === '/api/auth/callback' && request.method === 'GET') response = await finishAuthorization(request, env);
    else if (path === '/api/session' && request.method === 'GET') response = await sessionStatus(request, env);
    else if (path === '/api/sessions' && request.method === 'GET') response = await listSessions(request, env);
    else if (path === '/api/logout' && request.method === 'POST') response = await logout(request, env);
    else if (path === '/api/auth/revoke' && request.method === 'POST') response = await revokeGrant(request, env);
    else if (/^\/api\/sessions\/[A-Za-z0-9_-]{8,64}$/.test(path) && request.method === 'DELETE') response = await revokeSession(request, env, path.split('/').pop());
    else if (path === '/api/capture/credentials' && request.method === 'POST') response = await createCaptureCredential(request, env);
    else if (path === '/api/capture/credentials' && request.method === 'GET') response = await listCaptureCredentials(request, env);
    else if (/^\/api\/capture\/credentials\/[A-Za-z0-9_-]{8,64}$/.test(path) && request.method === 'DELETE') response = await revokeCaptureCredential(request, env, path.split('/').pop());
    else if (path === '/api/capture' && request.method === 'POST') response = await submitCapture(request, env);
    else if (path === '/api/capture/jobs/claim' && request.method === 'POST') response = await claimCaptureJobs(request, env);
    else if (/^\/api\/capture\/jobs\/capture_[A-Za-z0-9_-]{8,64}\/ack$/.test(path) && request.method === 'POST') response = await acknowledgeCaptureJob(request, env, path.split('/').at(-2));
    else if (path.startsWith('/api/drive/')) response = await driveRoute(request, env, path);
    else if (path.startsWith('/api/')) response = json({ ok: false, error: { code: 'not_found', message: '找不到 API' } }, 404);
    else if (env.ASSETS) response = await env.ASSETS.fetch(request);
    else response = new Response('Not found', { status: 404 });
    return withSecurityHeaders(response);
  } catch (error) { return withSecurityHeaders(publicError(error)); }
}

export default { fetch: fetchHandler };
