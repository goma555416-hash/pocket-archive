import assert from 'node:assert/strict';
import test from 'node:test';
import { aiFixture, DatabaseSync, sha } from './helpers/ai-fixture.mjs';

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

test('poll keeps jobs queued, atomically claims oldest for only this owner and refuses takeover', { skip }, async () => {
  const fx = await aiFixture({ configured: false, dispatchMode: 'poll' });
  const tokens = await Promise.all([fx.newAgentToken(), fx.newAgentToken()]);
  const claim = token => fx.agent(token, '/api/ai/agent/claim', 'POST');
  const empty = await claim(tokens[0]);
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  for (const id of ['export-foreign', 'export-z', 'export-a']) {
    const created = await (await createJob(fx, fx.seedBatch(id))).json();
    assert.equal(created.job.status, 'queued');
    assert.equal(created.job.attempt, 0);
  }
  fx.db.database.prepare("UPDATE ai_jobs SET user_id='user-2' WHERE export_id='export-foreign'").run();
  fx.advance(61 * 60_000); await fx.cron();
  assert.equal(fx.row('export-a').status, 'queued', 'queued time does not consume runtime');
  const responses = await Promise.all(tokens.map(claim));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual((await responses.find(r => r.status === 200).json()).job, { exportId: 'export-a', attempt: 1 });
  assert.equal((await responses.find(r => r.status === 409).json()).error.code, 'agent_busy');
  assert.equal((await claim(tokens[0])).status, 409, 'same credential cannot resume through claim');
  assert.equal(fx.row('export-z').status, 'queued');
  assert.equal(fx.row('export-foreign').status, 'queued');
  assert.equal(fx.row('export-a').started_at, fx.now());
  assert.equal(fx.fires.length, 0);
});

test('claim uses agent auth, revocation, expiry, method and dispatch gates', { skip }, async () => {
  const fx = await aiFixture({ dispatchMode: 'poll' });
  const token = await fx.newAgentToken();
  assert.equal((await fx.agent('', '/api/ai/agent/claim', 'POST')).status, 401);
  assert.equal((await fx.agent(token, '/api/ai/agent/claim')).status, 405);
  assert.equal((await fx.agent(token, '/api/ai/agent/claim?token=x', 'POST')).status, 400);
  fx.db.database.prepare("UPDATE ai_agent_credentials SET user_id='user-2'").run();
  assert.equal((await fx.agent(token, '/api/ai/agent/claim', 'POST')).status, 403, 'a credential for a former/non-owner cannot claim');
  fx.db.database.prepare("UPDATE ai_agent_credentials SET user_id='user-1'").run();
  for (const mode of [undefined, 'routine', 'polll']) {
    fx.env.AI_DISPATCH_MODE = mode;
    const disabled = await fx.agent(token, '/api/ai/agent/claim', 'POST');
    assert.equal(disabled.status, 409);
    assert.equal((await disabled.json()).error.code, 'claim_disabled');
  }
  assert.equal((await createJob(fx, fx.seedBatch('export-bad-mode'))).status, 503);
  fx.env.AI_DISPATCH_MODE = 'poll';
  const credentials = (await (await fx.session('/api/ai/agent-credentials')).json()).credentials;
  await fx.session(`/api/ai/agent-credentials/${credentials[0].id}`, 'DELETE');
  assert.equal((await fx.agent(token, '/api/ai/agent/claim', 'POST')).status, 401);
  const expired = await fx.newAgentToken();
  fx.advance(91 * 86_400_000);
  assert.equal((await fx.agent(expired, '/api/ai/agent/claim', 'POST')).status, 401);
});

