// Node-only, user-invoked web research for one collection URL (used by
// scripts/collect-content-evidence.mjs). Tiered and capped:
//   1. read the page itself: text of every article/main block (or the body),
//      with notice/boilerplate lines (maintenance banners, cookie prompts…)
//      removed. A real article with enough text stops here.
//   2. recognise pages that are not content: captcha / login / error pages.
//   3. when the page has too little text (typical for a site home page),
//      read up to MAX_EXTRA_PAGES representative same-host pages (About,
//      docs, course index…) found in the page's own links.
//   4. last resort: the page's own site description (meta/og/JSON-LD written by
//      the site itself, >= MIN_DESCRIPTION chars) as kind site_description,
//      which the agent must treat as lower-confidence evidence. A bare title
//      never counts as content. No site-specific rules, no JavaScript
// execution, no cookies or logins, no crossing to other hosts.
import { fetchPublicArticleHtml, publicArticleTarget } from './codex-article-reader.mjs';

export const MAX_EXTRA_PAGES = 3;
export const ITEM_BUDGET_MS = 25000;
const ENOUGH_SINGLE = 400;     // non-article page that is already informative
const ENOUGH_ARTICLE = 120;    // a real article (existing article rule)
const ENOUGH_TOTAL = 800;      // stop exploring once this much text is read
const MIN_BODY = 80;           // minimum real page text to claim content
export const MIN_DESCRIPTION = 50; // site self-description fallback
const EXCERPT_MAX = 900;

const NOISE = [
  /メンテナンス|サービス停止|ご迷惑をおかけ|停止日時|maintenance|scheduled downtime|service (?:outage|interruption)|系統維護|系统维护|維護公告|暫停服務/i,
  /cookie|クッキー|accept all|同意して(?:続行|閉じる)/i,
  /enable javascript|javascript (?:is )?(?:required|disabled)|javascriptを有効|請啟用 ?javascript|update your browser|ブラウザ(?:の|を)(?:更新|設定)/i,
  /^(?:skip to (?:main )?content|menu|close|メニュー|閉じる|top|back to top|ページトップ)$/i
];
const CAPTCHA = /captcha|recaptcha|hcaptcha|cf-chl|challenge-platform|verify (?:you are|that you are) (?:a )?human|are you a robot|not a robot|人机验证|人機驗證|安全验证|环境异常|環境異常|ロボットではありません/i;
const LOGIN = /\b(?:sign in|log ?in)\b|ログイン|登入|登录/i;
const ERROR = /\b404\b|page not found|not found|ページが見つかりません|お探しのページ|找不到(?:頁面|页面|網頁)|页面不存在|頁面不存在/i;
const ASSET = /\.(?:css|js|mjs|json|xml|rss|png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|woff2?|ttf)$/i;
const LOW_VALUE = /login|signin|sign-in|signup|register|cart|checkout|search|contact|privacy|policy|terms|cookie|sitemap|feed|wp-admin|logout|account/i;
const LINK_SCORES = [
  [/about|このサイトについて|サイト概要|概要|はじめに|about us|關於|关于|介紹|简介|簡介|intro|overview/i, 5],
  [/docs?\b|documentation|guide|getting[-_ ]started|readme|manual|使い方|ガイド|說明|说明|教學|教程/i, 4],
  [/course|curriculum|syllab|lesson|learn|tutorial|topic|grammar|kanji|課程|课程|講座|レッスン|文法|ぶんぽう|教材|features?|products?|works|portfolio|projects?|作品/i, 3]
];

const decode = text => text
  .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, v) => {
    const n = v[0].toLowerCase() === 'x' ? parseInt(v.slice(1), 16) : Number(v);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
  })
  .replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash);/gi, (w, v) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' })[v.toLowerCase()] || w);

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
};

function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const id = (attr(tag, 'name') || attr(tag, 'property')).toLowerCase();
    if (id === key) return attr(tag, 'content');
  }
  return '';
}

