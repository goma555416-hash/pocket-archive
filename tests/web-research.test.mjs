import test from 'node:test';
import assert from 'node:assert/strict';
import { researchUrl, pickExplorationLinks, classifyPageType, parsePage } from '../web-research.mjs';
import { fetchPublicArticleHtml } from '../codex-article-reader.mjs';
import { validateEvidenceShape } from '../content-evidence.mjs';
import { FIXTURE_URLS, BLOG_URL, BLOG_PHRASE, fixtureFetchOnce, ARTICLE_PHRASE, ABOUT_PHRASE, SPA_DESCRIPTION } from './fixtures/web-sites.mjs';

const fetched = [];
const fetchHtml = href => { fetched.push(href); return fetchPublicArticleHtml(href, { fetchOnce: fixtureFetchOnce }); };
const research = url => researchUrl({ url }, { fetchHtml, observedAt: () => '2026-11-15T00:00:00.000Z' });
const completed = { analysis_status: 'completed', confidence: 'medium', suggested_tags: ['x'], suggested_categories: [], summary: 's' };
const insufficient = { analysis_status: 'insufficient_data', confidence: 'low', suggested_tags: [], suggested_categories: [], summary: '' };

test('a real article is read from its own page', async () => {
  const ev = await research(FIXTURE_URLS.article);
  assert.equal(ev.status, 'content_read');
  assert.equal(ev.kind, 'article_body');
  assert.equal(ev.page_type, 'article');
  assert.ok(ev.excerpt.includes(ARTICLE_PHRASE));
  validateEvidenceShape(ev, completed);
});

test('a site home with only a maintenance banner explores its About page instead of giving up', async () => {
  fetched.length = 0;
  const ev = await research(FIXTURE_URLS.courseHome);
  assert.equal(ev.status, 'content_read');
  assert.equal(ev.kind, 'web_pages');
  assert.equal(ev.page_type, 'site_home');
  assert.equal(ev.reason, 'site_exploration');
  assert.ok(ev.excerpt.includes(ABOUT_PHRASE), 'About page text is in the evidence');
  assert.ok(!/サービス停止|ご迷惑/.test(ev.excerpt), 'maintenance banner is not treated as content');
  assert.ok(ev.pages.some(p => p.url === 'https://course.pa-fixture.org/about/ja/'));
  assert.ok(ev.pages.every(p => new URL(p.url).hostname === 'course.pa-fixture.org'));
  assert.ok(!fetched.some(u => /privacy|other\.pa-fixture/.test(u)), 'never reads policy pages or other hosts');
  assert.ok(fetched.length <= 4, `at most 1 + 3 page fetches (got ${fetched.length})`);
  validateEvidenceShape(ev, completed);
});

test('a JavaScript-only page falls back to the site description, never to the bare title', async () => {
  const spa = await research(FIXTURE_URLS.spa);
  assert.equal(spa.status, 'content_read');
  assert.equal(spa.kind, 'site_description');
  assert.ok(spa.excerpt.includes(SPA_DESCRIPTION));
  validateEvidenceShape(spa, completed);
  assert.throws(() => validateEvidenceShape(spa, { ...completed, confidence: 'high' }), /信心/);

  const bare = await research(FIXTURE_URLS.bare);
  assert.equal(bare.status, 'metadata_only');
  assert.equal(bare.excerpt, '');
  validateEvidenceShape(bare, insufficient);
});

test('captcha, login and error pages are reported truthfully, not read as content', async () => {
  const captcha = await research(FIXTURE_URLS.captcha);
  assert.deepEqual([captcha.status, captcha.reason], ['auth_required', 'captcha_required']);
  const login = await research(FIXTURE_URLS.login);
  assert.deepEqual([login.status, login.reason], ['auth_required', 'login_required']);
  const gone = await research(FIXTURE_URLS.gone);
  assert.deepEqual([gone.status, gone.reason], ['unavailable', 'error_page']);
  for (const ev of [captcha, login, gone]) validateEvidenceShape(ev, insufficient);
});

test('long verification and login pages (400+ chars) are still recognised, not read as content', async () => {
  const verify = await research(FIXTURE_URLS.verifyLong);
  assert.deepEqual([verify.status, verify.reason, verify.excerpt], ['auth_required', 'captcha_required', '']);
  const signin = await research(FIXTURE_URLS.signinLong);
  assert.deepEqual([signin.status, signin.reason, signin.excerpt], ['auth_required', 'login_required', '']);
  for (const ev of [verify, signin]) validateEvidenceShape(ev, insufficient);
});

test('a long normal article mentioning CAPTCHA, with a comment widget and sidebar login, stays content', async () => {
  const ev = await research(BLOG_URL);
  assert.equal(ev.status, 'content_read');
  assert.equal(ev.kind, 'article_body');
  assert.ok(ev.excerpt.includes(BLOG_PHRASE));
});

test('a transient timeout on the item page is retried once; captcha is never retried', async () => {
  let calls = 0;
  const flaky = async href => { calls += 1; if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'timeout' }); return fetchHtml(href); };
  const ev = await researchUrl({ url: FIXTURE_URLS.article }, { fetchHtml: flaky });
  assert.equal(ev.status, 'content_read');
  assert.equal(calls, 2);
  let captchaCalls = 0;
  const captcha = async () => { captchaCalls += 1; throw Object.assign(new Error('captcha_required'), { code: 'captcha_required' }); };
  assert.equal((await researchUrl({ url: FIXTURE_URLS.article }, { fetchHtml: captcha })).reason, 'captcha_required');
  assert.equal(captchaCalls, 1);
});

test('exploration links stay on the host, skip assets and low-value pages, prefer About/docs', () => {
  const links = [
    { url: 'https://s.example.org/privacy', text: 'Privacy' },
    { url: 'https://s.example.org/style.css', text: '' },
    { url: 'https://evil.example.net/about', text: 'About' },
    { url: 'https://s.example.org/blog/2020/01/x', text: 'Old post' },
    { url: 'http://s.example.org/docs/', text: 'Documentation' },
    { url: 'https://s.example.org/about', text: 'About us' }
  ];
  assert.deepEqual(pickExplorationLinks('https://s.example.org/', links), ['https://s.example.org/about', 'https://s.example.org/docs/']);
});

test('page types are recognised generically', () => {
  const p = (title, extra = {}) => ({ ...parsePage(`<title>${title}</title><main><p>x</p></main>`, 'https://s.example.org/'), ...extra });
  assert.equal(classifyPageType('https://s.example.org/', p('Home')), 'site_home');
  assert.equal(classifyPageType('https://s.example.org/en/', p('Home')), 'site_home');
  assert.equal(classifyPageType('https://s.example.org/docs/intro', p('Intro')), 'docs');
  assert.equal(classifyPageType('https://s.example.org/course/unit1', p('Unit 1')), 'course');
  assert.equal(classifyPageType('https://github.com/a/b', p('a/b')), 'project');
  assert.equal(classifyPageType('https://s.example.org/x', p('Post', { ogType: 'article' })), 'article');
});