test('poll timeout, explicit retry, stale attempt and rollback preserve the queue', { skip }, async () => {
  const fx = await aiFixture({ dispatchMode: 'poll' });
  const token = await fx.newAgentToken();
  await createJob(fx, fx.seedBatch('export-retry-poll'));
  await fx.agent(token, '/api/ai/agent/claim', 'POST');
  fx.advance(59 * 60_000); await fx.cron();
  assert.equal(fx.row('export-retry-poll').status, 'running');
  fx.advance(2 * 60_000); await fx.cron();
  assert.equal(fx.row('export-retry-poll').failure_code, 'timeout');
  const retried = await (await fx.session('/api/ai/jobs/export-retry-poll/retry', 'POST', {})).json();
  assert.equal(retried.job.status, 'queued');
  assert.equal(retried.job.attempt, 1);
  await fx.agent(token, '/api/ai/agent/claim', 'POST');
  const old = await fx.agent(token, '/api/ai/agent/jobs/export-retry-poll/result?attempt=1', 'PUT', organized('export-retry-poll'));
  assert.equal((await old.json()).error.code, 'stale_attempt');
  const submitted = await fx.agent(token, '/api/ai/agent/jobs/export-retry-poll/result?attempt=2', 'PUT', organized('export-retry-poll'));
  assert.equal(submitted.status, 200);
  assert.equal((await fx.agent(token, '/api/ai/agent/jobs/export-retry-poll/result?attempt=2', 'PUT', organized('export-retry-poll'))).status, 409);
  assert.equal(fx.uploads.length, 1);
  assert.equal(fx.fires.length, 0);
  await createJob(fx, fx.seedBatch('export-rollback'));
  fx.env.AI_DISPATCH_MODE = 'routine'; await fx.cron();
  assert.equal(fx.row('export-rollback').status, 'running');
  assert.equal(fx.fires.length, 1);
});

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

const at = '2026-11-14T10:00:00.000Z';
const body80 = '文章逐段討論排版、視覺閱讀順序以及不同版面密度如何影響使用者的閱讀體驗，提供具體設計案例與改善建議。'.repeat(2);
function organized(exportId, ids = ['a', 'b'], { withEvidence = true } = {}) {
  return JSON.stringify({
    format: 'pocket-archive-organized', schema_version: 2, source_export_id: exportId,
    items: ids.map(id => ({
      id, analysis_status: 'completed', suggested_categories: [], suggested_tags: ['排版'], summary: '摘要', reason: '正文', confidence: 'medium',
      ...(withEvidence ? { evidence: { status: 'content_read', kind: 'article_body', source_url: 'https://example.org/a', excerpt: body80, observed_at: at } } : {})
    }))
  });
}
async function runningJob(fx, exportId = 'export-agent') {
  const payload = fx.seedBatch(exportId, { inboxContent: '{"format":"pocket-archive-inbox","note":"private"}' });
  await createJob(fx, payload);
  return { payload, token: await fx.newAgentToken() };
}

test('agent reads running job and streams inbox', { skip }, async () => {
  const fx = await aiFixture();
  const { payload, token } = await runningJob(fx);
  const info = await (await fx.agent(token, '/api/ai/agent/jobs/export-agent?attempt=1')).json();
  assert.deepEqual(info.job, { exportId: 'export-agent', attempt: 1, itemIds: ['a', 'b'], inboxName: 'pocket-archive-inbox-2026-11-14-export-agent.json', inboxMimeType: 'application/json', inboxSha256: payload.inboxSha256, evidenceKinds: ['article_body', 'post_text', 'transcript', 'user_share_text', 'web_pages', 'site_description'] });
  const inbox = await fx.agent(token, '/api/ai/agent/jobs/export-agent/inbox?attempt=1');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.headers.get('cache-control'), 'no-store');
  assert.equal(await inbox.text(), '{"format":"pocket-archive-inbox","note":"private"}');
});

test('valid result is written back and read back', { skip }, async () => {
  const fx = await aiFixture();
  const { payload, token } = await runningJob(fx);
  await createJob(fx, fx.seedBatch('export-next'));
  const text = organized('export-agent');
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', text);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).job.status, 'ready');
  assert.equal(fx.uploads.length, 1);
  assert.equal(fx.uploads[0].id, payload.resultFileId);
  assert.equal(fx.uploads[0].text, text);
  assert.equal(fx.row('export-agent').status, 'ready');
  assert.equal(fx.row('export-next').status, 'running');
});

test('concurrent submissions write the placeholder only once', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  const submit = () => fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  const responses = await Promise.all([submit(), submit()]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(fx.uploads.length, 1);
  assert.equal(fx.row('export-agent').status, 'ready');
});

