import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fetchHandler } from '../worker/src/index.mjs';
import { bytesToBase64Url, pkceChallenge, randomToken } from '../worker/src/security.mjs';
import { resetGoogleKeyCache } from '../worker/src/google.mjs';

class D1Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: result.changes } }; }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.values) }; }
}
class TestD1 {
  constructor(schema) { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new D1Statement(this.database, sql); }
}

function cookies(response) { return response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean); }
function cookieValue(values, name) {
  const line = values.find(item => item.startsWith(`${name}=`));
  return line ? decodeURIComponent(line.slice(name.length + 1).split(';')[0]) : '';
}

async function signedIdToken(privateKey, claims) {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })));
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function currentAuthSchema() {
  return `${await readFile(new URL('../worker/migrations/0001_auth.sql', import.meta.url), 'utf8')}\n${await readFile(new URL('../worker/migrations/0003_owner_session_security.sql', import.meta.url), 'utf8')}`;
}

async function oauthFixture({ ownerSub = '100000000000000000001', claimSub = ownerSub, bootstrapToken = '' } = {}) {
  resetGoogleKeyCache();
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey); Object.assign(publicJwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  let clock = Date.parse('2026-10-18T00:00:00Z'); let currentNonce = ''; let currentClaimSub = claimSub; let revoked = 0;
  const env = {
    DB: new TestD1(await currentAuthSchema()), APP_ORIGIN: 'https://app.example', GOOGLE_CLIENT_ID: '123-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'server-secret',
    TOKEN_ENCRYPTION_KEY: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), TOKEN_ENCRYPTION_KEY_VERSION: '1',
    ...(ownerSub ? { OWNER_GOOGLE_SUB: ownerSub } : {}), ...(bootstrapToken ? { OWNER_BOOTSTRAP_TOKEN: bootstrapToken } : {}), __now: () => clock,
    __fetch: async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/oauth2/v3/certs')) return Response.json({ keys: [publicJwk] }, { headers: { 'Cache-Control': 'max-age=600' } });
      if (url.endsWith('/token')) {
        const seconds = Math.floor(clock / 1000);
        return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file', id_token: await signedIdToken(keys.privateKey, { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub: currentClaimSub, email: `${currentClaimSub}@example.com`, email_verified: true, name: 'Account', nonce: currentNonce, iat: seconds, exp: seconds + 3600 }) });
      }
      if (url.endsWith('/revoke')) { revoked += 1; return new Response('', { status: 200 }); }
      if (url.includes('/drive/v3/about')) return Response.json({ user: { emailAddress: `${currentClaimSub}@example.com` } });
      throw new Error(`Unexpected fetch ${url}`);
    }
  };
  async function start(cookieHeader = '') {
    const response = await fetchHandler(new Request('https://app.example/api/auth/start?return_to=%2F', { headers: { Cookie: cookieHeader, 'CF-Connecting-IP': '203.0.113.8' } }), env, { waitUntil() {} });
    if (response.status === 302) currentNonce = new URL(response.headers.get('location')).searchParams.get('nonce');
    return response;
  }
  async function callback(startResponse, extraCookie = '') {
    const authorization = new URL(startResponse.headers.get('location')); const oauth = cookieValue(cookies(startResponse), '__Host-pa_oauth');
    return fetchHandler(new Request(`https://app.example/api/auth/callback?code=code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`, { headers: { Cookie: [`__Host-pa_oauth=${oauth}`, extraCookie].filter(Boolean).join('; ') } }), env);
  }
  return { env, start, callback, setClaimSub(value) { currentClaimSub = value; }, setClock(value) { clock = value; }, revokedCount() { return revoked; } };
}

