export const TYPES = ['文章', '影片', '社群貼文', '圖片', '遊戲', '香水', '工具', '其他'];
export const STATUSES = ['inbox', 'saved', 'archived'];
export const STORAGE_KEY = 'pocket-archive:entries:v1';
export const BACKUP_FORMAT = 'pocket-archive-backup';
export const INBOX_FORMAT = 'pocket-archive-inbox';
export const ORGANIZED_FORMAT = 'pocket-archive-organized';
export const SCHEMA_VERSION = 2;
export const MAX_ITEMS = 20000;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

const TRACKING = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid', 'ref_src', 'si']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function makeId(prefix = 'pa') {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('請輸入網址');
  const raw = input.trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('網址格式不正確'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('僅支援 HTTP 或 HTTPS 網址');
  if (!url.hostname || (!/^https?:\/\//i.test(raw) && !raw.includes('.'))) throw new Error('請輸入有效的網站網址');
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function displayHost(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return '本機圖片'; }
}

export function inferType(url) {
  const host = displayHost(url).toLowerCase();
  if (/youtube\.com|youtu\.be|vimeo\.com/.test(host)) return '影片';
  if (/instagram\.com|threads\.net|x\.com|twitter\.com|facebook\.com|pinterest\./.test(host)) return '社群貼文';
  return '文章';
}

export function cleanTags(input) {
  const array = Array.isArray(input) ? input : String(input || '').split(/[,，、\n]+/);
  return [...new Set(array.map(value => String(value).trim().slice(0, 32)).filter(Boolean))].slice(0, 24);
}

export function extractIncomingShare(search) {
  const params = new URLSearchParams(search || '');
  const title = (params.get('title') || '').trim().slice(0, 160);
  const text = (params.get('text') || '').trim().slice(0, 3000);
  const explicit = (params.get('url') || '').trim();
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  const url = explicit || (match ? match[0].replace(/[),，。]+$/g, '') : '');
  const note = text && match ? text.replace(match[0], '').trim() : (explicit ? text : '');
  return { title, url, note };
}

function isoOrNow(value, now) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : now;
}

function validId(value, prefix = 'pa') {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : makeId(prefix);
}

function sanitizeAttachment(data) {
  if (!data) return null;
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('附件資料格式不正確');
  const mimeType = String(data.mimeType || '').toLowerCase();
  const size = Number(data.size);
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw new Error(`不支援的圖片格式：${mimeType || '未知'}`);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_IMAGE_BYTES) throw new Error('圖片大小超過限制或格式不正確');
  const id = validId(data.id, 'att');
  return {
    id,
    name: String(data.name || 'image').replace(/[\\/\0]/g, '_').slice(0, 180),
    size,
    mimeType,
    hash: typeof data.hash === 'string' && /^[a-f0-9]{64}$/i.test(data.hash) ? data.hash.toLowerCase() : '',
    path: `attachments/${id}`
  };
}

function sanitizeAiSuggestion(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return {
    analysisStatus: data.analysisStatus === 'completed' ? 'completed' : 'insufficient_data',
    categories: cleanTags(data.categories),
    tags: cleanTags(data.tags),
    summary: String(data.summary || '').slice(0, 1200),
    reason: String(data.reason || '').slice(0, 800),
    confidence: ['low', 'medium', 'high'].includes(data.confidence) ? data.confidence : 'low',
    appliedAt: isoOrNow(data.appliedAt, new Date().toISOString())
  };
}

export function validatedEntry(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('資料格式不正確');
  const now = new Date().toISOString();
  const attachment = sanitizeAttachment(data.attachment);
  const kind = attachment || data.kind === 'image' ? 'image' : 'link';
  let url = '';
  let normalizedUrl = '';
  if (kind === 'link') {
    url = normalizeUrl(data.originalUrl || data.url);
    normalizedUrl = normalizeUrl(data.normalizedUrl || url);
  }
  let previewUrl = '';
  if (kind === 'link' && data.previewUrl) {
    try { previewUrl = normalizeUrl(String(data.previewUrl)); } catch { previewUrl = ''; }
  }
  const titleFallback = kind === 'image' ? (attachment?.name || '未命名圖片') : displayHost(url);
  return {
    id: validId(data.id),
    kind,
    url,
    originalUrl: kind === 'link' ? String(data.originalUrl || data.url).trim().slice(0, 4096) : '',
    normalizedUrl,
    previewUrl,
    title: String(data.title || titleFallback).trim().slice(0, 160) || titleFallback,
    note: String(data.note || '').slice(0, 5000),
    type: TYPES.includes(data.type) ? data.type : (kind === 'image' ? '圖片' : inferType(url)),
    category: String(data.category || '').trim().slice(0, 80),
    status: STATUSES.includes(data.status) ? data.status : 'inbox',
    tags: cleanTags(data.tags),
    starred: Boolean(data.starred),
    source: String(data.source || (kind === 'image' ? 'file' : displayHost(url))).slice(0, 160),
    attachment,
    aiSuggestion: sanitizeAiSuggestion(data.aiSuggestion),
    createdAt: isoOrNow(data.createdAt, now),
    updatedAt: isoOrNow(data.updatedAt, now)
  };
}