test('an in-flight write cannot be failed, timed out or retried underneath the writer', { skip }, async () => {
  const fx = await aiFixture({ dispatchMode: 'poll' });
  await createJob(fx, fx.seedBatch('export-agent'));
  const token = await fx.newAgentToken();
  await fx.agent(token, '/api/ai/agent/claim', 'POST');
  const realFetch = fx.env.__fetch;
  let release; let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  fx.env.__fetch = async (input, options) => {
    if (options?.method === 'PATCH') { entered(); await paused; }
    return realFetch(input, options);
  };
  const submit = fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  await enteredPromise;
  try {
    assert.equal((await fx.agent(token, '/api/ai/agent/jobs/export-agent/fail?attempt=1', 'POST', '{"code":"late"}')).status, 409);
    fx.advance(61 * 60_000); await fx.cron();
    assert.equal(fx.row('export-agent').status, 'running');
    assert.equal(fx.row('export-agent').failure_code, 'writeback_in_progress');
    const { createHash } = await import('node:crypto');
    assert.ok(fx.row('export-agent').failure_message.includes(createHash('sha256').update(organized('export-agent')).digest('base64url')), 'crash recovery SHA must already be durable before PATCH finishes');
    assert.ok(fx.row('export-agent').failure_message.includes('"beforeVersion":"1"'));
    assert.equal((await fx.session('/api/ai/jobs/export-agent/retry', 'POST', {})).status, 409);
    assert.equal((await fx.agent(token, '/api/ai/agent/claim', 'POST')).status, 409);
  } finally { release(); }
  assert.equal((await submit).status, 200);
  assert.equal(fx.row('export-agent').failure_code, null);
  assert.equal(fx.uploads.length, 1);
});

test('uncertain Drive writes are quarantined and cannot be blindly retried', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  const realFetch = fx.env.__fetch;
  fx.env.__fetch = async (input, options) => {
    const response = await realFetch(input, options);
    if (options?.method === 'PATCH') throw new Error('connection lost after the write');
    return response;
  };
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.notEqual(response.status, 200);
  assert.equal(fx.uploads.length, 1);
  assert.equal(fx.row('export-agent').failure_code, 'writeback_uncertain');
  const retry = await fx.session('/api/ai/jobs/export-agent/retry', 'POST', {});
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).error.code, 'writeback_uncertain');
});

test('deadline is enforced before cron and a late submit never writes', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  fx.advance(60 * 60_000);
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'timeout');
  assert.equal(fx.row('export-agent').failure_code, 'timeout');
  assert.equal(fx.uploads.length, 0);
});

test('invalid result fails job without writing', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent', ['a', 'b'], { withEvidence: false }));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'result_evidence');
  assert.equal(fx.row('export-agent').status, 'failed');
  assert.equal(fx.row('export-agent').failure_code, 'result_evidence');
  assert.equal(fx.uploads.length, 0);
});

test('placeholder changed blocks write', { skip }, async () => {
  const fx = await aiFixture();
  const { payload, token } = await runningJob(fx);
  fx.files.get(payload.resultFileId).meta.version = '7';
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 409);
  assert.equal(fx.row('export-agent').failure_code, 'placeholder_changed');
  assert.equal(fx.uploads.length, 0);
});

function privateVersionDrift(fx, payload) {
  Object.assign(fx.files.get(payload.resultFileId).meta, { version: '4', ownedByMe: true, shared: false,
    permissions: [{ type: 'user', role: 'owner' }] });
}

test('private version-only drift verifies original pending bytes and preserves actual pre-PATCH metadata', { skip }, async () => {
  const fx = await aiFixture(), { payload, token } = await runningJob(fx);
  privateVersionDrift(fx, payload);
  const realFetch = fx.env.__fetch;
  fx.env.__fetch = async (input, options = {}) => {
    if (options.method === 'PATCH') {
      const receipt = fx.row(payload.exportId).failure_message;
      assert.match(receipt, /"beforeVersion":"4"/);
      assert.match(receipt, /"registeredVersion":"1"/);
    }
    return realFetch(input, options);
  };
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 200);
  assert.equal(fx.uploads.length, 1);
  assert.equal(fx.uploads[0].id, payload.resultFileId);
});

