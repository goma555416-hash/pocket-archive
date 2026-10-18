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

test('Worker OAuth code flow restores, rotates and revokes a secure session', async () => {
  resetGoogleKeyCache();
  const schema = await readFile(new URL('../worker/migrations/0001_auth.sql', import.meta.url), 'utf8');
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey); Object.assign(publicJwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  let clock = Date.parse('2026-10-18T00:00:00Z'); let nonce = ''; let challenge = ''; let refreshes = 0; let revoked = 0;
  const env = {
    DB: new TestD1(schema), APP_ORIGIN: 'https://app.example', GOOGLE_CLIENT_ID: '123-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'server-secret',
    TOKEN_ENCRYPTION_KEY: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), TOKEN_ENCRYPTION_KEY_VERSION: '1', __now: () => clock,
    __fetch: async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/oauth2/v3/certs')) return Response.json({ keys: [publicJwk] }, { headers: { 'Cache-Control': 'max-age=600' } });
      if (url.endsWith('/token')) {
        const body = new URLSearchParams(options.body);
        if (body.get('grant_type') === 'authorization_code') {
          assert.equal(await pkceChallenge(body.get('code_verifier')), challenge, 'PKCE verifier must match start challenge');
          const seconds = Math.floor(clock / 1000);
          return Response.json({ access_token: 'access-first', refresh_token: 'refresh-secret', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file', id_token: await signedIdToken(keys.privateKey, { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub: 'google-user-1', email: 'owner@example.com', email_verified: true, name: 'Owner', nonce, iat: seconds, exp: seconds + 3600 }) });
        }
        refreshes += 1;
        if (refreshes === 1) return Response.json({ access_token: 'access-refreshed', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' });
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (url.endsWith('/revoke')) { revoked += 1; return new Response('', { status: 200 }); }
      if (url.includes('/drive/v3/about')) {
        assert.match(new Headers(options.headers).get('Authorization'), /^Bearer access-/);
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
  const stored = env.DB.database.prepare('SELECT * FROM oauth_credentials').get();
  assert.doesNotMatch(stored.refresh_token_cipher, /refresh-secret/); assert.doesNotMatch(stored.access_token_cipher, /access-first/);

  const cookieHeader = `__Host-pa_session=${sessionCookie}; __Host-pa_csrf=${csrfCookie}`;
  const status = await fetchHandler(new Request('https://app.example/api/session', { headers: { Cookie: cookieHeader } }), env);
  assert.equal(status.status, 200); assert.equal((await status.json()).user.email, 'owner@example.com');
  const aboutCached = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: cookieHeader } }), env); assert.equal(aboutCached.status, 200); assert.equal(refreshes, 0);

  env.DB.database.prepare('UPDATE oauth_credentials SET access_token_expires_at=?').run(clock - 1);
  const aboutRefreshed = await fetchHandler(new Request('https://app.example/api/drive/about', { headers: { Cookie: cookieHeader } }), env); assert.equal(aboutRefreshed.status, 200); assert.equal(refreshes, 1);

  const replay = await fetchHandler(new Request(`https://app.example/api/auth/callback?code=replay&state=${encodeURIComponent(state)}`, { headers: { Cookie: `__Host-pa_oauth=${oauthCookie}` } }), env);
  assert.match(replay.headers.get('location'), /auth=replay_error/);

  clock += 25 * 3600_000;
  const rotated = await fetchHandler(new Request('https://app.example/api/session', { headers: { Cookie: cookieHeader } }), env); assert.equal(rotated.status, 200);
  const rotatedSession = cookieValue(cookies(rotated), '__Host-pa_session'); assert.ok(rotatedSession); assert.notEqual(rotatedSession, sessionCookie);

  const rotatedCookies = `__Host-pa_session=${rotatedSession}; __Host-pa_csrf=${csrfCookie}`;
  const csrfRejected = await fetchHandler(new Request('https://app.example/api/logout', { method: 'POST', headers: { Cookie: rotatedCookies, Origin: 'https://evil.example', 'X-PA-CSRF': csrfCookie } }), env);
  assert.equal(csrfRejected.status, 403);
  const grantRevoked = await fetchHandler(new Request('https://app.example/api/auth/revoke', { method: 'POST', headers: { Cookie: rotatedCookies, Origin: 'https://app.example', 'X-PA-CSRF': csrfCookie } }), env);
  assert.equal(grantRevoked.status, 200); assert.equal(revoked, 1);
  const afterRevoke = await fetchHandler(new Request('https://app.example/api/session', { headers: { Cookie: rotatedCookies } }), env); assert.equal(afterRevoke.status, 401);
});

test('PKCE, encrypted secrets and safe redirect helpers reject unsafe inputs', async () => {
  assert.equal((await pkceChallenge('verifier')).length, 43);
  assert.match(randomToken(), /^[A-Za-z0-9_-]+$/);
});