test('Worker OAuth code flow restores, rotates and revokes a secure session', async () => {
  resetGoogleKeyCache();
  const schema = await currentAuthSchema();
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey); Object.assign(publicJwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  let clock = Date.parse('2026-10-18T00:00:00Z'); let nonce = ''; let challenge = ''; let refreshes = 0; let revoked = 0; let driveFailure = false;
  const env = {
    DB: new TestD1(schema), APP_ORIGIN: 'https://app.example', GOOGLE_CLIENT_ID: '123-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'server-secret',
    TOKEN_ENCRYPTION_KEY: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), TOKEN_ENCRYPTION_KEY_VERSION: '1', OWNER_GOOGLE_SUB: '100000000000000000001', __now: () => clock,
    __fetch: async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/oauth2/v3/certs')) return Response.json({ keys: [publicJwk] }, { headers: { 'Cache-Control': 'max-age=600' } });
      if (url.endsWith('/token')) {
        const body = new URLSearchParams(options.body);
        if (body.get('grant_type') === 'authorization_code') {
          assert.equal(await pkceChallenge(body.get('code_verifier')), challenge, 'PKCE verifier must match start challenge');
          const seconds = Math.floor(clock / 1000);
          return Response.json({ access_token: 'access-first', refresh_token: 'refresh-secret', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file', id_token: await signedIdToken(keys.privateKey, { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub: env.OWNER_GOOGLE_SUB, email: 'owner@example.com', email_verified: true, name: 'Owner', nonce, iat: seconds, exp: seconds + 3600 }) });
        }
        refreshes += 1;
        return Response.json({ access_token: `access-refreshed-${refreshes}`, expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' });
      }
      if (url.endsWith('/revoke')) { revoked += 1; return new Response('', { status: 200 }); }
      if (url.includes('/drive/v3/about')) {
        assert.match(new Headers(options.headers).get('Authorization'), /^Bearer access-/);
        if (driveFailure) return Response.json({ error: { message: 'temporary Drive failure' } }, { status: 500 });
        return Response.json({ user: { emailAddress: 'owner@example.com' } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  };
  const start = await fetchHandler(new Request('https://app.example/api/auth/start?return_to=%2F', { headers: { 'User-Agent': 'iPhone' } }), env, { waitUntil() {} });
  assert.equal(start.status, 302); const authorization = new URL(start.headers.get('location')); nonce = authorization.searchParams.get('nonce'); challenge = authorization.searchParams.get('code_challenge');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256'); assert.match(authorization.searchParams.get('scope'), /drive\.file/);
  const oauthCookie = cookieValue(cookies(start), '__Host-pa_oauth'); assert.ok(oauthCookie);
  const state = authorization.searchParams.get('state');
  const callback = await fetchHandler(new Request(`https://app.example/api/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: `__Host-pa_oauth=${oauthCookie}`, 'User-Agent': 'iPhone' } }), env);
  assert.equal(callback.status, 302); assert.match(callback.headers.get('location'), /auth=success/);
  const sessionCookie = cookieValue(cookies(callback), '__Host-pa_session'); const csrfCookie = cookieValue(cookies(callback), '__Host-pa_csrf');
  assert.ok(sessionCookie); assert.ok(csrfCookie);
  const replay = await fetchHandler(new Request(`https://app.example/api/auth/callback?code=replay&state=${encodeURIComponent(state)}`, { headers: { Cookie: `__Host-pa_oauth=${oauthCookie}` } }), env);
  assert.match(replay.headers.get('location'), /auth=replay_error/);
  const secondStart = await fetchHandler(new Request('https://app.example/api/auth/start?return_to=%2F'), env, { waitUntil() {} });
  const secondAuthorization = new URL(secondStart.headers.get('location')); nonce = secondAuthorization.searchParams.get('nonce'); challenge = secondAuthorization.searchParams.get('code_challenge');
  const secondOauthCookie = cookieValue(cookies(secondStart), '__Host-pa_oauth');
  const secondCallback = await fetchHandler(new Request(`https://app.example/api/auth/callback?code=second-code&state=${encodeURIComponent(secondAuthorization.searchParams.get('state'))}`, { headers: { Cookie: `__Host-pa_oauth=${secondOauthCookie}` } }), env);
  assert.match(secondCallback.headers.get('location'), /auth=success/);
  assert.equal(env.DB.database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1, 're-login must reuse the authorized owner');
  assert.equal(env.DB.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2, 're-login creates a distinct device session');
  const stored = env.DB.database.prepare('SELECT * FROM oauth_credentials').get();
  assert.doesNotMatch(stored.refresh_token_cipher, /refresh-secret/); assert.doesNotMatch(stored.access_token_cipher, /access-first/);

  const cookieHeader = `__Host-pa_session=${sessionCookie}; __Host-pa_csrf=${csrfCookie}`;
  const status = await fetchHandler(new Request('https://app.example/api/session', { headers: { Cookie: cookieHeader } }), env);
  assert.equal(status.status, 200); assert.equal((await status.json()).user.email, 'owner@example.com');
  const aboutCached = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: cookieHeader } }), env); assert.equal(aboutCached.status, 200); assert.equal(refreshes, 0);

  env.DB.database.prepare('UPDATE oauth_credentials SET access_token_expires_at=?').run(clock - 1);
  const aboutRefreshed = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: cookieHeader } }), env); assert.equal(aboutRefreshed.status, 200); assert.equal(refreshes, 1);
  env.DB.database.prepare('UPDATE oauth_credentials SET access_token_expires_at=?').run(clock + 26 * 3600_000);

  clock += 25 * 3600_000;
  const [rotated, concurrentRotation] = await Promise.all([
    fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: cookieHeader } }), env),
    fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: cookieHeader } }), env)
  ]);
  assert.equal(rotated.status, 200); assert.equal(concurrentRotation.status, 200);
  const rotatedSession = cookieValue(cookies(rotated), '__Host-pa_session'); assert.ok(rotatedSession); assert.notEqual(rotatedSession, sessionCookie);
  assert.equal(cookieValue(cookies(concurrentRotation), '__Host-pa_session'), rotatedSession, 'concurrent old-cookie requests converge on the same rotated token');

  const rotatedCookies = `__Host-pa_session=${rotatedSession}; __Host-pa_csrf=${csrfCookie}`;
  clock += 6 * 60_000;
  const afterGraceDrive = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: rotatedCookies } }), env); assert.equal(afterGraceDrive.status, 200);
  const reopenedPwa = await fetchHandler(new Request('https://app.example/api/session', { headers: { Cookie: rotatedCookies } }), env); assert.equal(reopenedPwa.status, 200);
  env.DB.database.prepare('UPDATE oauth_credentials SET access_token_expires_at=?').run(clock + 26 * 3600_000);
  clock += 25 * 3600_000; driveFailure = true;
  const rotatedError = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: rotatedCookies } }), env);
  assert.equal(rotatedError.status, 503); assert.equal((await rotatedError.json()).error.code, 'drive_500');
  const errorRotationCookie = cookieValue(cookies(rotatedError), '__Host-pa_session'); assert.ok(errorRotationCookie); assert.notEqual(errorRotationCookie, rotatedSession);
  driveFailure = false;
  const currentCookies = `__Host-pa_session=${errorRotationCookie}; __Host-pa_csrf=${csrfCookie}`;
  const csrfRejected = await fetchHandler(new Request('https://app.example/api/logout', { method: 'POST', headers: { Cookie: currentCookies, Origin: 'https://evil.example', 'X-PA-CSRF': csrfCookie } }), env);
  assert.equal(csrfRejected.status, 403);
  const grantRevoked = await fetchHandler(new Request('https://app.example/api/auth/revoke', { method: 'POST', headers: { Cookie: currentCookies, Origin: 'https://app.example', 'X-PA-CSRF': csrfCookie } }), env);
  assert.equal(grantRevoked.status, 200); assert.equal(revoked, 1);
  assert.equal(env.DB.database.prepare('SELECT COUNT(*) AS count FROM oauth_credentials').get().count, 0, 'encrypted refresh token must be deleted locally');
  const afterRevoke = await fetchHandler(new Request('https://app.example/api/session', { headers: { Cookie: currentCookies } }), env); assert.equal(afterRevoke.status, 401);
});