export function createEntry(input) {
  const now = new Date().toISOString();
  return validatedEntry({ ...input, id: makeId(), createdAt: now, updatedAt: now });
}

export function createImageEntry(file, hash, attachmentId = makeId('att')) {
  const attachment = { id: attachmentId, name: file.name, size: file.size, mimeType: file.type, hash };
  return createEntry({ kind: 'image', title: file.name.replace(/\.[^.]+$/, ''), type: '圖片', source: 'file', attachment });
}

export function parseBatchUrls(text, existing = []) {
  const rows = String(text || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 500);
  const known = new Set(existing.map(entry => entry.normalizedUrl).filter(Boolean));
  const batch = new Set();
  return rows.map((input, index) => {
    try {
      const normalizedUrl = normalizeUrl(input);
      const duplicate = known.has(normalizedUrl) || batch.has(normalizedUrl);
      batch.add(normalizedUrl);
      return { index: index + 1, input, normalizedUrl, status: duplicate ? 'duplicate' : 'valid', type: inferType(normalizedUrl) };
    } catch (error) {
      return { index: index + 1, input, status: 'invalid', error: error.message };
    }
  });
}

export function readBackup(text) {
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('這不是有效的 JSON 檔案'); }
  if (backup?.app === 'Pocket Archive' && backup.version === 1 && Array.isArray(backup.entries)) {
    if (backup.entries.length > MAX_ITEMS) throw new Error('備份筆數過多，請分批處理');
    return { format: BACKUP_FORMAT, schema_version: 1, entries: backup.entries.map(validatedEntry), attachments: [] };
  }
  if (!backup || backup.format !== BACKUP_FORMAT || backup.schema_version !== SCHEMA_VERSION || !Array.isArray(backup.items)) {
    throw new Error('備份格式或版本不受支援');
  }
  if (backup.items.length > MAX_ITEMS) throw new Error('備份筆數過多，請分批處理');
  const entries = backup.items.map(validatedEntry);
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`備份包含重複 ID：${entry.id}`);
    ids.add(entry.id);
  }
  return { ...backup, entries, attachments: Array.isArray(backup.attachments) ? backup.attachments : [] };
}

export function createBackupEnvelope(entries, exportedAt = new Date().toISOString()) {
  return {
    format: BACKUP_FORMAT,
    schema_version: SCHEMA_VERSION,
    app: 'Pocket Archive',
    exported_at: exportedAt,
    items: entries.map(validatedEntry),
    attachments: entries.filter(entry => entry.attachment).map(entry => ({ item_id: entry.id, ...entry.attachment }))
  };
}

export function previewMerge(existing, incoming) {
  const byId = new Map(existing.map(entry => [entry.id, entry]));
  const byUrl = new Map(existing.filter(entry => entry.normalizedUrl).map(entry => [entry.normalizedUrl, entry]));
  const byHash = new Map(existing.filter(entry => entry.attachment?.hash).map(entry => [entry.attachment.hash, entry]));
  const add = [];
  const skip = [];
  const conflicts = [];
  for (const raw of incoming) {
    const entry = validatedEntry(raw);
    const idMatch = byId.get(entry.id);
    if (idMatch) {
      if (JSON.stringify(idMatch) === JSON.stringify(entry)) skip.push({ entry, reason: 'same-id' });
      else conflicts.push({ entry, existing: idMatch, reason: 'id-conflict' });
      continue;
    }
    if (entry.normalizedUrl && byUrl.has(entry.normalizedUrl)) { skip.push({ entry, reason: 'duplicate-url' }); continue; }
    if (entry.attachment?.hash && byHash.has(entry.attachment.hash)) { skip.push({ entry, reason: 'duplicate-image' }); continue; }
    add.push(entry);
    byId.set(entry.id, entry);
    if (entry.normalizedUrl) byUrl.set(entry.normalizedUrl, entry);
    if (entry.attachment?.hash) byHash.set(entry.attachment.hash, entry);
  }
  return { add, skip, conflicts };
}