function jsonLdDescription(html) {
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      for (const node of [].concat(data, data?.['@graph'] || [])) {
        if (node && typeof node.description === 'string' && node.description.trim()) return node.description.trim();
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  return '';
}

// Visible text of an HTML fragment as lines (block boundaries become breaks).
function textLines(fragment) {
  const clean = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|form|aside|iframe|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|dt|dd|tr|blockquote|figcaption|td|th)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(clean).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const isNoise = line => line.length < 2 || NOISE.some(rx => rx.test(line));

export function parsePage(html, pageUrl) {
  const base = new URL(pageUrl);
  const title = decode((/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim()).slice(0, 200);
  const description = (metaContent(html, 'description') || metaContent(html, 'og:description') || jsonLdDescription(html)).replace(/\s+/g, ' ').slice(0, 400);
  const ogType = metaContent(html, 'og:type').toLowerCase();
  // Prefer <article> regions (a README or post inside a busy <main>), then
  // <main>, then the whole body.
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map(m => m[1]);
  const mains = [...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi)].map(m => m[1]);
  const articleChars = articles.flatMap(textLines).filter(line => !isNoise(line)).join(' ').length;
  const regions = articleChars >= MIN_BODY ? articles : (mains.length ? mains : articles);
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] || html;
  const rawLines = regions.length ? regions.flatMap(textLines) : textLines(body);
  const seen = new Set(); const lines = []; let noiseLines = 0;
  for (const line of rawLines) {
    if (seen.has(line)) continue;
    seen.add(line);
    if (isNoise(line) || line === title) { noiseLines += 1; continue; }
    lines.push(line);
  }
  // Fall back to the whole body when article/main held nothing but noise.
  if (regions.length && lines.join(' ').length < MIN_BODY) {
    for (const line of textLines(body)) {
      if (seen.has(line)) continue;
      seen.add(line);
      if (isNoise(line) || line === title) { noiseLines += 1; continue; }
      lines.push(line);
    }
  }
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  const links = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(m[1], 'href');
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel):/i.test(href)) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    url.hash = '';
    links.push({ url: url.href, text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  const visible = textLines(body).join(' ');
  return {
    title, description, ogType, text, links, noiseLines,
    hasPassword: /<input\b[^>]*type\s*=\s*["']?password/i.test(html),
    hasTime: /<time\b[^>]*datetime/i.test(html),
    visibleSample: `${title} ${visible}`.slice(0, 4000)
  };
}

// Whole-page state: content, or a page that must not be treated as content.
export function pageState(page) {
  if (page.text.length >= ENOUGH_SINGLE) return 'ok';
  if (CAPTCHA.test(page.visibleSample)) return 'captcha';
  if (page.hasPassword && LOGIN.test(page.visibleSample)) return 'login';
  if (ERROR.test(page.title) || (page.text.length < MIN_BODY && ERROR.test(page.visibleSample))) return 'error';
  return 'ok';
}

export function classifyPageType(pageUrl, page) {
  const url = new URL(pageUrl);
  const path = decodeURIComponent(url.pathname);
  const hay = `${path} ${page.title}`;
  if (/^\/(?:[a-z]{2}(?:[-_][a-z]{2,4})?\/?)?(?:index\.\w+)?$/i.test(path)) return 'site_home';
  if (page.ogType === 'article' || (page.hasTime && page.text.length >= ENOUGH_ARTICLE)) return 'article';
  if (/github\.com$|gitlab\.com$/i.test(url.hostname) || /\bprojects?\b/i.test(hay)) return 'project';
  if (/docs?\b|documentation|guide|manual|reference|api\b/i.test(hay)) return 'docs';
  if (/course|curriculum|lesson|learn|tutorial|topic|grammar|課程|课程|講座|レッスン|文法|ぶんぽう|教材/i.test(hay)) return 'course';
  if (/portfolio|works|作品/i.test(hay)) return 'portfolio';
  if (/\btools?\b|calculator|converter|generator|ツール|工具/i.test(hay)) return 'tool';
  return 'page';
}

const normPath = url => { const u = new URL(url); return `${u.hostname}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`; };

export function pickExplorationLinks(pageUrl, links, limit = MAX_EXTRA_PAGES) {
  const base = new URL(pageUrl);
  const lang = /^\/([a-z]{2}(?:[-_][a-z]{2,4})?)(?:\/|$)/i.exec(base.pathname)?.[1]?.toLowerCase() || '';
  const self = normPath(base.href);
  const best = new Map();
  for (const link of links) {
    let url;
    try { url = new URL(link.url); } catch { continue; }
    if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || ASSET.test(url.pathname) || LOW_VALUE.test(url.pathname)) continue;
    const key = normPath(url.href);
    if (key === self || !publicArticleTarget(url.href)) continue;
    const hay = `${decodeURIComponent(url.pathname)} ${link.text}`;
    let score = 0;
    for (const [rx, points] of LINK_SCORES) if (rx.test(hay)) score = Math.max(score, points);
    if (!score) continue;
    const segments = url.pathname.split('/').filter(Boolean);
    if (lang && segments.some(s => s.toLowerCase() === lang)) score += 1;
    score -= Math.max(0, segments.length - 2) * 0.5;
    if (!best.has(key) || best.get(key).score < score) best.set(key, { url: url.href, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, limit).map(x => x.url);
}

function buildExcerpt(sources) {
  const parts = []; let left = EXCERPT_MAX;
  const share = Math.max(160, Math.floor(EXCERPT_MAX / sources.length));
  for (const source of sources) {
    if (left <= 20) break;
    const label = source.title ? `〈${source.title.slice(0, 40)}〉` : '';
    const room = Math.min(left, share) - label.length;
    if (room <= 20) break;
    const piece = label + source.text.slice(0, room);
    parts.push(piece); left -= piece.length + 1;
  }
  return parts.join(' ').slice(0, EXCERPT_MAX);
}

const failureEvidence = (url, stamp, error) => {
  const code = String(error?.code || 'network_error').slice(0, 80);
  const status = ['auth_required', 'captcha_required'].includes(code) ? 'auth_required'
    : ['blocked_target', 'blocked_address', 'redirect_blocked'].includes(code) ? 'blocked' : 'unavailable';
  return { status, kind: 'metadata', excerpt: '', source_url: url, observed_at: stamp, reason: code };
};

export async function researchUrl(item, {
  fetchHtml = href => fetchPublicArticleHtml(href),
  observedAt = () => new Date().toISOString(),
  now = () => Date.now(),
  budgetMs = ITEM_BUDGET_MS
} = {}) {
  const url = item.url || ''; const stamp = observedAt(); const target = publicArticleTarget(url);
  if (!target) return { status: 'unavailable', kind: 'metadata', excerpt: '', source_url: url, observed_at: stamp, reason: 'unsupported_or_private_url' };
  const started = now();
  let html;
  // One retry for transient network failures only (never for captcha, login,
  // blocks or redirects), within the item budget.
  for (let tries = 0; ; tries++) {
    try { html = await fetchHtml(target.href); break; } catch (error) {
      const transient = ['timeout', 'unavailable', 'network_error', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code);
      if (!transient || tries >= 1 || now() - started > budgetMs / 2) return failureEvidence(url, stamp, error);
    }
  }
  const page = parsePage(html, target.href);
  const state = pageState(page);
  const metadata = { title: page.title, description: page.description };
  if (state === 'captcha') return { status: 'auth_required', kind: 'metadata', excerpt: '', source_url: url, observed_at: stamp, reason: 'captcha_required', metadata };
  if (state === 'login') return { status: 'auth_required', kind: 'metadata', excerpt: '', source_url: url, observed_at: stamp, reason: 'login_required', metadata };
  if (state === 'error') return { status: 'unavailable', kind: 'metadata', excerpt: '', source_url: url, observed_at: stamp, reason: 'error_page', metadata };
  const pageType = classifyPageType(target.href, page);

  if (pageType === 'article' ? page.text.length >= ENOUGH_ARTICLE : page.text.length >= ENOUGH_SINGLE) {
    return {
      status: 'content_read', kind: pageType === 'article' ? 'article_body' : 'web_pages',
      excerpt: page.text.slice(0, EXCERPT_MAX), source_url: url, observed_at: stamp,
      text_chars: page.text.length, page_type: pageType, reason: 'page_text', metadata,
      ...(pageType === 'article' ? {} : { pages: [{ url: target.href, title: page.title, page_type: pageType, chars: page.text.length }] })
    };
  }

  // Too little on the page itself: explore representative same-host pages.
  const sources = page.text.length >= 40 ? [{ url: target.href, title: page.title, text: page.text, pageType }] : [];
  const visited = [target.href];
  for (const next of pickExplorationLinks(target.href, page.links)) {
    if (now() - started > budgetMs) break;
    if (sources.reduce((n, s) => n + s.text.length, 0) >= ENOUGH_TOTAL) break;
    visited.push(next);
    let sub;
    try { sub = parsePage(await fetchHtml(next), next); } catch { continue; }
    if (pageState(sub) !== 'ok' || sub.text.length < MIN_BODY) continue;
    sources.push({ url: next, title: sub.title, text: sub.text, pageType: classifyPageType(next, sub) });
  }
  const total = sources.reduce((n, s) => n + s.text.length, 0);
  if (total < MIN_BODY && page.description.length >= MIN_DESCRIPTION && !NOISE.some(rx => rx.test(page.description))) {
    return {
      status: 'content_read', kind: 'site_description',
      excerpt: `〈${page.title.slice(0, 80)}〉${page.description}`.slice(0, EXCERPT_MAX), source_url: url, observed_at: stamp,
      text_chars: page.description.length, page_type: pageType, reason: 'site_description', pages_tried: visited.length, metadata
    };
  }
  if (total < MIN_BODY) {
    return { status: 'metadata_only', kind: 'metadata', excerpt: '', source_url: url, observed_at: stamp, reason: 'no_readable_body', page_type: pageType, pages_tried: visited.length, metadata };
  }
  return {
    status: 'content_read', kind: 'web_pages', excerpt: buildExcerpt(sources), source_url: url, observed_at: stamp,
    text_chars: total, page_type: pageType, reason: 'site_exploration', metadata,
    pages: sources.map(s => ({ url: s.url, title: s.title, page_type: s.pageType, chars: s.text.length }))
  };
}
