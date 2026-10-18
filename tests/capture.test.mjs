import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fetchHandler } from '../worker/src/index.mjs';
import { bytesToBase64Url, sha256Text } from '../worker/src/security.mjs';

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: result.changes } }; }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.values) }; }
}
class D1 {
  constructor(schema) { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
}

test('shortcut credential is least-privilege, rate-limited and queue leasing is idempotent', async () => {
  const schema = `${await readFile(new URL('../worker/migrations/0001_auth.sql', import.meta.url), 'utf8')}\n${await readFile(new URL('../worker/migrations/0002_capture.sql', import.meta.url), 'utf8')}`;
  const clock = Date.parse('2026-10-18T00:00:00Z'); const database = new D1(schema);
  const sessionRaw = 'session-secret'; const csrf = 'csrf-secret'; const secondRaw = 'second-session';
  database.database.prepare('INSERT INTO users (id,google_sub,email,display_name,picture_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('user-1', 'sub-1', 'owner@example.com', 'Owner', '', clock, clock);
  database.database.prepare('INSERT INTO sessions (id_hash,public_id,user_id,csrf_hash,device_name,created_at,last_seen_at,rotate_after,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(await sha256Text(sessionRaw), 'session-public-1', 'user-1', await sha256Text(csrf), 'iPhone', clock, clock, clock + 86_400_000, clock + 14 * 86_400_000, clock + 30 * 86_400_000);
  database.database.prepare('INSERT INTO sessions (id_hash,public_id,user_id,csrf_hash,device_name,created_at,last_seen_at,rotate_after,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(await sha256Text(secondRaw), 'session-public-2', 'user-1', await sha256Text(csrf), 'Windows', clock, clock, clock + 86_400_000, clock + 14 * 86_400_000, clock + 30 * 86_400_000);
  const env = { DB: database, APP_ORIGIN: 'https://app.example', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', TOKEN_ENCRYPTION_KEY: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), __now: () => clock };
  const sessionHeaders = { Cookie: `__Host-pa_session=${sessionRaw}; __Host-pa_csrf=${csrf}`, Origin: 'https://app.example', 'X-PA-CSRF': csrf, 'Content-Type': 'application/json' };
  const created = await fetchHandler(new Request('https://app.example/api/capture/credentials', { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ name: '我的 iPhone', expiresInDays: 180 }) }), env);
  assert.equal(created.status, 201); const createdBody = await created.json(); assert.match(createdBody.token, /^pa_capture_/); assert.equal(createdBody.credential.scope, 'capture:create');
  const token = createdBody.token;

  const accepted = await fetchHandler(new Request('https://app.example/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'share-request-001', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/story?utm_source=shortcut', text: '值得收藏', title: '範例', source: 'Safari' }) }), env);
  assert.equal(accepted.status, 202); const acceptedBody = await accepted.json(); assert.equal(acceptedBody.status, 'accepted'); assert.match(acceptedBody.message, /尚未完成裝置同步/);
  const replay = await fetchHandler(new Request('https://app.example/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'share-request-001', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/story' }) }), env);
  assert.equal(replay.status, 200); assert.equal((await replay.json()).status, 'duplicate');
  const invalid = await fetchHandler(new Request('https://app.example/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'share-request-002', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '只有文字' }) }), env);
  assert.equal(invalid.status, 422); assert.equal((await invalid.json()).error.code, 'no_valid_url');
  const queryLeak = await fetchHandler(new Request('https://app.example/api/capture?token=oops', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'share-request-003', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.org' }) }), env);
  assert.equal(queryLeak.status, 400); assert.equal((await queryLeak.json()).error.code, 'credential_in_query');

  const claimed = await fetchHandler(new Request('https://app.example/api/capture/jobs/claim?limit=20', { method: 'POST', headers: sessionHeaders }), env); const jobs = (await claimed.json()).jobs;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].url, 'https://example.com/story');
  const secondHeaders = { ...sessionHeaders, Cookie: `__Host-pa_session=${secondRaw}; __Host-pa_csrf=${csrf}` };
  const claimedTwice = await fetchHandler(new Request('https://app.example/api/capture/jobs/claim', { method: 'POST', headers: secondHeaders }), env); assert.equal((await claimedTwice.json()).jobs.length, 0);
  const wrongAck = await fetchHandler(new Request(`https://app.example/api/capture/jobs/${jobs[0].id}/ack`, { method: 'POST', headers: secondHeaders, body: JSON.stringify({ status: 'completed' }) }), env); assert.equal(wrongAck.status, 409);
  const ack = await fetchHandler(new Request(`https://app.example/api/capture/jobs/${jobs[0].id}/ack`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ status: 'completed', result: 'saved' }) }), env); assert.equal(ack.status, 200);

  let limited;
  for (let index = 0; index < 28; index += 1) limited = await fetchHandler(new Request('https://app.example/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `rate-${String(index).padStart(4, '0')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `https://example.net/${index}` }) }), env);
  assert.equal(limited.status, 429); assert.equal((await limited.json()).error.code, 'rate_limited');

  const revoked = await fetchHandler(new Request(`https://app.example/api/capture/credentials/${createdBody.credential.id}`, { method: 'DELETE', headers: sessionHeaders }), env); assert.equal(revoked.status, 200);
  const afterRevoke = await fetchHandler(new Request('https://app.example/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'after-revoke', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.net/revoked' }) }), env); assert.equal(afterRevoke.status, 401);
});