for (const fault of ['bytes', 'pending', 'id', 'parent', 'shared', 'permissions', 'null-permission', 'missing-permissions', 'drive', 'owner', 'moving-version']) {
  test(`version drift fails closed for ${fault}`, { skip }, async () => {
    const fx = await aiFixture(), { payload, token } = await runningJob(fx);
    privateVersionDrift(fx, payload);
    const file = fx.files.get(payload.resultFileId);
    if (fault === 'bytes') file.content = '{}';
    if (fault === 'pending') file.meta.appProperties.status = 'ready';
    if (fault === 'id') file.meta.id = 'other';
    if (fault === 'parent') file.meta.parents.push('other');
    if (fault === 'shared') file.meta.shared = true;
    if (fault === 'permissions') file.meta.permissions.push({ type: 'user', role: 'reader' });
    if (fault === 'null-permission') file.meta.permissions = [null];
    if (fault === 'missing-permissions') delete file.meta.permissions;
    if (fault === 'drive') file.meta.driveId = 'shared-drive';
    if (fault === 'owner') file.meta.ownedByMe = false;
    const realFetch = fx.env.__fetch;
    if (fault === 'moving-version') fx.env.__fetch = async (input, options) => {
      if (String(input).includes(`/files/${payload.resultFileId}?alt=media`)) file.meta.version = '5';
      return realFetch(input, options);
    };
    const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
    assert.equal(response.status, 409);
    assert.equal(fx.uploads.length, 0);
    assert.equal(fx.row(payload.exportId).failure_code, 'placeholder_changed');
  });
}

for (const changed of [false, true]) test(`stale retry cannot clear or relabel a newer quarantined attempt (changed=${changed})`, { skip }, async () => {
  const fx = await aiFixture(), { payload } = await runningJob(fx);
  fx.db.database.prepare("UPDATE ai_jobs SET status='failed',failure_code='timeout' WHERE export_id=?").run(payload.exportId);
  const realFetch = fx.env.__fetch;
  fx.env.__fetch = async (input, options) => {
    if (String(input).includes(`/files/${payload.resultFileId}?fields`)) {
      fx.db.database.prepare("UPDATE ai_jobs SET attempt_count=2,failure_code='writeback_uncertain',failure_message='preserve receipt' WHERE export_id=?").run(payload.exportId);
      if (changed) fx.files.get(payload.resultFileId).meta.version = '9';
    }
    return realFetch(input, options);
  };
  const response = await fx.session('/api/ai/jobs/export-agent/retry', 'POST', {});
  assert.equal(response.status, 409);
  const row = fx.row(payload.exportId);
  assert.equal(row.attempt_count, 2);
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, 'writeback_uncertain');
  assert.equal(row.failure_message, 'preserve receipt');
});

for (const nullEnvelope of [false, true]) test(`drift proof requires pending envelope even when its hash matches registration (null=${nullEnvelope})`, { skip }, async () => {
  const fx = await aiFixture(), { payload, token } = await runningJob(fx);
  privateVersionDrift(fx, payload);
  const file = fx.files.get(payload.resultFileId);
  file.content = JSON.stringify(nullEnvelope ? null : { format: 'pocket-archive-organized', schema_version: 2, source_export_id: payload.exportId, status: 'ready', items: [] });
  fx.db.database.prepare('UPDATE ai_jobs SET pending_sha256=? WHERE export_id=?').run(sha(file.content), payload.exportId);
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 409);
  assert.equal(fx.uploads.length, 0);
});

test('final drift metadata check refuses permissions changed after receipt persistence', { skip }, async () => {
  const fx = await aiFixture(), { payload, token } = await runningJob(fx);
  privateVersionDrift(fx, payload);
  const realFetch = fx.env.__fetch; let reads = 0;
  fx.env.__fetch = async (input, options) => {
    if (String(input).includes(`/files/${payload.resultFileId}?fields`) && ++reads === 3) {
      fx.files.get(payload.resultFileId).meta.permissions.push({ type: 'anyone', role: 'reader' });
    }
    return realFetch(input, options);
  };
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 409);
  assert.equal(fx.uploads.length, 0);
});

