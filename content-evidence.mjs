// Shared evidence contract for Codex batch results. App can validate structure,
// the selected item's URL and an attachment hash, but CANNOT independently attest
// that an external page was actually read. UI must call this Codex-reported evidence.
const TEXT_KINDS = new Set(['article_body', 'post_text', 'transcript', 'user_share_text']);
const EMPTY_STATUSES = new Set(['metadata_only', 'auth_required', 'blocked', 'unavailable']);
const MIN_TEXT = { article_body: 80, post_text: 24, transcript: 80, user_share_text: 24 };
const HASH = /^[0-9a-f]{64}$/;

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function boundString(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`內容證據的${label}無效`);
  return value.trim();
}

export function validateContentEvidence(raw, entry, suggestion) {
  // Already-issued schema-v2 results must remain importable. They are displayed
  // as legacy/unverified; a missing evidence receipt does not imply content read.
  if (raw === undefined) return { status: 'legacy_unverified', kind: '', excerpt: '' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('內容證據格式無效');
  const status = raw.status;
  const kind = boundString(raw.kind, 32, '類別');
  const excerpt = boundString(raw.excerpt, 900, '摘錄');
  const sourceUrl = boundString(raw.source_url, 2048, '來源網址');
  const observedAt = raw.observed_at;
  if (!validTimestamp(observedAt)) throw new Error('內容證據缺少有效讀取時間');
  if (!['content_read', 'image_read', ...EMPTY_STATUSES].includes(status)) throw new Error('內容證據狀態無效');

  if (status === 'content_read') {
    if (!TEXT_KINDS.has(kind)) throw new Error('文字證據類別無效');
    if (excerpt.length < MIN_TEXT[kind]) throw new Error('正文摘錄不足，不能宣稱已讀取內容');
    if (!entry?.url || sourceUrl !== entry.url) throw new Error('讀取來源與此筆收藏網址不符');
    if (kind === 'user_share_text' && !String(entry.note || '').includes(excerpt)) {
      throw new Error('分享文字不在此筆收藏的原始備註中');
    }
  } else if (status === 'image_read') {
    if (kind !== 'attached_image' || !entry?.attachment || excerpt.length < 24 ||
        !HASH.test(raw.attachment_sha256 || '') || raw.attachment_sha256 !== entry.attachment.hash) {
      throw new Error('圖片證據缺少匹配的原始附件 SHA-256／內容描述');
    }
    if (sourceUrl && sourceUrl !== entry.url) throw new Error('圖片來源網址不符');
  } else {
    if (kind !== 'metadata' || excerpt || (sourceUrl && sourceUrl !== entry.url)) {
      throw new Error('資料不足時不能夾帶未驗證正文');
    }
    if (suggestion.analysis_status !== 'insufficient_data' ||
        suggestion.confidence !== 'low' ||
        (suggestion.suggested_tags || []).length ||
        (suggestion.suggested_categories || []).length ||
        String(suggestion.summary || '').trim()) {
      throw new Error('只取得標題或受阻時，不得輸出已完成的主題分類與摘要');
    }
  }
  if (status === 'content_read' || status === 'image_read') {
    if (suggestion.analysis_status !== 'completed') {
      throw new Error('已讀取內容的證據與分析狀態不一致');
    }
  }
  return {
    status, kind, excerpt, sourceUrl, observedAt,
    attachmentSha256: status === 'image_read' ? raw.attachment_sha256 : ''
  };
}

export function contentEvidenceLabel(status) {
  return {
    content_read: 'Codex 回報：已讀取文字內容',
    image_read: 'Codex 回報：已檢視圖片',
    metadata_only: '只有標題／中繼資料',
    blocked: '讀取遭阻擋',
    auth_required: '需登入，無法讀取',
    unavailable: '內容無法取得',
    legacy_unverified: '舊版結果，未提供讀取證據'
  }[status] || '未知讀取狀態';
}
