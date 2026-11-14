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

test('missing environment exits non-zero naming the variable without values', async () => {
  const err = sink();
  assert.notEqual(await runAgentCommand(['job', 'export-x', '1'], { env: { PA_BACKEND_ORIGIN: 'https://backend.example' }, fetchImpl: async () => { throw new Error('should not fetch'); }, stdout: sink(), stderr: err }), 0);
  assert.ok(err.lines.join('').includes('PA_AGENT_TOKEN'));
  const bad = sink();
  assert.notEqual(await runAgentCommand(['job', 'not-an-export', '1'], { env, fetchImpl: async () => { throw new Error('no'); }, stdout: sink(), stderr: bad }), 0);
});
