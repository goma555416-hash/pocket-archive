import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentCommand } from '../scripts/routine-agent.mjs';

const TOKEN = 'pa_agent_abcdefgh.' + 's'.repeat(40);
const env = { PA_AGENT_TOKEN: TOKEN, PA_BACKEND_ORIGIN: 'https://backend.example' };
const sink = () => { const lines = []; return { lines, write: text => { lines.push(String(text)); } }; };
const sha = text => createHash('sha256').update(text).digest('hex');

test('inbox verifies SHA-256 and deletes the file on mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pa-agent-'));
  const content = '{"format":"pocket-archive-inbox"}';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/inbox')) return new Response(content);
    return Response.json({ ok: true, job: { exportId: 'export-x', attempt: 1, itemIds: ['a'], inboxName: 'x.json', inboxMimeType: 'application/json', inboxSha256: sha(content) } });
  };
  const out = sink(); const err = sink();
  const okPath = join(dir, 'ok.json');
  assert.equal(await runAgentCommand(['inbox', 'export-x', '1', okPath], { env, fetchImpl, stdout: out, stderr: err }), 0);
  assert.equal(await readFile(okPath, 'utf8'), content);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(calls[1].url, /\/api\/ai\/agent\/jobs\/export-x\/inbox\?attempt=1$/);

  const badFetch = async url => String(url).includes('/inbox') ? new Response('tampered') : Response.json({ ok: true, job: { inboxSha256: sha(content) } });
  const badPath = join(dir, 'bad.json');
  assert.notEqual(await runAgentCommand(['inbox', 'export-x', '1', badPath], { env, fetchImpl: badFetch, stdout: out, stderr: err }), 0);
  await assert.rejects(() => access(badPath));
  assert.ok(![...out.lines, ...err.lines].join('\n').includes(TOKEN.split('.')[1]));
});

test('submit sends bearer token and attempt, never prints the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pa-agent-'));
  const file = join(dir, 'organized.json'); await writeFile(file, '{"items":[]}');
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), init }); return Response.json({ ok: true, job: { status: 'ready' } }); };
  const out = sink(); const err = sink();
  assert.equal(await runAgentCommand(['submit', 'export-x', '2', file], { env, fetchImpl, stdout: out, stderr: err }), 0);
  assert.equal(calls[0].url, 'https://backend.example/api/ai/agent/jobs/export-x/result?attempt=2');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.body, '{"items":[]}');
  assert.ok(out.lines.join('').includes('ready'));
  assert.ok(![...out.lines, ...err.lines].join('\n').includes(TOKEN.split('.')[1]));

  const failing = async () => Response.json({ ok: false, error: { code: 'result_evidence', message: '缺少證據' } }, { status: 422 });
  assert.notEqual(await runAgentCommand(['submit', 'export-x', '2', file], { env, fetchImpl: failing, stdout: out, stderr: err }), 0);
  assert.ok(err.lines.join('').includes('result_evidence'));
});

test('fail command posts sanitized reason', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), init }); return Response.json({ ok: true, job: { status: 'failed' } }); };
  assert.equal(await runAgentCommand(['fail', 'export-x', '1', 'auth_required', '來源需要登入'], { env, fetchImpl, stdout: sink(), stderr: sink() }), 0);
  assert.equal(calls[0].url, 'https://backend.example/api/ai/agent/jobs/export-x/fail?attempt=1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: 'auth_required', message: '來源需要登入' });
});

test('works with no environment: default backend, token left to the network secret proxy', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), init }); return Response.json({ ok: true, job: { exportId: 'export-x' } }); };
  assert.equal(await runAgentCommand(['job', 'export-x', '1'], { env: {}, fetchImpl, stdout: sink(), stderr: sink() }), 0);
  assert.equal(calls[0].url, 'https://pocket-archive.goma555416.workers.dev/api/ai/agent/jobs/export-x?attempt=1');
  assert.equal(new Headers(calls[0].init.headers).has('Authorization'), false, 'must not send an Authorization header itself');
});

test('rejects a non-https backend override and invalid export ids', async () => {
  const err = sink();
  assert.notEqual(await runAgentCommand(['job', 'export-x', '1'], { env: { PA_BACKEND_ORIGIN: 'http://insecure.example' }, fetchImpl: async () => { throw new Error('should not fetch'); }, stdout: sink(), stderr: err }), 0);
  assert.ok(err.lines.join('').includes('PA_BACKEND_ORIGIN'));
  const bad = sink();
  assert.notEqual(await runAgentCommand(['job', 'not-an-export', '1'], { env, fetchImpl: async () => { throw new Error('no'); }, stdout: sink(), stderr: bad }), 0);
});

test('uses curl (which honours the sandbox proxy) when a proxy is configured', async () => {
  const { pickTransport } = await import('../scripts/routine-agent.mjs');
  assert.equal(pickTransport({ HTTPS_PROXY: 'http://proxy:8080' }), 'curl');
  assert.equal(pickTransport({ https_proxy: 'http://proxy:8080' }), 'curl');
  assert.equal(pickTransport({}), 'fetch');
});

test('curl arguments carry method, headers and body without leaking into the URL', async () => {
  const { curlArgs } = await import('../scripts/routine-agent.mjs');
  const args = curlArgs('https://backend.example/api/ai/agent/jobs/export-x/result?attempt=1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.deepEqual(args.slice(0, 3), ['-sS', '-X', 'PUT']);
  assert.ok(args.includes('Content-Type: application/json'));
  assert.ok(args.includes('--data-binary'));
  assert.equal(args.at(-1), 'https://backend.example/api/ai/agent/jobs/export-x/result?attempt=1');
  assert.equal(curlArgs('https://b.example/x', {}).includes('--data-binary'), false);
});

test('unauthorized error reports transport and proxy presence, never values', async () => {
  const err = sink();
  const fetchImpl = async () => Response.json({ ok: false, error: { code: 'agent_unauthorized', message: 'AI 代理憑證無效或缺少' } }, { status: 401 });
  assert.notEqual(await runAgentCommand(['job', 'export-x', '1'], { env: { HTTPS_PROXY: 'http://user:secretpass@proxy:8080' }, fetchImpl, stdout: sink(), stderr: err }), 0);
  const text = err.lines.join('');
  assert.ok(text.includes('agent_unauthorized'));
  assert.ok(text.includes('proxy_env=yes'));
  assert.ok(!text.includes('secretpass'));
});

test('curlFetch round-trips status, binary body and request body through real curl', async t => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('curl', ['--version']).status !== 0) { t.skip('curl not installed'); return; }
  const { createServer } = await import('node:http');
  const { curlFetch } = await import('../scripts/routine-agent.mjs');
  const binary = Buffer.from([0, 1, 2, 255, 10, 13, 65]);
  let received = null;
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received = { method: req.method, auth: req.headers.authorization || null, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() };
      if (req.url === '/bin') { res.writeHead(200); res.end(binary); return; }
      res.writeHead(422, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":{"code":"result_evidence"}}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bin = await curlFetch(`${base}/bin`);
    assert.equal(bin.status, 200);
    assert.deepEqual(Buffer.from(await bin.arrayBuffer()), binary);
    assert.equal(received.auth, null);
    const put = await curlFetch(`${base}/result`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"items":[]}' });
    assert.equal(put.status, 422);
    assert.equal((await put.json()).error.code, 'result_evidence');
    assert.deepEqual(received, { method: 'PUT', auth: null, type: 'application/json', body: '{"items":[]}' });
  } finally { server.close(); }
});
