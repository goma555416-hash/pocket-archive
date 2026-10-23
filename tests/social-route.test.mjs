import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fetchHandler } from '../worker/src/index.mjs';
import { bytesToBase64Url, sha256Text } from '../worker/src/security.mjs';

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
  async run() { return { meta: { changes: this.db.prepare(this.sql).run(...this.values).changes } }; }
}

test('social metadata route enforces login, CSRF, trusted provider and bounded response', async () => {
  const database = new DatabaseSync(':memory:');
  const directory = new URL('../worker/migrations/', import.meta.url);
  for (const migration of (await readdir(directory)).sort()) database.exec(await readFile(new URL(migration, directory), 'utf8'));
  const now = Date.parse('2026-10-23T00:00:00Z');
  const raw = 'social-test-session', csrf = 'social-csrf';
  const ownerSub = '100000000000000000001';
  database.prepare('INSERT INTO users (id,google_sub,email,display_name,picture_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('u1', ownerSub, 'private@example.test', '', '', now, now);
  database.prepare('INSERT INTO sessions (id_hash,public_id,user_id,csrf_hash,device_name,created_at,last_seen_at,rotate_after,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(await sha256Text(raw), 'social-public-1', 'u1', await sha256Text(csrf), 'iPhone', now, now, now + 86400000, now + 14 * 86400000, now + 30 * 86400000);
  let providerCalls = 0;
  const env = {
    DB: { prepare: sql => new Statement(database, sql) }, __now: () => now,
    OWNER_GOOGLE_SUB: ownerSub, APP_ORIGIN: 'https://app.example',
    GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: bytesToBase64Url(new Uint8Array(32).fill(2)),
    __fetch: async (url, options) => {
      providerCalls++;
      assert.equal(new URL(url).origin, 'https://www.youtube.com');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return Response.json({
        provider_name: 'YouTube', title: 'Synthetic published video',
        author_name: 'Synthetic creator', thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      });
    }
  };
  const path = 'https://app.example/api/social/metadata';
  const body = JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ?feature=share' });
  const headers = { Cookie: `__Host-pa_session=${raw}; __Host-pa_csrf=${csrf}`,
    Origin: 'https://app.example', 'X-PA-CSRF': csrf, 'Content-Type': 'application/json' };
  const call = (h, data = body) => fetchHandler(new Request(path, { method: 'POST', headers: h, body: data }), env);
  assert.equal((await call({ 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await call({ ...headers, 'X-PA-CSRF': '' })).status, 403);
  assert.equal((await call({ ...headers, Origin: 'https://evil.example' })).status, 403);
  assert.equal(providerCalls, 0, 'unauthorized requests cannot call the provider');

  const result = await call(headers);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const metadata = (await result.json()).metadata;
  assert.equal(metadata.title, 'Synthetic published video');
  assert.equal(metadata.contentRead, false);
  assert.equal(Object.hasOwn(metadata, 'html'), false);
  assert.equal(providerCalls, 1);

  const unsupported = await call(headers, JSON.stringify({ url: 'https://www.instagram.com/p/ABC123/' }));
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, 'unsupported_social_url');
  assert.equal(providerCalls, 1, 'disallowed URLs cannot trigger external requests');

  for (let index = 0; index < 28; index++) assert.equal((await call(headers)).status, 200);
  const limited = await call(headers);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'rate_limited');
  assert.equal(providerCalls, 29);
  database.close();
});