export function mergeEntries(existing, incoming) {
  const preview = previewMerge(existing, incoming);
  return { entries: [...preview.add, ...existing], added: preview.add.length, skipped: preview.skip.length + preview.conflicts.length, ...preview };
}

export function createInboxEnvelope(entries, exportId = makeId('export'), exportedAt = new Date().toISOString()) {
  return {
    format: INBOX_FORMAT,
    schema_version: SCHEMA_VERSION,
    export_id: exportId,
    exported_at: exportedAt,
    privacy_notice: '此檔案可能包含私人收藏與附件；請只交給你信任的本機或雲端工作環境。',
    items: entries.map(entry => ({
      id: entry.id, kind: entry.kind, url: entry.url, title: entry.title, note: entry.note,
      type: entry.type, category: entry.category, tags: entry.tags, status: entry.status,
      source: entry.source, attachment: entry.attachment
    }))
  };
}

function validateSuggestion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string') throw new Error('建議項目缺少有效 id');
  if (!['completed', 'insufficient_data'].includes(raw.analysis_status)) throw new Error(`${raw.id} 的 analysis_status 無效`);
  const confidence = ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : null;
  if (!confidence) throw new Error(`${raw.id} 的 confidence 無效`);
  return {
    id: raw.id,
    analysisStatus: raw.analysis_status,
    categories: cleanTags(raw.suggested_categories),
    tags: cleanTags(raw.suggested_tags),
    summary: String(raw.summary || '').slice(0, 1200),
    reason: String(raw.reason || '').slice(0, 800),
    confidence
  };
}

export function readOrganized(text, { exportIds = [], entries = [] } = {}) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('這不是有效的 organized JSON'); }
  if (!data || data.format !== ORGANIZED_FORMAT || data.schema_version !== SCHEMA_VERSION || typeof data.source_export_id !== 'string' || !Array.isArray(data.items)) {
    throw new Error('分類結果格式或版本不受支援');
  }
  if (!exportIds.includes(data.source_export_id)) throw new Error('source_export_id 不符合由此裝置匯出的批次');
  const known = new Set(entries.map(entry => entry.id));
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  for (const raw of data.items.slice(0, MAX_ITEMS)) {
    try {
      const item = validateSuggestion(raw);
      if (seen.has(item.id)) throw new Error('結果包含重複 id');
      seen.add(item.id);
      if (!known.has(item.id)) { rejected.push({ id: item.id, reason: 'unknown-id' }); continue; }
      accepted.push(item);
    } catch (error) { rejected.push({ id: String(raw?.id || ''), reason: error.message }); }
  }
  return { sourceExportId: data.source_export_id, accepted, rejected };
}

export function applySuggestions(entries, suggestions, selectedIds = suggestions.map(item => item.id), at = new Date().toISOString()) {
  const selected = new Set(selectedIds);
  const byId = new Map(suggestions.map(item => [item.id, item]));
  const snapshot = [];
  const updated = entries.map(entry => {
    const suggestion = byId.get(entry.id);
    if (!suggestion || !selected.has(entry.id)) return entry;
    snapshot.push(entry);
    return validatedEntry({
      ...entry,
      category: suggestion.categories[0] || entry.category,
      tags: cleanTags([...entry.tags, ...suggestion.tags]),
      status: suggestion.analysisStatus === 'completed' ? 'saved' : entry.status,
      aiSuggestion: { ...suggestion, appliedAt: at },
      updatedAt: at
    });
  });
  return { entries: updated, snapshot, applied: snapshot.length };
}

export function restoreSnapshot(entries, snapshot) {
  const previous = new Map(snapshot.map(entry => [entry.id, validatedEntry(entry)]));
  return entries.map(entry => previous.get(entry.id) || entry);
}

export function matchesEntry(entry, query) {
  const keywords = String(query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const content = [entry.title, entry.url, entry.note, entry.type, entry.category, entry.source, entry.aiSuggestion?.summary, ...entry.tags].join(' ').toLocaleLowerCase();
  return keywords.every(word => content.includes(word));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export async function sha256(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function hasValidImageSignature(bytes, mimeType) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ascii = (start, length) => String.fromCharCode(...value.slice(start, start + length));
  if (mimeType === 'image/png') return value.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => value[index] === byte);
  if (mimeType === 'image/jpeg') return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  if (mimeType === 'image/gif') return value.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (mimeType === 'image/webp') return value.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return value.length >= 12 && ascii(4, 4) === 'ftyp' && /heic|heix|hevc|hevx|heif|mif1|msf1/.test(ascii(8, Math.min(24, value.length - 8)));
  return false;
}
