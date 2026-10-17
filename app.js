import { TYPES, STORAGE_KEY, normalizeUrl, displayHost, cleanTags, extractIncomingShare, validatedEntry, createEntry, readBackup, mergeEntries, matchesEntry, escapeHtml } from './lib.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const store = { entries: [], view: 'inbox', query: '', type: 'all', sort: 'new' };
const names = { inbox: ['收件匣', '尚未整理的收藏'], saved:['已整理','已經整理好的收藏'], archived:['已封存','暫時收起的收藏'], all:['全部收藏','這裡收著所有值得留下的事物'] };
let toastTimer;

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
}

function commit(nextEntries, message) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEntries)); }
  catch { toast('無法寫入瀏覽器儲存空間，變更未儲存；請匯出備份或清理空間'); return false; }
  store.entries = nextEntries; render(); toast(message); return true;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) throw new Error();
    store.entries = raw.map(validatedEntry);
  } catch { store.entries = []; toast('收藏資料讀取異常，請透過備份還原'); }
}

function filteredEntries() {
  let items = store.entries.filter(e => (store.view === 'all' || e.status === store.view) && (store.type === 'all' || e.type === store.type) && matchesEntry(e, store.query));
  if (store.sort === 'old') items.sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  else if (store.sort === 'title') items.sort((a,b) => a.title.localeCompare(b.title, 'zh-Hant'));
  else items.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

function render() {
  const counts = {inbox:0,saved:0,archived:0,all:store.entries.length};
  store.entries.forEach(e => counts[e.status]++);
  for (const [key, amount] of Object.entries(counts)) {
    const node = $(`#nav-count-${key}`); if (node) node.textContent = amount;
    const stat = $(`#stat-${key}`); if (stat) stat.textContent = amount;
  }
  $('#list-title').innerHTML = `${names[store.view][0]} <small id="result-count">${filteredEntries().length}</small>`;
  $('#filter-caption').textContent = names[store.view][1];
  $$('[data-view]').forEach(b => { const active = b.dataset.view === store.view; b.classList.toggle('is-active', active); b.classList.toggle('active', active); b.setAttribute('aria-current',active?'page':'false'); });
  const entries = filteredEntries();
  $('#cards').innerHTML = entries.map(cardHtml).join('');
  $('#empty-state').hidden = entries.length > 0;
  $('#empty-title').textContent = store.entries.length === 0 ? '還沒有任何收藏' : '沒有符合條件的收藏';
  $('#empty-message').textContent = store.entries.length === 0 ? '看到喜歡的東西，就先把網址放進來。' : '可以試試其他關鍵字，或切換分類與狀態。';
  $('#empty-add').hidden = store.entries.length > 0;
}

function cardHtml(entry) {
  const id = escapeHtml(entry.id);
  const url = escapeHtml(entry.url);
  const title = escapeHtml(entry.title);
  const host = escapeHtml(displayHost(entry.url));
  const note = entry.note ? `<p class="card-note">${escapeHtml(entry.note)}</p>` : '';
  const tags = entry.tags.length ? entry.tags.map(t => `<span class="tag"># ${escapeHtml(t)}</span>`).join('') : '<span class="tag">尚未標籤</span>';
  const date = new Date(entry.createdAt).toLocaleDateString('zh-TW',{year:'numeric',month:'short',day:'numeric'});
  const action = entry.status === 'inbox' ? `<button class="text-action" data-action="save" data-id="${id}" title="移至已整理">✓ 已整理</button>` : entry.status === 'archived' ? `<button class="text-action" data-action="inbox" data-id="${id}">還原</button>` : `<button class="text-action" data-action="archive" data-id="${id}">封存</button>`;
  return `<article class="item-card"><div class="card-head"><span class="category" data-type="${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</span><button class="card-menu" type="button" data-action="edit" data-id="${id}" aria-label="編輯 ${title}" title="編輯收藏">⋯</button></div><div class="card-body"><div class="card-host">↗ ${host}</div><h3 class="card-title"><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h3>${note}</div><div class="card-tags">${tags}</div><div class="card-footer"><span class="card-date">${escapeHtml(date)}</span><div class="card-actions">${action}<button class="text-action" type="button" data-action="edit" data-id="${id}">編輯</button><button class="text-action danger" type="button" data-action="delete" data-id="${id}">刪除</button></div></div></article>`;
}

function openEditor(entry = null, incoming = null) {
  $('#entry-form').reset();
  $('#entry-id').value = entry?.id || '';
  $('#entry-url').value = entry?.url || incoming?.url || '';
  $('#entry-title').value = entry?.title || incoming?.title || '';
  $('#entry-note').value = entry?.note || incoming?.note || '';
  $('#entry-tags').value = entry?.tags.join(', ') || '';
  $('#entry-type').value = entry?.type || '文章';
  $('#entry-status').value = entry?.status || 'inbox';
  $('#dialog-heading').textContent = entry ? '編輯收藏' : '新增收藏';
  $('#save-button').textContent = entry ? '儲存變更 →' : '儲存收藏 →';
  $('#entry-dialog').showModal();
  (incoming?.url || entry?.url ? $('#entry-title') : $('#entry-url')).focus();
}
function closeEditor() { $('#entry-dialog').close(); }

function saveFromForm(event) {
  event.preventDefault();
  const id = $('#entry-id').value;
  const input = { url: $('#entry-url').value, title: $('#entry-title').value, note: $('#entry-note').value, type: $('#entry-type').value, status: $('#entry-status').value, tags: cleanTags($('#entry-tags').value) };
  let normalized;
  try { normalized = normalizeUrl(input.url); } catch (error) { toast(error.message); $('#entry-url').focus(); return; }
  const duplicate = store.entries.find(e => e.normalizedUrl === normalized && e.id !== id);
  if (duplicate) { toast('這個網址已收藏過，請直接編輯原有收藏'); return; }
  let entry;
  if (id) {
    const idx = store.entries.findIndex(e => e.id === id); if (idx === -1) return;
    entry = validatedEntry({ ...store.entries[idx], ...input, updatedAt: new Date().toISOString() });
    if (commit(store.entries.map(e => e.id === id ? entry : e), '收藏已更新 ✓')) closeEditor();
  } else {
    entry = createEntry(input);
    if (commit([entry, ...store.entries], '已收入 Pocket Archive ✓')) closeEditor();
  }
}

function updateStatus(id, status) {
  const entry = store.entries.find(e => e.id === id); if (!entry) return;
  commit(store.entries.map(e => e.id === id ? {...e, status, updatedAt: new Date().toISOString()} : e), '收藏狀態已更新');
}
function deleteEntry(id) {
  const entry = store.entries.find(e => e.id === id); if (!entry) return;
  if (!window.confirm(`確定刪除「${entry.title}」？這個操作無法復原。`)) return;
  commit(store.entries.filter(e => e.id !== id), '已刪除收藏');
}

function exportBackup() {
  const contents = JSON.stringify({app:'Pocket Archive',version:1,exportedAt:new Date().toISOString(),entries:store.entries}, null, 2);
  const blob = new Blob([contents], {type:'application/json'});
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href; anchor.download = `pocket-archive-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000); toast('備份檔案已下載');
}
async function importBackup(event) {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('檔案不可超過 8 MB');
    const incoming = readBackup(await file.text());
    const merged = mergeEntries(store.entries, incoming);
    if (!merged.added) { toast(`沒有新收藏，略過 ${merged.skipped} 筆重複資料`); return; }
    if (!confirm(`將新增 ${merged.added} 筆收藏，並略過 ${merged.skipped} 筆重複資料。確認匯入？`)) return;
    commit(merged.entries, `已匯入 ${merged.added} 筆收藏 ✓`);
  } catch (error) { toast(`匯入失敗：${error.message}`); }
  finally { event.target.value = ''; }
}

function bindEvents() {
  $('#new-button').addEventListener('click', () => openEditor());
  $('#mobile-new').addEventListener('click', () => openEditor());
  $('#empty-add').addEventListener('click', () => openEditor());
  $('#dialog-close').addEventListener('click', closeEditor);
  $('#dialog-cancel').addEventListener('click', closeEditor);
  $('#entry-form').addEventListener('submit', saveFromForm);
  $('#entry-dialog').addEventListener('click', event => { if (event.target === $('#entry-dialog')) closeEditor(); });
  $('#paste-url').addEventListener('click', async () => { try { $('#entry-url').value = (await navigator.clipboard.readText()).trim(); $('#entry-title').focus(); } catch { toast('剪貼簿無法讀取，請長按輸入框貼上'); } });
  $('#export-button').addEventListener('click', exportBackup);
  $('#import-button').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', importBackup);
  $('#search-input').addEventListener('input', e => { store.query = e.target.value.trim(); render(); });
  $('#type-filter').addEventListener('change', e => { store.type = e.target.value; render(); });
  $('#sort-filter').addEventListener('change', e => { store.sort = e.target.value; render(); });
  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]');
    if (view) { store.view = view.dataset.view; render(); return; }
    const button = event.target.closest('[data-action][data-id]'); if (!button) return;
    const {action,id} = button.dataset;
    if (action === 'edit') openEditor(store.entries.find(e => e.id === id));
    if (action === 'save') updateStatus(id,'saved');
    if (action === 'archive') updateStatus(id,'archived');
    if (action === 'inbox') updateStatus(id,'inbox');
    if (action === 'delete') deleteEntry(id);
  });
  document.addEventListener('keydown', event => {
    if ($('#entry-dialog').open || event.ctrlKey || event.metaKey || event.altKey || /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return;
    if (event.key === '/') { event.preventDefault(); $('#search-input').focus(); }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); openEditor(); }
  });
}

function handleShare() {
  const params = new URLSearchParams(window.location.search);
  if (![...['title','text','url']].some(key => params.has(key))) return;
  const incoming = extractIncomingShare(window.location.search);
  history.replaceState(null, '', window.location.pathname + window.location.hash);
  if (!incoming.url) { toast('分享內容沒有可辨識的網址，請手動貼上'); openEditor(null, incoming); return; }
  let normalized;
  try { normalized = normalizeUrl(incoming.url); } catch { toast('分享的網址格式不正確'); openEditor(null, incoming); return; }
  const existing = store.entries.find(e => e.normalizedUrl === normalized);
  if (existing) { toast('這個網址已經收藏過了'); openEditor(existing); }
  else openEditor(null, incoming);
}

load(); bindEvents(); render(); handleShare();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
