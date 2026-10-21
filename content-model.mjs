// Content presentation only; no network, UI or persistence side effects.
export const TYPES = ['圖片', '影片', '社群', '網頁'];
export const WEBPAGE_KINDS = { article: '文章', site: '網站', other: '一般網頁' };
const TOPICS = new Set(['遊戲', '香水', '工具']);
const EVIDENCE = new Set(['user', 'validated-image', 'media-url', 'page-metadata', 'page-url', 'social-url', 'legacy', 'unknown']);
const hostIs = (host, domain) => host === domain || host === `www.${domain}` || host === `m.${domain}`;

export function classifyContent({ url = '', manualType = '', validatedImage = false, metadata = null } = {}) {
  const result = (type, status, evidence) => ({ type, classification: { status, evidence } });
  if (TYPES.includes(manualType)) return result(manualType, 'manual', 'user');
  if (validatedImage) return result('圖片', 'verified', 'validated-image');
  let parsed;
  try { parsed = new URL(url); } catch { return result('網頁', 'provisional', 'unknown'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return result('網頁', 'provisional', 'unknown');
  const host = parsed.hostname.toLowerCase(); const path = parsed.pathname;
  // Only consume structured metadata from the exact successfully fetched page.
  // og:image is a thumbnail and is deliberately never used as primary evidence.
  if (metadata?.pageUrl === parsed.href && metadata?.mixed !== true) {
    let primary;
    try { primary = new URL(metadata.mediaUrl); } catch { /* no usable primary media */ }
    if (primary && ['http:', 'https:'].includes(primary.protocol) && !primary.username && !primary.password) {
      if (['video', 'video.other', 'video.movie', 'video.episode'].includes(metadata.ogType) && /\.(?:mp4|webm|mov|m4v)$/i.test(primary.pathname)) return result('影片', 'verified', 'page-metadata');
      if (metadata.ogType === 'image' && /\.(?:png|jpe?g|gif|webp|avif)$/i.test(primary.pathname)) return result('圖片', 'verified', 'page-metadata');
    }
  }
  if (/\.(?:png|jpe?g|gif|webp|avif|heic|heif)$/i.test(path)) return result('圖片', 'verified', 'media-url');
  if (/\.(?:mp4|webm|mov|m4v)$/i.test(path)) return result('影片', 'verified', 'media-url');
  const video = (hostIs(host, 'youtube.com') && ((path === '/watch' && /^[\w-]+$/.test(parsed.searchParams.get('v') || '')) || /^\/(?:shorts|embed)\/[\w-]+\/?$/.test(path)))
    || (hostIs(host, 'youtu.be') && /^\/[\w-]+\/?$/.test(path))
    || (hostIs(host, 'instagram.com') && /^\/reels?\/[\w-]+\/?$/.test(path))
    || (hostIs(host, 'tiktok.com') && /^\/@[^/]+\/video\/\d+\/?$/.test(path))
    || (hostIs(host, 'vimeo.com') && /^\/\d+\/?$/.test(path));
  if (video) return result('影片', 'verified', 'media-url');
  const social = ['instagram.com', 'threads.net', 'threads.com', 'x.com', 'twitter.com', 'facebook.com', 'pinterest.com', 'pin.it', 'tiktok.com'].some(domain => hostIs(host, domain));
  if (social) return result('社群', 'provisional', 'social-url');
  return result('網頁', 'provisional', 'page-url');
}

// Unlike cleanTags, this never truncates historical values.
export function preservedTags(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[,，、\n]+/);
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

export function mergeTopicTags(existing, candidates) {
  const tags = preservedTags(existing); const pending = [];
  for (const tag of preservedTags(candidates)) {
    if (tags.includes(tag)) continue;
    if (tag.length > 32 || tags.length >= 24) pending.push(tag);
    else tags.push(tag);
  }
  return { tags, pending };
}

export function inputTags(input, previous = []) {
  const tags = preservedTags(input); const old = new Set(preservedTags(previous));
  if ((tags.length > 24 && tags.some(tag => !old.has(tag))) || tags.some(tag => tag.length > 32 && !old.has(tag))) {
    throw new Error('標籤最多 24 個，每個最多 32 字；既有超限標籤可保留，請先整理後再新增。');
  }
  return tags;
}

export function contentFields(data, url) {
  const legacyType = String(data.legacyType || (!TYPES.includes(data.type) ? data.type || '' : ''));
  const stored = data.classification;
  let decision;
  if (TYPES.includes(data.type) && ['manual', 'verified', 'provisional'].includes(stored?.status) && EVIDENCE.has(stored?.evidence)) {
    decision = { type: data.type, classification: { status: stored.status, evidence: stored.evidence } };
  } else {
    decision = classifyContent({ url });
    if (data.type === '文章') decision = { type: '網頁', classification: { status: 'provisional', evidence: 'legacy' } };
    else if (data.type === '社群貼文') decision = { type: '社群', classification: { status: 'provisional', evidence: 'legacy' } };
    else if (TYPES.includes(data.type)) decision = { type: data.type, classification: { status: 'provisional', evidence: 'legacy' } };
    else if (data.attachment) decision = { type: '圖片', classification: { status: 'provisional', evidence: 'legacy' } };
  }
  const candidates = [TOPICS.has(legacyType) ? legacyType : '', data.category || ''];
  return { ...decision, legacyType, webpageKind: Object.hasOwn(WEBPAGE_KINDS, data.webpageKind) ? data.webpageKind : (data.type === '文章' ? 'article' : ''), tags: mergeTopicTags(data.tags, candidates).tags };
}

export function compatibilityPending(entry) {
  const candidates = [TOPICS.has(entry.legacyType) ? entry.legacyType : '', entry.category || '', ...(entry.aiSuggestion?.categories || []), ...(entry.aiSuggestion?.tags || [])];
  return preservedTags(candidates).filter(tag => !entry.tags.includes(tag));
}
