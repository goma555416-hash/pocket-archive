import assert from 'node:assert/strict';
import test from 'node:test';
import { aiFixture, DatabaseSync } from './helpers/ai-fixture.mjs';

const skip = !DatabaseSync && 'node:sqlite 需要 Node 22.5+';

test('agent credential is shown once, hashed, scoped and revocable', { skip }, async () => {
  const fx = await aiFixture();
  const created = await fx.session('/api/ai/agent-credentials', 'POST', { name: 'Claude routine', expiresInDays: 9999 });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.match(body.token, /^pa_agent_[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{32,128}$/);
  assert.equal(body.credential.scope, 'ai:agent');
  assert.equal(body.credential.expiresAt - body.credential.createdAt, 365 * 86_400_000);
  const stored = fx.db.database.prepare('SELECT token_hash FROM ai_agent_credentials WHERE id=?').get(body.credential.id);
  assert.notEqual(stored.token_hash, body.token);
  assert.ok(!stored.token_hash.includes(body.token.split('.')[1]));

  const listed = await (await fx.session('/api/ai/agent-credentials')).json();
  assert.equal(listed.credentials.length, 1);
  assert.ok(!JSON.stringify(listed).includes(body.token.split('.')[1]));

  const ok = await fx.agent(body.token, '/api/ai/agent/jobs/export-none?attempt=1');
  assert.equal(ok.status, 404); // authenticated, job missing
  const inQuery = await fx.agent(body.token, '/api/ai/agent/jobs/export-none?attempt=1&token=x');
  assert.equal(inQuery.status, 400);
  assert.equal((await inQuery.json()).error.code, 'credential_in_query');
  const bad = await fx.agent('pa_agent_abcdefgh.' + 'x'.repeat(40), '/api/ai/agent/jobs/export-none?attempt=1');
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error.code, 'agent_unauthorized');

  for (let index = 2; index <= 60; index += 1) await fx.agent(body.token, '/api/ai/agent/jobs/export-none?attempt=1');
  const limited = await fx.agent(body.token, '/api/ai/agent/jobs/export-none?attempt=1');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'rate_limited');

  const revoked = await fx.session(`/api/ai/agent-credentials/${body.credential.id}`, 'DELETE');
  assert.equal(revoked.status, 200);
  fx.advance(60_000);
  const after = await fx.agent(body.token, '/api/ai/agent/jobs/export-none?attempt=1');
  assert.equal(after.status, 401);
  const missing = await fx.session('/api/ai/agent-credentials/doesnotexist1', 'DELETE');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'credential_not_found');
});

const createJob = (fx, payload) => fx.session('/api/ai/jobs', 'POST', payload);

test('create job fires routine with export id only', { skip }, async () => {
  const fx = await aiFixture();
  const payload = fx.seedBatch('export-one');
  const response = await createJob(fx, payload);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.duplicate, false);
  assert.equal(body.job.status, 'running');
  assert.equal(body.job.attempt, 1);
  assert.equal(body.job.sessionUrl, 'https://claude.ai/code/session_x');
  assert.equal(fx.fires.length, 1);
  assert.equal(fx.fires[0].body, JSON.stringify({ text: 'export_id=export-one attempt=1' }));
  assert.equal(fx.fires[0].headers.authorization, 'Bearer routine-secret-token');
  assert.equal(fx.fires[0].headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.equal(fx.fires[0].headers['anthropic-version'], '2023-06-01');
  assert.ok(!JSON.stringify(body).includes('inbox":true'));
  const listed = await (await fx.session('/api/ai/jobs')).json();
  assert.equal(listed.configured, true);
  assert.equal(listed.jobs.length, 1);
  assert.deepEqual(listed.jobs[0].itemIds, ['a', 'b']);
});

test('duplicate create does not fire twice', { skip }, async () => {
  const fx = await aiFixture();
  const payload = fx.seedBatch('export-dup');
  await createJob(fx, payload);
  const again = await createJob(fx, payload);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  assert.equal(fx.fires.length, 1);
});

test('second job queues while one is running', { skip }, async () => {
  const fx = await aiFixture();
  await createJob(fx, fx.seedBatch('export-first'));
  const second = await (await createJob(fx, fx.seedBatch('export-second'))).json();
  assert.equal(second.job.status, 'queued');
  assert.equal(second.job.attempt, 0);
  assert.equal(fx.fires.length, 1);
});