test('drift write with failed read-back retains observed and registered versions and forbids retry', { skip }, async () => {
  const fx = await aiFixture(), { payload, token } = await runningJob(fx);
  privateVersionDrift(fx, payload);
  fx.setReadBack('THROW');
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 502);
  const row = fx.row(payload.exportId);
  assert.equal(row.failure_code, 'writeback_uncertain');
  assert.match(row.failure_message, /"beforeVersion":"4"/);
  assert.match(row.failure_message, /"registeredVersion":"1"/);
  for (let i=0;i<2;i++) assert.equal((await fx.session('/api/ai/jobs/export-agent/retry','POST',{})).status,409);
  assert.deepEqual(fx.row(payload.exportId),row);
  assert.equal(fx.uploads.length,1);
});

test('expiry during drift proof never starts PATCH', { skip }, async () => {
  const fx = await aiFixture(), { payload, token } = await runningJob(fx);
  privateVersionDrift(fx, payload);
  const realFetch = fx.env.__fetch;
  fx.env.__fetch = async (input, options) => {
    if (String(input).includes(`/files/${payload.resultFileId}?alt=media`)) fx.advance(61 * 60_000);
    return realFetch(input, options);
  };
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 409);
  assert.equal(fx.row(payload.exportId).failure_code, 'timeout');
  assert.equal(fx.uploads.length, 0);
});

test('writeback mismatch fails job', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  fx.setReadBack('{"tampered":true}');
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 502);
  assert.equal(fx.row('export-agent').status, 'failed');
  assert.equal(fx.row('export-agent').failure_code, 'writeback_uncertain');
});

test('stale attempt is rejected', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  fx.advance(61 * 60_000); await fx.cron();
  assert.equal(fx.row('export-agent').failure_code, 'timeout');
  await fx.session('/api/ai/jobs/export-agent/retry', 'POST', {});
  assert.equal(fx.row('export-agent').attempt_count, 2);
  const staleFail = await fx.agent(token, '/api/ai/agent/jobs/export-agent/fail?attempt=1', 'POST', JSON.stringify({ code: 'late', message: 'old session' }));
  assert.equal(staleFail.status, 409);
  assert.equal((await staleFail.json()).error.code, 'stale_attempt');
  const staleResult = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(staleResult.status, 409);
  assert.equal(fx.row('export-agent').status, 'running');
  assert.equal(fx.row('export-agent').attempt_count, 2);
  assert.equal(fx.uploads.length, 0);
});

test('agent fail records sanitized reason', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/fail?attempt=1', 'POST', JSON.stringify({ code: 'Bad-Code!', message: '原因'.repeat(250) }));
  assert.equal(response.status, 200);
  const row = fx.row('export-agent');
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, 'agent_reported');
  assert.equal(row.failure_message.length, 300);
});

test('agent cannot touch other users or non-running jobs', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  fx.db.database.prepare("UPDATE ai_jobs SET user_id='user-2' WHERE export_id='export-agent'").run();
  const other = await fx.agent(token, '/api/ai/agent/jobs/export-agent?attempt=1');
  assert.equal(other.status, 404);
  fx.db.database.prepare("UPDATE ai_jobs SET user_id='user-1', status='ready' WHERE export_id='export-agent'").run();
  const notRunning = await fx.agent(token, '/api/ai/agent/jobs/export-agent/inbox?attempt=1');
  assert.equal(notRunning.status, 409);
  assert.equal((await notRunning.json()).error.code, 'invalid_state');
});

