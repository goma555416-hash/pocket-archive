export const TYPES = ['文章', '影片', '圖片', '遊戲', '香水', '工具', '其他'];
export const STATUSES = ['inbox', 'saved', 'archived'];
export const STORAGE_KEY = 'pocket-archive:entries:v1';
const TRACKING = new Set(['fbclid','gclid','dclid','msclkid','igshid','mc_cid','mc_eid','ref_src']);

export function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('請輸入網址');
  const raw = input.trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(candidate); } catch { throw new Error('網址格式不正確'); }
  if (!['http:','https:'].includes(u.protocol)) throw new Error('僅支援 HTTP 或 HTTPS 網址');
  if (!u.hostname || (!raw.startsWith('http') && !raw.includes('.'))) throw new Error('請輸入有效的網站網址');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

export function displayHost(url) {
  try { return new URL(url).hostname.replace(/^www\./i,''); } catch { return '未知來源'; }
}

export function cleanTags(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/[,，、\n]+/);
  return [...new Set(arr.map(x => String(x).trim().slice(0, 24)).filter(Boolean))].slice(0, 12);
}

export function extractIncomingShare(search) {
  const params = new URLSearchParams(search || '');
  const title = (params.get('title') || '').trim().slice(0, 160);
  const text = (params.get('text') || '').trim().slice(0, 1200);
  const explicit = (params.get('url') || '').trim();
  const regex = /https?:\/\/[^\s<>"']+/i;
  const match = text.match(regex);
  const url = explicit || (match ? match[0].replace(/[),，。]+$/g, '') : '');
  const note = text && match ? text.replace(match[0], '').trim() : (explicit ? text : '');
  return { title, url, note };
}

export function validatedEntry(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('資料格式不正確');
  const url = normalizeUrl(data.url);
  const now = new Date().toISOString();
  const isoOrNow = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value))) ? value : now;
  return {
    id: typeof data.id === 'string' && data.id.length <= 100 && data.id ? data.id : makeId(),
    url,
    normalizedUrl: normalizeUrl(url),
    title: String(data.title || displayHost(url)).trim().slice(0, 160) || displayHost(url),
    note: String(data.note || '').slice(0, 3000),
    type: TYPES.includes(data.type) ? data.type : '其他',
    status: STATUSES.includes(data.status) ? data.status : 'inbox',
    tags: cleanTags(data.tags),
    createdAt: isoOrNow(data.createdAt),
    updatedAt: isoOrNow(data.updatedAt)
  };
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `pa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEntry(input) {
  const now = new Date().toISOString();
  return validatedEntry({ ...input, id: makeId(), createdAt: now, updatedAt: now });
}

export function readBackup(text) {
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('這不是有效的 JSON 檔案'); }
  if (!backup || backup.app !== 'Pocket Archive' || backup.version !== 1 || !Array.isArray(backup.entries)) {
    throw new Error('備份格式或版本不受支援');
  }
  if (backup.entries.length > 20000) throw new Error('備份筆數過多，請分批處理');
  return backup.entries.map(validatedEntry);
}

export function mergeEntries(existing, incoming) {
  const byId = new Set(existing.map(e => e.id));
  const byUrl = new Set(existing.map(e => e.normalizedUrl));
  const added = [];
  for (const entry of incoming) {
    if (byId.has(entry.id) || byUrl.has(entry.normalizedUrl)) continue;
    added.push(entry);
    byId.add(entry.id);
    byUrl.add(entry.normalizedUrl);
  }
  return { entries: [...added, ...existing], added: added.length, skipped: incoming.length - added.length };
}

export function matchesEntry(e, query) {
  const keywords = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const content = [e.title,e.url,e.note,e.type,...e.tags].join(' ').toLocaleLowerCase();
  return keywords.every(word => content.includes(word));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
