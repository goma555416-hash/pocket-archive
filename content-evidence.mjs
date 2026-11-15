// Shared evidence contract for AI batch results. App can validate structure,
// the selected item's URL and an attachment hash, but CANNOT independently attest
// that an external page was actually read. UI must call this AI-reported evidence.
// web_pages: text read from the item's page and/or up to 3 same-host pages
// (`pages` lists them). site_description: only the site's own description was
// readable; agents must keep confidence at most medium.
export const TEXT_KINDS = Object.freeze(['article_body', 'post_text', 'transcript', 'user_share_text', 'web_pages', 'site_description']);
const TEXT_KIND_SET = new Set(TEXT_KINDS);
const EMPTY_STATUSES = new Set(['metadata_only', 'auth_required', 'blocked', 'unavailable']);
const MIN_TEXT = { article_body: 80, post_text: 24, transcript: 80, user_share_text: 24, web_pages: 80, site_description: 40 };
const HASH = /^[0-9a-f]{64}$/;

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function boundString(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`內容證據的${label}無效`);
  return value.trim();
}

function validatePages(pages, sourceUrl) {
  if (!Array.isArray(pages) || pages.length > 4) throw new Error('內容證據的頁面清單無效');
  let host = '';
  try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch { throw new Error('內容證據的來源網址無效'); }
  for (const page of pages) {
    let url;
    try { url = new URL(page?.url); } catch { throw new Error('內容證據的頁面網址無效'); }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host || String(page.url).length > 2048) {
      throw new Error('內容證據只能列出同一網站的 https 頁面');
    }
  }
}

// Checks that need no collection content (status/kind/excerpt/consistency).
// Shared by the Worker (which never stores URLs/notes) and the App.
// The cloud task always runs the newest code, but an App tab can still be on
// an older cached build. allowFutureKinds (App only) accepts a text evidence
// kind this build does not know yet when it carries a real excerpt, so a
// version gap degrades the label instead of rejecting the whole result. The
// Worker, which is current with the routine, stays strict.
const FUTURE_KIND = /^[a-z][a-z0-9_]{2,31}$/;
const RESERVED_KINDS = new Set(['metadata', 'attached_image']);
const FUTURE_MIN_TEXT = 80;

export function validateEvidenceShape(raw, suggestion, { allowFutureKinds = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('內容證據格式無效');
  const status = raw.status;
  const kind = boundString(raw.kind, 32, '類別');
  const excerpt = boundString(raw.excerpt, 900, '摘錄');
  const sourceUrl = boundString(raw.source_url, 2048, '來源網址');
  const observedAt = raw.observed_at;
  if (!validTimestamp(observedAt)) throw new Error('內容證據缺少有效讀取時間');
  if (!['content_read', 'image_read', ...EMPTY_STATUSES].includes(status)) throw new Error('內容證據狀態無效');

  if (status === 'content_read') {
    const known = TEXT_KIND_SET.has(kind);
    const future = !known && allowFutureKinds && FUTURE_KIND.test(kind) && !RESERVED_KINDS.has(kind);
    if (!known && !future) throw new Error('文字證據類別無效');
    if (excerpt.length < (known ? MIN_TEXT[kind] : FUTURE_MIN_TEXT)) throw new Error('正文摘錄不足，不能宣稱已讀取內容');
    if (kind === 'site_description' && suggestion.confidence === 'high') throw new Error('只有網站自我描述時，信心不能是 high');
    if (raw.pages !== undefined) validatePages(raw.pages, sourceUrl);
  } else if (status === 'image_read') {
    if (kind !== 'attached_image' || excerpt.length < 24 || !HASH.test(raw.attachment_sha256 || '')) {
      throw new Error('圖片證據缺少匹配的原始附件 SHA-256／內容描述');
    }
  } else {
    if (kind !== 'metadata' || excerpt) throw new Error('資料不足時不能夾帶未驗證正文');
    if (suggestion.analysis_status !== 'insufficient_data' ||
        suggestion.confidence !== 'low' ||
        (suggestion.suggested_tags || []).length ||
        (suggestion.suggested_categories || []).length ||
        String(suggestion.summary || '').trim()) {
      throw new Error('只取得標題或受阻時，不得輸出已完成的主題分類與摘要');
    }
  }
  if ((status === 'content_read' || status === 'image_read') && suggestion.analysis_status !== 'completed') {
    throw new Error('已讀取內容的證據與分析狀態不一致');
  }
  return { status, kind, excerpt, sourceUrl, observedAt };
}

export function validateContentEvidence(raw, entry, suggestion) {
  // Already-issued schema-v2 results must remain importable. They are displayed
  // as legacy/unverified; a missing evidence receipt does not imply content read.
  if (raw === undefined) return { status: 'legacy_unverified', kind: '', excerpt: '' };
  const { status, kind, excerpt, sourceUrl, observedAt } = validateEvidenceShape(raw, suggestion, { allowFutureKinds: true });
  if (status === 'content_read') {
    if (!entry?.url || sourceUrl !== entry.url) throw new Error('讀取來源與此筆收藏網址不符');
    if (kind === 'user_share_text' && !String(entry.note || '').includes(excerpt)) {
      throw new Error('分享文字不在此筆收藏的原始備註中');
    }
  } else if (status === 'image_read') {
    if (!entry?.attachment || raw.attachment_sha256 !== entry.attachment.hash) {
      throw new Error('圖片證據缺少匹配的原始附件 SHA-256／內容描述');
    }
    if (sourceUrl && sourceUrl !== entry.url) throw new Error('圖片來源網址不符');
  } else if (sourceUrl && sourceUrl !== entry.url) {
    throw new Error('資料不足時不能夾帶未驗證正文');
  }
  return {
    status, kind, excerpt, sourceUrl, observedAt,
    attachmentSha256: status === 'image_read' ? raw.attachment_sha256 : ''
  };
}

export function contentEvidenceLabel(status, kind = '') {
  if (status === 'content_read' && kind === 'web_pages') return 'Claude 回報：已讀取網站頁面內容';
  if (status === 'content_read' && kind === 'site_description') return 'Claude 回報：只讀到網站自我描述，信心較低';
  return {
    content_read: 'Claude 回報：已讀取文字內容',
    image_read: 'Claude 回報：已檢視圖片',
    metadata_only: '只有標題／中繼資料',
    blocked: '讀取遭阻擋',
    auth_required: '需登入，無法讀取',
    unavailable: '內容無法取得',
    legacy_unverified: '舊版結果，未提供讀取證據'
  }[status] || '未知讀取狀態';
}
