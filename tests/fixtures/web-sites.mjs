// Reproducible fixture websites with known content, shared by the web
// research unit tests and the cloud-sandbox flow test. Hosts use a real-looking
// public suffix so they pass the same URL checks as real collection links.
const html = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const page = (body, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body });
const BANNER = '<article class="notice"><h2>サービス停止のお知らせ</h2><p>ご迷惑をおかけしますが、よろしくお願いいたします。</p><p>サービス停止日時：2025年3月10日 10:00 ～ 12:00</p></article>';
const NAV = '<nav><a href="/ja/">HOME</a><a href="/about/ja/">このサイトについて</a><a href="/ja/grammar">ぶんぽう</a><a href="/privacy">プライバシー</a><a href="https://other.pa-fixture.org/">外部</a></nav>';

export const ARTICLE_PHRASE = '量子電腦利用量子位元的疊加特性';
export const ABOUT_PHRASE = '日本語や日本文化が学べる学習サイトです';
export const BLOG_PHRASE = '驗證碼技術已經發展超過二十年';
export const SPA_DESCRIPTION = 'Fixture Board is a collaborative online whiteboard tool for sketching diagrams with a hand-drawn look.';

export const SITES = {
  'news.pa-fixture.org': {
    '/2026/quantum': page(html('量子電腦入門', `<header>新聞網</header><article><h1>量子電腦入門</h1><time datetime="2026-11-01">2026-11-01</time><p>${ARTICLE_PHRASE}，能同時表示多種狀態。這篇文章介紹量子位元、量子閘與錯誤更正的基本概念，並說明目前量子電腦在化學模擬與最佳化問題上的應用與限制。</p><p>研究人員指出，實用的量子電腦仍需要大幅降低錯誤率，並增加可穩定運作的量子位元數量，才能在密碼學與材料科學上帶來突破。</p></article>`, '<meta property="og:type" content="article">'))
  },
  'course.pa-fixture.org': {
    '/ja': { status: 301, headers: { location: 'http://course.pa-fixture.org/ja/' }, body: '' },
    '/ja/': page(html('まるごと学習 初級', `${NAV}${BANNER}<article id="app"><div class="loading"></div></article><script>window.__app=1</script>`,
      '<meta name="description" content="">')),
    '/about/ja/': page(html('このサイトについて | まるごと学習', `${NAV}${BANNER}<article><h1>このサイトについて</h1><p>「まるごと学習 初級」は、コースブックの内容に沿って${ABOUT_PHRASE}。</p><p>対象者：日本語を勉強している人、日本の文化に興味がある人。</p><p>特徴：Can-do の達成を目標とした練習ができます。動画や写真で具体的な場面の理解を深めながら、かいわ・文法・漢字を練習できます。</p></article>`)),
    '/ja/grammar/': page(html('ぶんぽう | まるごと学習', `${NAV}${BANNER}<article><h1>ぶんぽう</h1><p>TOPIC 1 新しい友だち：いい なまえですね。〜という意味。先週買った本。</p><p>TOPIC 2 店で食べる：この店はおいしいので、よく来ます。野菜なら、このサラダがいいですよ。</p><p>れんしゅう問題で文法を確認できます。</p></article>`)),
    '/privacy': page(html('プライバシー', '<main><p>個人情報の取り扱いについて。</p></main>'))
  },
  'spa.pa-fixture.org': {
    '/': page(html('Fixture Board', '<div id="root"></div><script src="/app.js"></script>', `<meta name="description" content="${SPA_DESCRIPTION}">`))
  },
  'bare.pa-fixture.org': {
    '/': page(html('Bare App', '<div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>'))
  },
  'captcha.pa-fixture.org': {
    '/s/abc': { status: 302, headers: { location: '/mp/appmsgcaptcha?target_url=%2Fs%2Fabc' }, body: '' }
  },
  'login.pa-fixture.org': {
    '/': page(html('Sign in', '<main><h1>Sign in to continue</h1><form><input name="user"><input type="password" name="pw"><button>Log in</button></form></main>'))
  },
  // Verification / login pages with plenty of text (>= 400 chars) must still
  // be recognised; a long normal article that merely mentions CAPTCHA and has
  // a comment-form widget and a sidebar login box must not be.
  'verify.pa-fixture.org': {
    '/': page(html('Security check', `<main><h1>Verify you are human</h1><p>${'This website uses a security service to protect itself from automated abuse, spam and other malicious traffic. Please wait while we check your browser before you continue to the requested page. '.repeat(3)}</p><div class="g-recaptcha" data-sitekey="x"></div><p>Ray ID: 0000 · Performance &amp; security by an edge network provider.</p></main>`,
      '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>'))
  },
  'signin.pa-fixture.org': {
    '/': page(html('Sign in · Fixture Cloud', `<main><h1>Sign in to Fixture Cloud</h1><p>${'Fixture Cloud keeps your documents, photos and notes in one secure place, synchronised across all of your devices. Sign in with your account to continue where you left off. '.repeat(3)}</p><form action="/session"><input name="email"><input type="password" name="password"><button>Log in</button></form></main>`))
  },
  'blog.pa-fixture.org': {
    '/posts/captcha-history': page(html('驗證碼的演變史', `<aside><form><input name="u"><input type="password" name="p"><button>Log in</button></form></aside><article><h1>驗證碼的演變史</h1><time datetime="2026-10-01">2026-10-01</time><p>${BLOG_PHRASE}。從早期扭曲文字的 CAPTCHA，到要求使用者點選紅綠燈圖片的 reCAPTCHA，再到幾乎無感的行為分析，網站一直在便利性與防止機器人濫用之間取捨。本文整理各階段的設計原理、對身心障礙使用者的影響，以及「Verify you are human」這類提示為何讓人困擾。</p><p>${'研究者指出，隱形驗證依賴大量行為資料，也引發隱私上的疑慮。'.repeat(4)}</p></article><section><h2>留言</h2><form action="/comments"><textarea name="c"></textarea><div class="g-recaptcha" data-sitekey="x"></div><button>送出</button></form></section>`,
      '<meta property="og:type" content="article">'))
  },
  'gone.pa-fixture.org': {
    '/old-post': page(html('404 Not Found', '<main><h1>Page not found</h1><p>お探しのページは見つかりませんでした。</p></main>'))
  }
};

export const FIXTURE_URLS = {
  article: 'https://news.pa-fixture.org/2026/quantum',
  courseHome: 'https://course.pa-fixture.org/ja',
  spa: 'https://spa.pa-fixture.org/',
  bare: 'https://bare.pa-fixture.org/',
  captcha: 'https://captcha.pa-fixture.org/s/abc',
  login: 'https://login.pa-fixture.org/',
  gone: 'https://gone.pa-fixture.org/old-post',
  verifyLong: 'https://verify.pa-fixture.org/',
  signinLong: 'https://signin.pa-fixture.org/'
};

// Normal content that must NOT be mistaken for a verification/login page.
export const BLOG_URL = 'https://blog.pa-fixture.org/posts/captcha-history';

// Single-hop fetch with the same contract as the real transports
// (redirects are thrown as redirect_blocked with a location).
export async function fixtureFetchOnce(href) {
  const url = new URL(href);
  const response = SITES[url.hostname]?.[url.pathname];
  const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
  if (!response) throw fail('unavailable');
  if (response.status >= 300 && response.status < 400) throw fail('redirect_blocked', { location: response.headers.location });
  if (response.status === 401 || response.status === 403) throw fail('auth_required');
  if (response.status !== 200) throw fail('unavailable');
  return response.body;
}
