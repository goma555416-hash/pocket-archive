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
