import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { guardedLookup, articleTransport, articleCurlArgs, curlArticleHtml } from '../codex-article-reader.mjs';

const fakeLookup = answers => (host, options, cb) => {
  const list = answers.map(address => ({ address, family: 4 }));
  if (options.all) cb(null, list); else cb(null, list[0].address, 4);
};

test('guarded lookup answers Node 20+ all:true lookups with an address list', async () => {
  const lookup = guardedLookup(fakeLookup(['93.184.216.34']));
  const result = await new Promise((resolve, reject) => lookup('example.org', { all: true }, (err, addresses) => err ? reject(err) : resolve(addresses)));
  assert.deepEqual(result, [{ address: '93.184.216.34', family: 4 }]);
});

test('guarded lookup still answers single-address lookups', async () => {
  const lookup = guardedLookup(fakeLookup(['93.184.216.34']));
  const [address, family] = await new Promise((resolve, reject) => lookup('example.org', {}, (err, a, f) => err ? reject(err) : resolve([a, f])));
  assert.equal(address, '93.184.216.34');
  assert.equal(family, 4);
});

test('guarded lookup blocks when any resolved address is private', async () => {
  const lookup = guardedLookup(fakeLookup(['93.184.216.34', '10.0.0.5']));
  const err = await new Promise(resolve => lookup('example.org', { all: true }, e => resolve(e)));
  assert.equal(err?.code, 'blocked_address');
});

test('uses curl through the sandbox proxy only when a proxy is configured', () => {
  assert.equal(articleTransport({ HTTPS_PROXY: 'http://proxy:8080' }), 'curl');
  assert.equal(articleTransport({ https_proxy: 'http://proxy:8080' }), 'curl');
  assert.equal(articleTransport({}), 'direct');
});

test('curl article arguments forbid redirects, non-https, cookies and oversize bodies', () => {
  const args = articleCurlArgs('https://example.org/a');
  assert.ok(args.includes('--proto') && args[args.indexOf('--proto') + 1] === '=https');
  assert.ok(!args.includes('-L') && !args.includes('--location'));
  assert.ok(args.includes('--max-filesize'));
  assert.ok(args.includes('--max-time'));
  assert.ok(!args.some(a => /cookie/i.test(a)));
  assert.equal(args.at(-1), 'https://example.org/a');
});

test('curl article fetch maps status and content type like the direct reader', async t => {
  if (spawnSync('curl', ['--version']).status !== 0) { t.skip('curl not installed'); return; }
  const server = createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<main>你好</main>'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://elsewhere.example/' }); res.end(); return; }
    if (req.url === '/login') { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Test-only: allow plain http to reach the local fixture server.
  const opts = { allowHttpForTest: true };
  try {
    assert.equal(await curlArticleHtml(`${base}/ok`, opts), '<main>你好</main>');
    await assert.rejects(curlArticleHtml(`${base}/redirect`, opts), { code: 'redirect_blocked' });
    await assert.rejects(curlArticleHtml(`${base}/login`, opts), { code: 'auth_required' });
    await assert.rejects(curlArticleHtml(`${base}/pdf`, opts), { code: 'not_html' });
  } finally { server.close(); }
});

test('follows up to three same-host redirects, always over https', async () => {
  const { fetchPublicArticleHtml } = await import('../codex-article-reader.mjs');
  const seen = [];
  const hop = async url => {
    seen.push(url);
    if (url === 'https://site.example.org/ja') throw Object.assign(new Error('redirect_blocked'), { code: 'redirect_blocked', location: 'http://site.example.org/ja/' });
    return '<article>ok</article>';
  };
  assert.equal(await fetchPublicArticleHtml('https://site.example.org/ja', { fetchOnce: hop }), '<article>ok</article>');
  assert.deepEqual(seen, ['https://site.example.org/ja', 'https://site.example.org/ja/']);
});

test('refuses cross-host redirects and redirect loops', async () => {
  const { fetchPublicArticleHtml } = await import('../codex-article-reader.mjs');
  const away = async () => { throw Object.assign(new Error('redirect_blocked'), { code: 'redirect_blocked', location: 'https://evil.example.net/' }); };
  await assert.rejects(fetchPublicArticleHtml('https://site.example.org/a', { fetchOnce: away }), { code: 'redirect_blocked' });
  let n = 0;
  const loop = async () => { n++; throw Object.assign(new Error('redirect_blocked'), { code: 'redirect_blocked', location: `/p${n}` }); };
  await assert.rejects(fetchPublicArticleHtml('https://site.example.org/a', { fetchOnce: loop }), { code: 'redirect_blocked' });
  assert.equal(n, 4);
});

test('a redirect to a captcha / verification page is reported as captcha_required, not followed', async () => {
  const { fetchPublicArticleHtml, collectArticleEvidence } = await import('../codex-article-reader.mjs');
  let calls = 0;
  const captcha = async () => { calls++; throw Object.assign(new Error('redirect_blocked'), { code: 'redirect_blocked', location: 'https://mp.example.org/mp/wappoc_appmsgcaptcha?target_url=x' }); };
  await assert.rejects(fetchPublicArticleHtml('https://mp.example.org/s/abc', { fetchOnce: captcha }), { code: 'captcha_required' });
  assert.equal(calls, 1);
  const ev = await collectArticleEvidence({ url: 'https://mp.example.org/s/abc' }, { fetchHtml: u => fetchPublicArticleHtml(u, { fetchOnce: captcha }) });
  assert.equal(ev.status, 'auth_required');
  assert.equal(ev.reason, 'captcha_required');
});
