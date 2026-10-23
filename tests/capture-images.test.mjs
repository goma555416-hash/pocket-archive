import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fetchHandler, scheduledHandler } from '../worker/src/index.mjs';
import { bytesToBase64Url, encryptSecret, sha256Text } from '../worker/src/security.mjs';
import { boundedBytes, CAPTURE_IMAGE_LIMIT } from '../worker/src/capture-images.mjs';
import { receiveCaptureJob } from '../capture-client.mjs';
import { sha256 } from '../lib.mjs';

const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { return { meta: { changes: this.db.prepare(this.sql).run(...this.args).changes } }; }
}
async function fixture() {
  const db = new DatabaseSync(':memory:'); const directory = new URL('../worker/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).sort()) db.exec(await readFile(new URL(file, directory), 'utf8'));
  let clock = Date.parse('2026-10-19T00:00:00Z'); let sequence = 0; const files = new Map(); const calls = []; let failure = ''; let shared = false;
  const env = { DB: { prepare: sql => new Statement(db, sql) }, GOOGLE_CLIENT_ID: 'anonymous-test', GOOGLE_CLIENT_SECRET: 'synthetic', APP_ORIGIN: 'https://app.example', OWNER_GOOGLE_SUB: 'owner-0001', TOKEN_ENCRYPTION_KEY: bytesToBase64Url(new Uint8Array(32).fill(8)), __now: () => clock };
  env.__fetch = async (target, options = {}) => {
    const url = new URL(target); const method = options.method || 'GET'; calls.push({ url: url.pathname, method });
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
    if (failure === 'drive') return Response.json({}, { status: 503 });
    if (url.pathname.endsWith('/generateIds')) { if (failure === 'expire') clock += 601_000; return Response.json({ ids: [`image-file-${++sequence}`] }); }
    if (url.pathname.endsWith('/permissions')) return Response.json({ permissions: [{ type: shared ? 'anyone' : 'user', role: shared ? 'reader' : 'owner' }] });
    if (url.pathname.endsWith('/files') && method === 'POST') {
      const meta = JSON.parse(options.body); const file = { ...meta, id: meta.id || `folder-${++sequence}` }; files.set(file.id, file); return Response.json(file);
    }
    const id = url.pathname.split('/').at(-1); const file = files.get(id);
    if (!file) return Response.json({}, { status: 404 });
    if (method === 'PATCH' && url.searchParams.has('uploadType')) {
      file.bytes = new Uint8Array(options.body); if (failure === 'ambiguous') throw new Error('response lost after write');
      return Response.json({ id, size: file.bytes.length });
    }
    if (method === 'PATCH') { Object.assign(file, JSON.parse(options.body)); return Response.json(file); }
    if (url.searchParams.get('alt') === 'media') return new Response(failure === 'corrupt' ? png.subarray(0, 8) : file.bytes, { headers: { 'Content-Type': file.mimeType } });
    return Response.json(file);
  };
  db.prepare('INSERT INTO users (id,google_sub,email,display_name,picture_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('u1', env.OWNER_GOOGLE_SUB, 'anonymous@example.test', '', '', clock, clock);
  db.prepare('INSERT INTO oauth_credentials (user_id,refresh_token_cipher,access_token_cipher,access_token_expires_at,scope,updated_at) VALUES (?,?,?,?,?,?)').run('u1', await encryptSecret('test-refresh', env), await encryptSecret('test-access', env), clock + 3600_000, 'drive.file', clock);
  for (const id of ['one', 'two']) db.prepare('INSERT INTO sessions (id_hash,public_id,user_id,csrf_hash,device_name,created_at,last_seen_at,rotate_after,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(await sha256Text(`session-${id}`), `public-${id}`, 'u1', await sha256Text('csrf'), id, clock, clock, clock + 86400_000, clock + 30 * 86400_000, clock + 30 * 86400_000);
  const credentialId = 'shortcut0001'; const secret = 'a'.repeat(40);
  db.prepare('INSERT INTO shortcut_credentials (id,user_id,token_hash,name,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(credentialId, 'u1', await sha256Text(secret), 'test', clock, clock + 30 * 86400_000);
  const token = `pa_capture_${credentialId}.${secret}`;
  let leaseVersion = '1';
  const headers = device => ({ Cookie: `__Host-pa_session=session-${device}; __Host-pa_csrf=csrf`, Origin: env.APP_ORIGIN, 'X-PA-CSRF': 'csrf', 'Content-Type': 'application/json', 'X-PA-Lease-Version': leaseVersion });
  const request = (path, method, body, device = 'one') => fetchHandler(new Request(env.APP_ORIGIN + path, { method, headers: headers(device), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  let keys = 0;
  const upload = (bytes = png, extra = {}) => fetchHandler(new Request(`${env.APP_ORIGIN}/api/capture/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `image-request-${++keys}`, 'Content-Type': 'image/png', 'X-PA-Filename': encodeURIComponent('測試原圖.png'), ...extra }, body: bytes }), env);
  return { db, env, calls, files, upload, request, token, advance: ms => { clock += ms; }, setFailure: value => { failure = value; }, setShared: value => { shared = value; }, setLease: v => { leaseVersion = String(v); } };
}

test('image capture preserves bytes/name/MIME/hash, deduplicates, scopes reads and rejects expired leases', async () => {
  const f = await fixture(); const response = await f.upload(); assert.equal(response.status, 202, await response.clone().text());
  const accepted = await response.json(); assert.equal(accepted.sha256, await sha256(png)); assert.match(accepted.message, /尚未入庫/);
  const row = f.db.prepare("SELECT * FROM capture_images WHERE status='ready'").get(); assert.equal(row.name, '測試原圖.png'); assert.equal(row.size, png.length);
  assert.deepEqual(f.files.get(row.file_id).bytes, png); assert.equal(f.files.get(row.file_id).parents.length, 1);
  assert.equal((await f.upload()).status, 200); assert.equal((await f.upload(png, { 'Idempotency-Key': 'image-request-1' })).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM capture_jobs').get().n, 1);
  const shortcutRead = await fetchHandler(new Request(`${f.env.APP_ORIGIN}/api/capture/jobs/${accepted.jobId}/content`, { headers: { Authorization: `Bearer ${f.token}` } }), f.env); assert.equal(shortcutRead.status, 401);
  const shortcutDrive = await fetchHandler(new Request(`${f.env.APP_ORIGIN}/api/drive/files/${row.file_id}`, { headers: { Authorization: `Bearer ${f.token}` } }), f.env); assert.equal(shortcutDrive.status, 401);
  const claim = await (await f.request('/api/capture/jobs/claim?limit=1', 'POST')).json(); assert.equal(claim.jobs[0].kind, 'image'); assert.equal(claim.jobs[0].attachment.hash, accepted.sha256);
  assert.equal((await f.request(`/api/capture/jobs/${accepted.jobId}/content`, 'GET', undefined, 'two')).status, 409);
  const raw = await f.request(`/api/capture/jobs/${accepted.jobId}/content`, 'GET'); assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), png);
  f.advance(121_000);
  assert.equal((await f.request(`/api/capture/jobs/${accepted.jobId}/ack`, 'POST', { status: 'completed' })).status, 409);
  assert.equal((await f.request(`/api/capture/jobs/${accepted.jobId}/content`, 'GET')).status, 409);
  const reclaimed = await (await f.request('/api/capture/jobs/claim?limit=1', 'POST', undefined, 'two')).json(); assert.equal(reclaimed.jobs[0].id, accepted.jobId);
  assert.equal((await f.request(`/api/capture/jobs/${accepted.jobId}/ack`, 'POST', { status: 'retry', leaseVersion: 1 }, 'two')).status, 409); f.setLease(2);
  assert.equal((await f.request(`/api/capture/jobs/${accepted.jobId}/ack`, 'POST', { status: 'completed', leaseVersion: 2 }, 'two')).status, 200);
  assert.equal(f.db.prepare('SELECT status FROM capture_images WHERE id=?').get(row.id).status, 'completed');
  f.advance(86400_001); await scheduledHandler({}, f.env); assert.equal(f.files.get(row.file_id).trashed, true);
});

test('completed image can be safely recaptured after deletion without reusing a tombstoned job', async () => {
  const f = await fixture();
  const firstResponse = await f.upload();
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();

  // Repeated uploads while the first delivery is still pending remain duplicates.
  assert.equal((await f.upload()).status, 200);
  const firstClaim = await (await f.request('/api/capture/jobs/claim?limit=1', 'POST')).json();
  assert.equal(firstClaim.jobs[0].id, first.jobId);
  assert.equal((await f.request(`/api/capture/jobs/${first.jobId}/ack`, 'POST', {
    status: 'completed', result: 'saved', leaseVersion: 1
  })).status, 200);

  // The bookmark can now be deleted in IndexedDB / synchronized as a tombstone.
  // The Worker holds no authoritative live-bookmark inventory, so a NEW share
  // must enqueue a fresh job even if an older completed SHA-256 is present.
  const newResponse = await f.upload();
  assert.equal(newResponse.status, 202);
  const second = await newResponse.json();
  assert.notEqual(second.jobId, first.jobId);
  assert.equal(second.sha256, first.sha256);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM capture_jobs').get().n, 2);
  assert.equal((await f.upload()).status, 200, 'while new job is pending, same hash is a duplicate');

  // Same HTTP idempotency key is still a duplicate, even after a completed ack.
  assert.equal((await f.upload(png, { 'Idempotency-Key': 'image-request-1' })).status, 200);
  const nextClaim = await (await f.request('/api/capture/jobs/claim?limit=1', 'POST')).json();
  assert.equal(nextClaim.jobs.length, 1);
  assert.equal(nextClaim.jobs[0].id, second.jobId);
  assert.equal(nextClaim.jobs[0].attachment.hash, second.sha256);
  assert.equal((await f.request(`/api/capture/jobs/${second.jobId}/ack`, 'POST', {
    status: 'completed', result: 'saved', leaseVersion: 1
  })).status, 200);
});

test('single/multiple images validate MIME, signature, size, filenames, unknown-length streams and rate limits', async () => {
  const f = await fixture();
  assert.equal((await f.upload(png, { 'Content-Type': 'image/jpeg' })).status, 415);
  assert.equal((await f.upload(png, { 'Content-Type': 'image/svg+xml' })).status, 415);
  assert.equal((await f.upload(png, { 'X-PA-Filename': '%2Fetc%2Fpasswd' })).status, 400);
  assert.equal((await f.upload(png, { 'Content-Length': String(CAPTURE_IMAGE_LIMIT + 1) })).status, 413);
  assert.equal((await f.upload(new Uint8Array())).status, 400);
  const over = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(CAPTURE_IMAGE_LIMIT)); c.enqueue(new Uint8Array(1)); c.close(); } });
  await assert.rejects(() => boundedBytes(over), error => error.status === 413);
  const other = new Uint8Array([...png, 42]); const results = [];
  for (const bytes of [png, other, png]) results.push((await (await f.upload(bytes)).json()).status);
  assert.deepEqual(results, ['accepted', 'accepted', 'duplicate']);
  let rate; for (let i = 0; i < 25; i++) rate = await f.upload(); assert.equal(rate.status, 429);
});

test('Drive failure, corruption, shared folder and ambiguous upload never report accepted; cleanup retries orphan IDs', async () => {
  for (const failure of ['drive', 'corrupt', 'ambiguous', 'shared']) {
    const f = await fixture(); if (failure === 'shared') f.setShared(true); else f.setFailure(failure);
    const response = await f.upload(); assert.ok(response.status >= 400, failure); assert.notEqual((await response.json()).status, 'accepted');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM capture_images WHERE status='ready'").get().n, 0);
    const row = f.db.prepare('SELECT * FROM capture_images').get();
    f.setFailure('drive'); await scheduledHandler({}, f.env);
    if (row.file_id) assert.equal(f.db.prepare('SELECT cleaned_at FROM capture_images WHERE id=?').get(row.id).cleaned_at, null);
    f.setFailure(''); await scheduledHandler({}, f.env);
    if (row.file_id) assert.equal(f.files.get(row.file_id).trashed, true);
    assert.ok(f.db.prepare('SELECT cleaned_at FROM capture_images WHERE id=?').get(row.id).cleaned_at);
  }
});

test('atomic quota reservation bounds daily, pending storage and concurrent uploads', async () => {
  const f = await fixture();
  f.db.prepare("INSERT INTO capture_images (id,user_id,credential_id,idempotency_key,status,name,mime_type,size,created_at,expires_at) VALUES ('busy','u1','shortcut0001','busy-key','receiving','x','image/png',1,?,?)").run(f.env.__now(), f.env.__now()+60000);
  assert.equal((await f.upload()).status, 409);
  f.db.prepare("UPDATE capture_images SET status='completed',size=? WHERE id='busy'").run(50*1024*1024);
  assert.equal((await f.upload()).status, 429);
  f.advance(86400_001); f.db.prepare("UPDATE capture_images SET status='ready',size=? WHERE id='busy'").run(100*1024*1024);
  assert.equal((await f.upload()).status, 429);
});

test('client verifies before commit/ack and retries a durable receipt after lost ack', async () => {
  const hash = await sha256(png); const job = { kind: 'image', id: `capture_${hash}`, attachment: { id: `att-${hash}`, name: 'test.png', size: png.length, mimeType: 'image/png', hash }, createdAt: Date.now() };
  let commits = 0; let acknowledgments = 0; let receipt = false; let brokenAck = true;
  const repository = { async commitCapture(entry, blob) { commits++; assert.equal(entry.id, job.id); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), png); const result = receipt ? 'duplicate' : 'saved'; receipt = true; return result; } };
  const backend = { downloadCaptureImage: async () => new Blob([png], { type: 'image/png' }), async acknowledgeCaptureJob() { acknowledgments++; if (brokenAck) throw new Error('offline'); } };
  await assert.rejects(() => receiveCaptureJob(job, backend, repository, 'device'), /offline/);
  brokenAck = false; assert.equal(await receiveCaptureJob(job, backend, repository, 'device'), 'duplicate');
  backend.downloadCaptureImage = async () => new Blob([png.subarray(0, 8)], { type: 'image/png' });
  await assert.rejects(() => receiveCaptureJob(job, backend, repository, 'device'), /不符/);
  assert.equal(commits, 2); assert.equal(acknowledgments, 2);
});

test('supported original formats are stored without conversion and an expired intent is reclaimable', async () => {
  const f = await fixture();
  const formats = [
    ['image/jpeg', new Uint8Array([255,216,255,224,0,16])],
    ['image/gif', new TextEncoder().encode('GIF89a123456')],
    ['image/webp', new TextEncoder().encode('RIFF1234WEBP')],
    ['image/heic', new Uint8Array([0,0,0,24,...new TextEncoder().encode('ftypheic0000heicmif1')])],
    ['image/heif', new Uint8Array([0,0,0,24,...new TextEncoder().encode('ftypmif10000mif1')])]
  ];
  for (const [mime, bytes] of formats) {
    const response = await f.upload(bytes, { 'Content-Type': mime }); assert.equal(response.status, 202, await response.clone().text());
    assert.equal((await response.json()).sha256, await sha256(bytes));
  }
  const exact = new Uint8Array(CAPTURE_IMAGE_LIMIT); exact.set(png);
  assert.equal((await f.upload(exact)).status, 202, '4 MiB inclusive boundary');
  f.db.prepare("INSERT INTO capture_images (id,user_id,credential_id,idempotency_key,status,name,mime_type,size,created_at,expires_at) VALUES ('abandoned','u1','shortcut0001','abandoned-key','receiving','x','image/png',4194304,?,?)").run(f.env.__now(), f.env.__now()+600000);
  f.advance(600001); await scheduledHandler({}, f.env);
  assert.equal(f.db.prepare("SELECT status FROM capture_images WHERE id='abandoned'").get().status, 'expired');
  assert.equal((await f.upload(new Uint8Array([...png, 1, 2, 3]))).status, 202);
});


test('slow body has an absolute deadline and expired intents cannot create an untracked Drive file', async () => {
  let cancelled = false;
  const stalled = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(() => boundedBytes(stalled, CAPTURE_IMAGE_LIMIT, 20), error => error.code === 'image_timeout'); assert.equal(cancelled, true);
  const f = await fixture(); f.setFailure('expire');
  assert.equal((await f.upload()).status, 409);
  assert.equal([...f.files.values()].filter(file => file.appProperties?.paRole === 'captureImage').length, 0);
});
