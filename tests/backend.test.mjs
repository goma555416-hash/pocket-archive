import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendDriveApi, PocketBackendClient } from '../backend.mjs';

test('backend detection preserves static-host fallback and adds CSRF only to mutations', async () => {
  const calls = [];
  const client = new PocketBackendClient({
    cookieReader: name => name === '__Host-pa_csrf' ? 'csrf-value' : '',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/session') return new Response(JSON.stringify({ authenticated: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, id: 'file-1234' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  const detected = await client.detectSession();
  assert.equal(detected.available, true); assert.equal(detected.session, null);
  await client.request('/api/example', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(new Headers(calls[1].options.headers).get('X-PA-CSRF'), 'csrf-value');
  assert.equal(new Headers(calls[0].options.headers).get('X-PA-CSRF'), null);
});

test('backend Drive client keeps file bytes behind same-origin API', async () => {
  const calls = [];
  const client = { request: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/drive/files') return { id: 'drive-file-1' };
    return { id: 'drive-file-1', size: '3' };
  } };
  const drive = new BackendDriveApi(client);
  await drive.createFile({ name: 'journal.json', parentId: 'folder-1', blob: new Blob(['abc'], { type: 'application/json' }), appProperties: { paRole: 'syncJournal' } });
  assert.equal(calls[0].path, '/api/drive/files');
  assert.equal(calls[1].path, '/api/drive/files/drive-file-1/content');
  assert.equal(calls[1].options.headers['X-PA-Content-Length'], '3');
});