test('owner policy defaults closed and rejects an unauthorized signed Google account without persistence', async () => {
  const unconfigured = await oauthFixture({ ownerSub: '', bootstrapToken: '' });
  const deniedStart = await unconfigured.start();
  assert.equal(deniedStart.status, 503); assert.equal((await deniedStart.json()).error.code, 'owner_not_configured');
  assert.equal(unconfigured.env.DB.database.prepare('SELECT COUNT(*) AS count FROM oauth_attempts').get().count, 0);

  const fixture = await oauthFixture({ claimSub: '200000000000000000002' });
  const start = await fixture.start(); assert.equal(start.status, 302);
  const callback = await fixture.callback(start); assert.match(callback.headers.get('location'), /auth=unauthorized_account/);
  assert.equal(fixture.env.DB.database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(fixture.env.DB.database.prepare('SELECT COUNT(*) AS count FROM oauth_credentials').get().count, 0);
  assert.equal(fixture.env.DB.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  assert.equal(fixture.revokedCount(), 1, 'newly issued Google token is revoked best-effort');
});

test('one-time owner bootstrap binds the verified sub and cannot authorize a second account', async () => {
  const fixture = await oauthFixture({ ownerSub: '', claimSub: '300000000000000000003', bootstrapToken: 'a-high-entropy-one-time-secret' });
  const status = await fetchHandler(new Request('https://app.example/api/owner/status'), fixture.env); assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true, configured: false, bindingMethod: null, bootstrapAvailable: true, bootstrapReady: false });
  assert.equal((await fixture.start()).status, 403);
  const rejected = await fetchHandler(new Request('https://app.example/api/owner/bootstrap', { method: 'POST', headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) }), fixture.env, { waitUntil() {} });
  assert.equal(rejected.status, 403);
  const bootstrap = await fetchHandler(new Request('https://app.example/api/owner/bootstrap', { method: 'POST', headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a-high-entropy-one-time-secret' }) }), fixture.env, { waitUntil() {} });
  assert.equal(bootstrap.status, 200); const setupCookie = cookieValue(cookies(bootstrap), '__Host-pa_owner_setup'); assert.ok(setupCookie);
  const start = await fixture.start(`__Host-pa_owner_setup=${setupCookie}`); assert.equal(start.status, 302);
  const callback = await fixture.callback(start, `__Host-pa_owner_setup=${setupCookie}`); assert.match(callback.headers.get('location'), /auth=success/);
  assert.equal(fixture.env.DB.database.prepare('SELECT google_sub FROM owner_identity WHERE singleton=1').get().google_sub, '300000000000000000003');
  fixture.setClaimSub('400000000000000000004');
  const secondStart = await fixture.start(); const secondCallback = await fixture.callback(secondStart);
  assert.match(secondCallback.headers.get('location'), /auth=unauthorized_account/);
  assert.equal(fixture.env.DB.database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
});

test('OAuth start rate limit bounds D1 attempt creation', async () => {
  const fixture = await oauthFixture();
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await fixture.start()).status, 302);
  const limited = await fixture.start(); assert.equal(limited.status, 429);
  assert.equal(fixture.env.DB.database.prepare('SELECT COUNT(*) AS count FROM oauth_attempts').get().count, 10);
});

test('access through the current key safely re-encrypts existing Google credentials after key rotation', async () => {
  const fixture = await oauthFixture(); const start = await fixture.start(); const callback = await fixture.callback(start);
  const session = cookieValue(cookies(callback), '__Host-pa_session'); assert.ok(session);
  const before = fixture.env.DB.database.prepare('SELECT * FROM oauth_credentials').get();
  assert.match(before.refresh_token_cipher, /^v1\./); assert.match(before.access_token_cipher, /^v1\./);
  const previousKey = fixture.env.TOKEN_ENCRYPTION_KEY;
  fixture.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = previousKey; fixture.env.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION = '1';
  fixture.env.TOKEN_ENCRYPTION_KEY = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))); fixture.env.TOKEN_ENCRYPTION_KEY_VERSION = '2';
  const drive = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: `__Host-pa_session=${session}` } }), fixture.env);
  assert.equal(drive.status, 200);
  const after = fixture.env.DB.database.prepare('SELECT * FROM oauth_credentials').get();
  assert.match(after.refresh_token_cipher, /^v2\./); assert.match(after.access_token_cipher, /^v2\./);
  delete fixture.env.TOKEN_ENCRYPTION_KEY_PREVIOUS; delete fixture.env.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION;
  const withoutOldKey = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: `__Host-pa_session=${session}` } }), fixture.env);
  assert.equal(withoutOldKey.status, 200);
});

test('PKCE, encrypted secrets and safe redirect helpers reject unsafe inputs', async () => {
  assert.equal((await pkceChallenge('verifier')).length, 43);
  assert.match(randomToken(), /^[A-Za-z0-9_-]+$/);
});
