// Core delivery gate for cloud organize. Reproduces the Claude cloud sandbox:
// all egress goes through an HTTPS CONNECT proxy with its own CA
// (HTTPS_PROXY + CURL_CA_BUNDLE), and the agent credential is injected by the
// network, not sent by the script. The REAL CLIs run as child processes:
//   routine-agent job/inbox → collect-content-evidence → validate-organized
//   → routine-agent submit → Worker validation → Drive write-back
// and the written result is then read and applied with the App's own code.
// Only Claude's judgment is replaced by a deterministic stand-in classifier
// (keyword rules). This test therefore proves the PIPELINE — reading,
// evidence, validation, write-back, App import — and NOT classification
// quality. Its tags must never be reported as a Claude classification result;
// that is only verified by a real claude.ai routine run.
// Sites are local fixtures with known content (no external websites).
//
// In CI (PA_REQUIRE_FLOW=1) missing prerequisites FAIL instead of skipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { aiFixture, DatabaseSync } from './helpers/ai-fixture.mjs';
import { SITES, FIXTURE_URLS, ABOUT_PHRASE } from './fixtures/web-sites.mjs';
import { createEntry, createInboxEnvelope, readOrganized, applySuggestions } from '../lib.mjs';

const run = promisify(execFile);
const script = name => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const BACKEND_HOST = 'backend.pa-fixture.org';

function findOpenssl() {
  for (const candidate of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    if (candidate !== 'openssl' && !existsSync(candidate)) continue;
    if (spawnSync(candidate, ['version']).status === 0) return candidate;
  }
  return null;
}
const openssl = findOpenssl();
const hasCurl = spawnSync('curl', ['--version']).status === 0;
const missing = [!DatabaseSync && 'node:sqlite', !openssl && 'openssl', !hasCurl && 'curl'].filter(Boolean);
const required = process.env.PA_REQUIRE_FLOW === '1';
const skip = !required && missing.length ? `缺少 ${missing.join('、')}（CI 會強制執行）` : false;

// Stand-in for Claude's judgment: tags only from what the evidence excerpt says.
function standInClassify(evidence) {
  const read = evidence.status === 'content_read';
  const rules = [[/日本語|日本文化/, '日語學習'], [/量子/, '量子電腦'], [/whiteboard/i, '白板工具']];
  const tags = read ? rules.filter(([rx]) => rx.test(evidence.excerpt)).map(([, tag]) => tag) : [];
  return read && tags.length
    ? { analysis_status: 'completed', suggested_tags: tags, suggested_categories: [], summary: evidence.excerpt.slice(0, 60), reason: `依 ${evidence.kind} 內容`, confidence: 'medium', evidence }
    : { analysis_status: 'insufficient_data', suggested_tags: [], suggested_categories: [], summary: '', reason: evidence.reason || '資料不足', confidence: 'low', evidence: read ? { status: 'metadata_only', kind: 'metadata', excerpt: '', source_url: evidence.source_url, observed_at: evidence.observed_at } : evidence };
}