test('binding mismatch is rejected', { skip }, async () => {
  const fx = await aiFixture();
  const payload = fx.seedBatch('export-bad');
  fx.files.get(payload.resultFileId).meta.appProperties.inboxFileId = 'someone-else';
  const response = await createJob(fx, payload);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'ai_binding_mismatch');
  assert.equal(fx.row('export-bad'), undefined);
  const invalid = await createJob(fx, { ...fx.seedBatch('export-ok'), itemIds: [] });
  assert.equal(invalid.status, 400);
});

test('not configured returns 503 and lists configured false', { skip }, async () => {
  const fx = await aiFixture({ configured: false });
  const response = await createJob(fx, fx.seedBatch('export-off'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ai_not_configured');
  const listed = await (await fx.session('/api/ai/jobs')).json();
  assert.equal(listed.configured, false);
  assert.equal(fx.fires.length, 0);
});

test('fire failure fails job and frees queue', { skip }, async () => {
  const fx = await aiFixture();
  fx.setFireResponse(() => new Response('{}', { status: 429 }));
  const first = await (await createJob(fx, fx.seedBatch('export-a1'))).json();
  assert.equal(first.job.status, 'failed');
  assert.equal(first.job.failureCode, 'routine_rate_limited');
  fx.setFireResponse(() => new Response('{}', { status: 401 }));
  const second = await (await createJob(fx, fx.seedBatch('export-a2'))).json();
  assert.equal(second.job.failureCode, 'routine_unauthorized');
  fx.setFireResponse(() => { throw new Error('network'); });
  const third = await (await createJob(fx, fx.seedBatch('export-a3'))).json();
  assert.equal(third.job.failureCode, 'routine_unavailable');
  fx.setFireResponse(() => Response.json({ claude_code_session_url: 'https://claude.ai/code/s2' }));
  const fourth = await (await createJob(fx, fx.seedBatch('export-a4'))).json();
  assert.equal(fourth.job.status, 'running');
});

test('a failed fire starts the next queued job', { skip }, async () => {
  const fx = await aiFixture();
  await createJob(fx, fx.seedBatch('export-q1'));
  await createJob(fx, fx.seedBatch('export-q2'));
  fx.db.database.prepare("UPDATE ai_jobs SET status='failed' WHERE export_id='export-q1'").run();
  fx.setFireResponse(() => new Response('{}', { status: 429 }));
  await fx.session('/api/ai/jobs/export-q1/retry', 'POST', {});
  assert.equal(fx.row('export-q1').status, 'failed');
  assert.equal(fx.row('export-q2').status, 'failed'); // fired after q1 failed, also rate limited
  assert.equal(fx.fires.length, 3);
});

test('retry only from failed', { skip }, async () => {
  const fx = await aiFixture();
  await createJob(fx, fx.seedBatch('export-r'));
  const notFailed = await fx.session('/api/ai/jobs/export-r/retry', 'POST', {});
  assert.equal(notFailed.status, 409);
  assert.equal((await notFailed.json()).error.code, 'invalid_state');
  fx.db.database.prepare("UPDATE ai_jobs SET status='failed', failure_code='timeout' WHERE export_id='export-r'").run();
  const retried = await (await fx.session('/api/ai/jobs/export-r/retry', 'POST', {})).json();
  assert.equal(retried.job.status, 'running');
  assert.equal(retried.job.attempt, 2);
  assert.equal(retried.job.failureCode, null);
  assert.equal(fx.fires.at(-1).body, JSON.stringify({ text: 'export_id=export-r attempt=2' }));
});

test('applied only from ready', { skip }, async () => {
  const fx = await aiFixture();
  await createJob(fx, fx.seedBatch('export-p'));
  const early = await fx.session('/api/ai/jobs/export-p/applied', 'POST', {});
  assert.equal(early.status, 409);
  fx.db.database.prepare("UPDATE ai_jobs SET status='ready' WHERE export_id='export-p'").run();
  const applied = await (await fx.session('/api/ai/jobs/export-p/applied', 'POST', {})).json();
  assert.equal(applied.job.status, 'applied');
  const again = await fx.session('/api/ai/jobs/export-p/applied', 'POST', {});
  assert.equal(again.status, 200);
});

test('sweep times out running after 60 minutes', { skip }, async () => {
  const fx = await aiFixture();
  await createJob(fx, fx.seedBatch('export-t1'));
  await createJob(fx, fx.seedBatch('export-t2'));
  fx.advance(59 * 60_000); await fx.cron();
  assert.equal(fx.row('export-t1').status, 'running');
  fx.advance(2 * 60_000); await fx.cron();
  assert.equal(fx.row('export-t1').status, 'failed');
  assert.equal(fx.row('export-t1').failure_code, 'timeout');
  assert.equal(fx.row('export-t2').status, 'running');
  assert.equal(fx.fires.length, 2);
});
