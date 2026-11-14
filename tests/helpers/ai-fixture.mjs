// Shared fixture for AI job Worker tests: in-memory D1, an owner session,
// a fake Google Drive and a fake Claude routine /fire endpoint.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fetchHandler, scheduledHandler } from '../../worker/src/index.mjs';
import { bytesToBase64Url, encryptSecret, sha256Text } from '../../worker/src/security.mjs';

export let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node 20: skipped */ }

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

export const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
export const md5 = text => createHash('md5').update(text).digest('hex');
export const sha = text => createHash('sha256').update(text).digest('hex');

export async function aiFixture({ configured = true } = {}) {
  let schema = '';
  for (const name of ['0001_auth', '0002_capture', '0003_owner_session_security', '0004_capture_images', '0005_ai_jobs']) {
    schema += `${await readFile(new URL(`../../worker/migrations/${name}.sql`, import.meta.url), 'utf8')}\n`;
  }
  const db = new D1(schema);
  let clock = Date.parse('2026-11-14T00:00:00Z');
  const env = {
    DB: db, APP_ORIGIN: 'https://app.example', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret',
    OWNER_GOOGLE_SUB: '100000000000000000001', TOKEN_ENCRYPTION_KEY: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), TOKEN_ENCRYPTION_KEY_VERSION: '1',
    __now: () => clock,
    ...(configured ? { AI_ROUTINE_FIRE_URL: FIRE_URL, AI_ROUTINE_FIRE_TOKEN: 'routine-secret-token' } : {})
  };
  for (const [id, sub] of [['user-1', '100000000000000000001'], ['user-2', '100000000000000000002']]) {
    db.database.prepare('INSERT INTO users (id,google_sub,email,display_name,picture_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, sub, `${id}@example.com`, id, '', clock, clock);
    db.database.prepare('INSERT INTO oauth_credentials (user_id,refresh_token_cipher,access_token_cipher,access_token_expires_at,scope,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, await encryptSecret('refresh', env), await encryptSecret(`access-${id}`, env), clock + 365 * 86_400_000, 'https://www.googleapis.com/auth/drive.file', clock);
  }
  const sessionRaw = 'session-secret'; const csrf = 'csrf-secret';
  db.database.prepare('INSERT INTO sessions (id_hash,public_id,user_id,csrf_hash,device_name,created_at,last_seen_at,rotate_after,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(await sha256Text(sessionRaw), 'session-public-1', 'user-1', await sha256Text(csrf), 'iPhone', clock, clock, clock + 365 * 86_400_000, clock + 365 * 86_400_000, clock + 365 * 86_400_000);
  const sessionHeaders = { Cookie: `__Host-pa_session=${sessionRaw}; __Host-pa_csrf=${csrf}`, Origin: 'https://app.example', 'X-PA-CSRF': csrf, 'Content-Type': 'application/json' };

  // Fake Drive: files keyed by id; content is a string.
  const files = new Map(); const uploads = []; const fires = [];
  let fireResponse = () => Response.json({ type: 'routine_fire', claude_code_session_id: 'session_x', claude_code_session_url: 'https://claude.ai/code/session_x' });
  let readBackOverride = null;
  function putFile(id, meta, content = '') { files.set(id, { meta: { id, version: '1', md5Checksum: md5(content), trashed: false, ...meta }, content }); }
  env.__fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (String(input) === FIRE_URL) { fires.push({ headers: Object.fromEntries(new Headers(options.headers).entries()), body: options.body }); return fireResponse(); }
    const match = /\/drive\/v3\/files\/([^/?]+)/.exec(url.pathname);
    if (!match) throw new Error(`Unexpected fetch ${input}`);
    const file = files.get(decodeURIComponent(match[1]));
    if (!file) return Response.json({ error: { message: 'not found' } }, { status: 404 });
    if (url.pathname.startsWith('/upload/') && options.method === 'PATCH') {
      const text = typeof options.body === 'string' ? options.body : await new Response(options.body).text();
      uploads.push({ id: file.meta.id, text });
      file.content = text; file.meta.version = String(Number(file.meta.version) + 1); file.meta.md5Checksum = md5(text);
      return Response.json(file.meta);
    }
    if (url.searchParams.get('alt') === 'media') {
      const content = readBackOverride && uploads.length ? readBackOverride : file.content;
      return new Response(content, { headers: { 'content-type': file.meta.mimeType || 'application/octet-stream' } });
    }
    return Response.json(file.meta);
  };

  function seedBatch(exportId, { itemIds = ['a', 'b'], inboxContent = '{"inbox":true}', zip = false } = {}) {
    const inboxId = `inbox-${exportId}`; const resultId = `result-${exportId}`;
    putFile('folder-inbox', { name: 'AI-Inbox', mimeType: 'application/vnd.google-apps.folder', appProperties: { paRole: 'aiInbox' } });
    putFile('folder-results', { name: 'AI-Results', mimeType: 'application/vnd.google-apps.folder', appProperties: { paRole: 'aiResults' } });
    putFile(inboxId, { name: `pocket-archive-inbox-2026-11-14-${exportId}.${zip ? 'zip' : 'json'}`, mimeType: zip ? 'application/zip' : 'application/json', parents: ['folder-inbox'], appProperties: { paRole: 'aiInbox', exportId, resultFileId: resultId } }, inboxContent);
    const pending = JSON.stringify({ format: 'pocket-archive-organized', schema_version: 2, source_export_id: exportId, status: 'pending', items: [] });
    putFile(resultId, { name: `organized-${exportId}.json`, mimeType: 'application/json', parents: ['folder-results'], appProperties: { paRole: 'aiResult', exportId, inboxFileId: inboxId, status: 'pending' } }, pending);
    return { exportId, inboxFileId: inboxId, resultFileId: resultId, inboxFolderId: 'folder-inbox', resultsFolderId: 'folder-results', itemIds, inboxSha256: sha(inboxContent), pendingSha256: sha(pending), deviceId: 'device-iphone' };
  }

  const call = (path, init = {}) => fetchHandler(new Request(`https://app.example${path}`, init), env, { waitUntil() {} });
  const session = (path, method = 'GET', body) => call(path, { method, headers: sessionHeaders, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const agent = (token, path, method = 'GET', body) => call(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) });
  const row = exportId => db.database.prepare('SELECT * FROM ai_jobs WHERE export_id=?').get(exportId);
  const cron = () => scheduledHandler({}, env, {});
  async function newAgentToken(name = 'Claude routine') {
    const response = await session('/api/ai/agent-credentials', 'POST', { name });
    return (await response.json()).token;
  }
  return {
    env, db, files, uploads, fires, putFile, seedBatch, call, session, agent, row, cron, newAgentToken,
    setFireResponse(fn) { fireResponse = fn; }, setReadBack(text) { readBackOverride = text; },
    advance(ms) { clock += ms; }, now: () => clock
  };
}