for (const dispatchMode of ['routine', 'poll']) test(`${dispatchMode} organize pipeline works end to end through the sandbox proxy and lands in the App (stand-in classifier, not Claude)`, { skip, timeout: 120000 }, async () => {
  assert.deepEqual(missing, [], `必要工具缺少：${missing.join('、')}`);
  const dir = await mkdtemp(join(tmpdir(), 'pa-flow-'));
  const servers = [];
  try {
    // 1. Sandbox CA + certificate for every fixture host.
    const key = join(dir, 'key.pem'); const cert = join(dir, 'ca.pem');
    const made = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
      '-subj', '/CN=pa-fixture', '-addext', `subjectAltName=DNS:*.pa-fixture.org,DNS:${BACKEND_HOST}`], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);

    // 2. Worker (in-memory D1 + fake Drive) with one running job.
    const fx = await aiFixture({ dispatchMode });
    const token = await fx.newAgentToken();
    const entries = Object.entries(FIXTURE_URLS).map(([name, url]) => ({ name, entry: createEntry({ url, title: name, note: '' }) }));
    const exportId = 'export-flow-1';
    const inboxText = JSON.stringify(createInboxEnvelope(entries.map(e => e.entry), exportId));
    const payload = fx.seedBatch(exportId, { itemIds: entries.map(e => e.entry.id), inboxContent: inboxText });
    assert.equal((await fx.session('/api/ai/jobs', 'POST', payload)).status, 201);

    // 3. HTTPS origin for fixture sites + backend; the backend side injects the
    //    agent credential exactly like a claude.ai network secret would.
    const backendAuthSeen = [];
    const origin = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
      const host = String(req.headers.host || '').split(':')[0];
      if (host === BACKEND_HOST) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        backendAuthSeen.push(req.headers.authorization || null);
        const headers = { 'Content-Type': req.headers['content-type'] || 'application/json', Authorization: `Bearer ${token}` };
        const response = await fx.call(req.url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}) });
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const site = SITES[host]?.[new URL(req.url, 'https://x').pathname];
      if (!site) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<title>404</title>'); return; }
      res.writeHead(site.status, site.headers); res.end(site.body);
    });
    await new Promise(r => origin.listen(0, '127.0.0.1', r)); servers.push(origin);

    // 4. CONNECT proxy: the only way out, like the sandbox egress proxy.
    const tunnels = [];
    const proxy = http.createServer((req, res) => { res.writeHead(403); res.end('direct requests are not allowed'); });
    proxy.on('connect', (req, socket) => {
      tunnels.push(req.url.split(':')[0]);
      const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(socket); socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r)); servers.push(proxy);

    const env = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, CURL_CA_BUNDLE: cert, SSL_CERT_FILE: cert,
      PA_BACKEND_ORIGIN: `https://${BACKEND_HOST}`, NO_PROXY: '', no_proxy: '' };
    delete env.PA_AGENT_TOKEN;
    const node = (args, opts = {}) => run(process.execPath, args, { cwd: dir, env, timeout: 60000, ...opts });

    // 5. The routine's own steps, as CLAUDE-ROUTINE.md runs them.
    if (dispatchMode === 'poll') {
      assert.equal(fx.row(exportId).status, 'queued');
      assert.equal(fx.row(exportId).attempt_count, 0);
      assert.equal(fx.fires.length, 0);
      const claims = await Promise.allSettled([0, 1].map(() => node([script('routine-agent.mjs'), 'claim'])));
      assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1, 'two CLI agents cannot acquire the same job');
      const claimed = JSON.parse(claims.find(r => r.status === 'fulfilled').value.stdout);
      assert.deepEqual(claimed, { job: { exportId, attempt: 1 } });
      assert.match(claims.find(r => r.status === 'rejected').reason.stderr, /agent_busy/);
    }
    const job = JSON.parse((await node([script('routine-agent.mjs'), 'job', exportId, '1'])).stdout);
    assert.ok(job.evidenceKinds.includes('web_pages'), 'Worker advertises the new evidence kinds');
    const inboxPath = join(dir, 'inbox.json');
    await node([script('routine-agent.mjs'), 'inbox', exportId, '1', inboxPath]);
    await node([script('collect-content-evidence.mjs'), inboxPath]);
    const evidenceFile = (await readdir(join(dir, 'private-data'))).find(name => name.startsWith('content-evidence-'));
    const receipts = JSON.parse(await readFile(join(dir, 'private-data', evidenceFile), 'utf8')).items;
    const organized = { format: 'pocket-archive-organized', schema_version: 2, source_export_id: exportId,
      items: receipts.map(({ id, evidence }) => ({ id, ...standInClassify(evidence) })) };
    const organizedPath = join(dir, 'organized.json');
    await writeFile(organizedPath, JSON.stringify(organized));
    await node([script('validate-organized.mjs'), organizedPath, inboxPath, '--require-evidence']);
    const submissions = await Promise.allSettled([0, 1].map(() => node([script('routine-agent.mjs'), 'submit', exportId, '1', organizedPath])));
    assert.equal(submissions.filter(r => r.status === 'fulfilled').length, 1, 'only one concurrent submit may write');
    assert.match(submissions.find(r => r.status === 'fulfilled').value.stdout, /ready/);

    // 6. Transport really went through the proxy, with no client-side secret.
    assert.ok(tunnels.includes(BACKEND_HOST) && tunnels.includes('course.pa-fixture.org'), `tunnels: ${tunnels.join(',')}`);
    assert.ok(backendAuthSeen.length >= 3 && backendAuthSeen.every(value => value === null), 'routine-agent never sends the credential itself');

    // 7. Worker wrote the result back in place, and the App accepts and applies it.
    assert.equal(fx.row(exportId).status, 'ready');
    assert.equal(fx.uploads.length, 1);
    assert.equal(fx.uploads[0].id, payload.resultFileId);
    if (dispatchMode === 'poll') {
      assert.deepEqual(JSON.parse((await node([script('routine-agent.mjs'), 'claim'])).stdout), { job: null });
      assert.equal(fx.fires.length, 0);
    }
    const app = readOrganized(fx.uploads[0].text, { exportIds: [exportId], entries: entries.map(e => e.entry) });
    assert.equal(app.rejected.length, 0, JSON.stringify(app.rejected));
    const byName = Object.fromEntries(entries.map(({ name, entry }) => [name, app.accepted.find(item => item.id === entry.id)]));

    // Content actually read and classified — not just "task finished".
    assert.equal(byName.article.analysisStatus, 'completed');
    assert.deepEqual(byName.article.tags, ['量子電腦']);
    assert.equal(byName.courseHome.analysisStatus, 'completed', 'Marugoto-style home: explored internal pages');
    assert.equal(byName.courseHome.evidence.kind, 'web_pages');
    assert.ok(byName.courseHome.evidence.excerpt.includes(ABOUT_PHRASE));
    assert.deepEqual(byName.courseHome.tags, ['日語學習']);
    assert.equal(byName.spa.evidence.kind, 'site_description');
    assert.deepEqual(byName.spa.tags, ['白板工具']);
    // Truthfully not classified.
    for (const name of ['bare', 'captcha', 'login', 'gone', 'verifyLong', 'signinLong']) {
      assert.equal(byName[name].analysisStatus, 'insufficient_data', name);
      assert.deepEqual(byName[name].tags, [], name);
    }
    assert.equal(byName.captcha.evidence.status, 'auth_required');
    assert.equal(byName.login.evidence.status, 'auth_required');
    // Long (400+ chars) verification / login pages: recognised, not read as content.
    assert.equal(byName.verifyLong.evidence.status, 'auth_required');
    assert.equal(byName.signinLong.evidence.status, 'auth_required');

    const applied = applySuggestions(entries.map(e => e.entry), app.accepted, [byName.courseHome.id, byName.article.id]);
    assert.equal(applied.applied, 2);
    const course = applied.entries.find(entry => entry.id === byName.courseHome.id);
    assert.ok(course.tags.includes('日語學習'), 'the tag reaches the collection');
  } finally {
    for (const server of servers) server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