for (const fault of ['exception', 'http', 'mismatch', 'metadata']) test(`PATCH success followed by ${fault} stays quarantined with recovery evidence`, { skip }, async () => {
  const fx = await aiFixture({ dispatchMode: 'poll' });
  const { token, payload } = await runningJob(fx);
  await fx.agent(token, '/api/ai/agent/claim', 'POST');
  const before = fx.row('export-agent');
  const realFetch = fx.env.__fetch;
  fx.env.__fetch = async (input, options) => {
    const response = await realFetch(input, options);
    if (fault === 'metadata' && options?.method === 'PATCH') return Response.json({});
    if (String(input).includes(`/files/${payload.resultFileId}?alt=media`)) {
      if (fault === 'exception') throw new Error('read failed');
      if (fault === 'http') return new Response('', { status: 503 });
      if (fault === 'mismatch') return new Response('{"changed":true}');
    }
    return response;
  };
  const result = organized('export-agent');
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', result);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'writeback_uncertain');
  const quarantined = fx.row('export-agent');
  assert.equal(quarantined.failure_code, 'writeback_uncertain');
  assert.equal(quarantined.attempt_count, before.attempt_count);
  assert.equal(quarantined.result_file_id, before.result_file_id);
  assert.equal(quarantined.inbox_sha256, before.inbox_sha256);
  assert.equal(quarantined.pending_sha256, before.pending_sha256);
  assert.equal(quarantined.result_version, fault === 'metadata' ? before.result_version : '2');
  assert.ok(quarantined.failure_message.includes(before.result_md5));
  const { createHash } = await import('node:crypto');
  assert.ok(quarantined.failure_message.includes(createHash('sha256').update(result).digest('base64url')));
  fx.env.__fetch = realFetch; // restoration of connectivity is not human reconciliation
  for (let index = 0; index < 2; index += 1) {
    const retry = await fx.session('/api/ai/jobs/export-agent/retry', 'POST', {});
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).error.code, 'writeback_uncertain');
    assert.equal((await fx.agent(token, '/api/ai/agent/claim', 'POST')).status, 204);
    assert.equal((await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', result)).status, 409);
  }
  fx.advance(61 * 60_000); await fx.cron();
  assert.deepEqual(fx.row('export-agent'), quarantined);
  assert.equal(fx.uploads.length, 1);
});

test('legacy writeback failure codes cannot be retried even with matching Drive metadata', { skip }, async () => {
  const fx = await aiFixture();
  await runningJob(fx);
  for (const code of ['writeback_failed', 'writeback_mismatch', 'writeback_uncertain']) {
    fx.db.database.prepare("UPDATE ai_jobs SET status='failed', failure_code=? WHERE export_id='export-agent'").run(code);
    const before = fx.row('export-agent');
    const response = await fx.session('/api/ai/jobs/export-agent/retry', 'POST', {});
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'writeback_uncertain');
    assert.deepEqual(fx.row('export-agent'), before);
  }
  assert.equal(fx.fires.length, 1);
});

test('read-back exception marks the job failed instead of leaving it running', { skip }, async () => {
  const fx = await aiFixture();
  const { token } = await runningJob(fx);
  fx.setReadBack('THROW');
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 502);
  assert.equal(fx.row('export-agent').status, 'failed');
  assert.equal(fx.row('export-agent').failure_code, 'writeback_uncertain');
});

test('retry checks the placeholder first and does not fire when it changed', { skip }, async () => {
  const fx = await aiFixture();
  const { payload } = await runningJob(fx);
  fx.db.database.prepare("UPDATE ai_jobs SET status='failed', failure_code='timeout' WHERE export_id='export-agent'").run();
  fx.files.get(payload.resultFileId).meta.version = '9';
  const firesBefore = fx.fires.length;
  const response = await fx.session('/api/ai/jobs/export-agent/retry', 'POST', {});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'placeholder_changed');
  assert.equal(fx.fires.length, firesBefore);
  assert.equal(fx.row('export-agent').status, 'failed');
});

test('transient Drive errors are not reported as placeholder changes', { skip }, async () => {
  const fx = await aiFixture();
  const { payload, token } = await runningJob(fx);
  const realFetch = fx.env.__fetch;
  fx.env.__fetch = async (input, options) => String(input).includes(`/files/${payload.resultFileId}?fields`) ? new Response('{}', { status: 503 }) : realFetch(input, options);
  const response = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(response.status, 503);
  assert.equal(fx.row('export-agent').status, 'running');
  assert.equal(fx.uploads.length, 0);
  assert.equal(fx.row('export-agent').failure_message, null);
  fx.env.__fetch = realFetch;
  const resumed = await fx.agent(token, '/api/ai/agent/jobs/export-agent/result?attempt=1', 'PUT', organized('export-agent'));
  assert.equal(resumed.status, 200, 'pre-PATCH failure may resume the same attempt safely');
  assert.equal(fx.uploads.length, 1);
});
