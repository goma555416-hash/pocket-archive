import {
  TYPES, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, cleanTags, normalizeUrl, displayHost, inferType,
  validatedEntry, createEntry, createImageEntry, parseBatchUrls, readBackup, createBackupEnvelope,
  previewMerge, createInboxEnvelope, readOrganized, applySuggestions, restoreSnapshot, matchesEntry,
  escapeHtml, sha256, hasValidImageSignature
} from './lib.mjs';
import { initRepository } from './db.mjs';
import { createZip, readZip, decodeText } from './archive.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {
  repository: null, entries: [], view: 'inbox', query: '', type: 'all', sort: 'new', selected: new Set(),
  batch: [], images: [], pendingImport: null, pendingSuggestions: null, thumbnailUrls: []
};
const names = { inbox: ['收件匣', '尚未整理的收藏'], saved: ['已整理', '已經整理好的收藏'], archived: ['已封存', '暫時收起的收藏'], all: ['全部收藏', '這裡收著所有值得留下的事物'] };
let toastTimer;

function toast(message, duration = 4200) {
  const node = $('#toast');
  node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), duration);
}

function openDialog(id) { const dialog = $(`#${id}`); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog = $(`#${id}`); if (dialog.open) dialog.close(); }

function friendlyBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function filteredEntries() {
  const items = state.entries.filter(entry => (state.view === 'all' || entry.status === state.view) && (state.type === 'all' || entry.type === state.type) && matchesEntry(entry, state.query));
  if (state.sort === 'old') items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  else if (state.sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
  else if (state.sort === 'starred') items.sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt.localeCompare(a.createdAt));
  else items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

function cardHtml(entry) {
  const id = escapeHtml(entry.id);
  const title = escapeHtml(entry.title);
  const targetTitle = entry.kind === 'link' ? `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
  const source = entry.kind === 'link' ? `↗ ${displayHost(entry.url)}` : `圖片 · ${friendlyBytes(entry.attachment?.size || 0)}`;
  const media = entry.attachment ? `<div class="card-media"><span class="image-placeholder">載入圖片…</span><img data-attachment-id="${escapeHtml(entry.attachment.id)}" alt="${title}" hidden /></div>` : entry.previewUrl ? `<div class="card-media"><img src="${escapeHtml(entry.previewUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>` : '';
  const note = entry.note ? `<p class="card-note">${escapeHtml(entry.note)}</p>` : '';
  const summary = entry.aiSuggestion?.summary ? `<p class="ai-summary"><strong>Codex 建議</strong>${escapeHtml(entry.aiSuggestion.summary)}</p>` : '';
  const tags = entry.tags.length ? entry.tags.map(tag => `<span class="tag"># ${escapeHtml(tag)}</span>`).join('') : '<span class="tag">尚未標籤</span>';
  const category = entry.category ? `<span class="category-label">${escapeHtml(entry.category)}</span>` : '';
  const date = new Date(entry.createdAt).toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' });
  const statusAction = entry.status === 'inbox' ? `<button class="text-action" data-action="saved" data-id="${id}">✓ 已整理</button>` : entry.status === 'archived' ? `<button class="text-action" data-action="inbox" data-id="${id}">還原</button>` : `<button class="text-action" data-action="archived" data-id="${id}">封存</button>`;
  return `<article class="item-card${entry.starred ? ' is-starred' : ''}">
    <div class="card-head"><label class="card-select"><input type="checkbox" data-select-id="${id}" ${state.selected.has(entry.id) ? 'checked' : ''} /><span class="sr-only">選取 ${title}</span></label><span class="category" data-type="${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</span>${category}<button class="star-button" type="button" data-action="star" data-id="${id}" aria-label="${entry.starred ? '移除' : '加上'}星號">${entry.starred ? '★' : '☆'}</button></div>
    ${media}<div class="card-body"><div class="card-host">${escapeHtml(source)}</div><h3 class="card-title">${targetTitle}</h3>${note}${summary}</div><div class="card-tags">${tags}</div>
    <div class="card-footer"><span class="card-date">${escapeHtml(date)}</span><div class="card-actions">${statusAction}<button class="text-action" data-action="edit" data-id="${id}">編輯</button><button class="text-action danger" data-action="delete" data-id="${id}">刪除</button></div></div>
  </article>`;
}

async function loadThumbnails() {
  state.thumbnailUrls.forEach(url => URL.revokeObjectURL(url)); state.thumbnailUrls = [];
  await Promise.all($$('[data-attachment-id]').map(async image => {
    try {
      const blob = await state.repository.getAttachment(image.dataset.attachmentId);
      if (!blob) { image.previousElementSibling.textContent = '附件遺失'; return; }
      const url = URL.createObjectURL(blob); state.thumbnailUrls.push(url);
      image.src = url; image.hidden = false; image.previousElementSibling.hidden = true;
    } catch { image.previousElementSibling.textContent = '無法讀取附件'; }
  }));
}

function render() {
  const counts = { inbox: 0, saved: 0, archived: 0, all: state.entries.length };
  state.entries.forEach(entry => { counts[entry.status] += 1; });
  for (const [key, amount] of Object.entries(counts)) {
    $(`#nav-count-${key}`)?.replaceChildren(String(amount));
    $(`#stat-${key}`)?.replaceChildren(String(amount));
  }
  const entries = filteredEntries();
  $('#list-title').innerHTML = `${names[state.view][0]} <small id="result-count">${entries.length}</small>`;
  $('#filter-caption').textContent = names[state.view][1];
  $$('[data-view]').forEach(button => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('is-active', active); button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $('#cards').innerHTML = entries.map(cardHtml).join('');
  $('#empty-state').hidden = entries.length > 0;
  $('#empty-title').textContent = state.entries.length === 0 ? '還沒有任何收藏' : '沒有符合條件的收藏';
  $('#empty-message').textContent = state.entries.length === 0 ? '網址與圖片都可以先放進來。' : '可以試試其他關鍵字，或切換類型與狀態。';
  $('#empty-add').hidden = state.entries.length > 0;
  $('#selection-count').textContent = state.selected.size;
  $('#selection-bar').hidden = state.selected.size === 0;
  $('#select-visible').checked = entries.length > 0 && entries.every(entry => state.selected.has(entry.id));
  loadThumbnails();
}

async function persistEntries(nextEntries, message) {
  try {
    state.entries = await state.repository.replaceEntries(nextEntries);
    render(); if (message) toast(message); return true;
  } catch (error) { toast(error.message, 6500); return false; }
}

function openEditor(entry = null, incoming = null) {
  $('#entry-form').reset();
  const isImage = entry?.kind === 'image';
  const urlLabel = $('#entry-url').closest('label');
  urlLabel.hidden = isImage; $('#fetch-title').hidden = isImage; $('#entry-url').required = !isImage;
  $('#entry-id').value = entry?.id || '';
  $('#entry-preview-url').value = entry?.previewUrl || '';
  $('#entry-url').value = entry?.url || incoming?.url || '';
  $('#entry-title').value = entry?.title || incoming?.title || '';
  $('#entry-note').value = entry?.note || incoming?.note || '';
  $('#entry-category').value = entry?.category || '';
  $('#entry-tags').value = entry?.tags.join(', ') || '';
  $('#entry-type').value = entry?.type || (incoming?.url ? inferType(incoming.url) : '文章');
  $('#entry-status').value = entry?.status || 'inbox'; $('#entry-starred').checked = Boolean(entry?.starred);
  $('#dialog-heading').textContent = entry ? (isImage ? '編輯圖片資料' : '編輯收藏') : '新增收藏';
  $('#save-button').textContent = entry ? '儲存變更 →' : '儲存收藏 →';
  openDialog('entry-dialog'); setTimeout(() => (isImage || incoming?.url || entry?.url ? $('#entry-title') : $('#entry-url')).focus(), 0);
}

async function saveFromForm(event) {
  event.preventDefault();
  const id = $('#entry-id').value;
  const current = id ? state.entries.find(entry => entry.id === id) : null;
  const fields = { title: $('#entry-title').value, note: $('#entry-note').value, type: $('#entry-type').value, category: $('#entry-category').value, status: $('#entry-status').value, tags: cleanTags($('#entry-tags').value), starred: $('#entry-starred').checked, previewUrl: $('#entry-preview-url').value };
  let entry;
  try {
    if (current?.kind === 'image') entry = validatedEntry({ ...current, ...fields, updatedAt: new Date().toISOString() });
    else {
      const url = normalizeUrl($('#entry-url').value);
      const duplicate = state.entries.find(item => item.normalizedUrl === url && item.id !== id);
      if (duplicate) throw new Error('這個網址已收藏過，請直接編輯原有收藏');
      entry = current ? validatedEntry({ ...current, ...fields, url, originalUrl: $('#entry-url').value, updatedAt: new Date().toISOString() }) : createEntry({ ...fields, url, originalUrl: $('#entry-url').value });
    }
  } catch (error) { toast(error.message); return; }
  const next = current ? state.entries.map(item => item.id === id ? entry : item) : [entry, ...state.entries];
  if (await persistEntries(next, current ? '收藏已更新 ✓' : '已收入 Pocket Archive ✓')) closeDialog('entry-dialog');
}

async function updateEntries(ids, updater, message) {
  const selected = new Set(ids); const now = new Date().toISOString();
  const next = state.entries.map(entry => selected.has(entry.id) ? validatedEntry({ ...updater(entry), updatedAt: now }) : entry);
  await persistEntries(next, message);
}

async function deleteEntry(id) {
  const entry = state.entries.find(item => item.id === id); if (!entry) return;
  if (!confirm(`確定永久刪除「${entry.title}」及其本機附件？請先確認已有備份。`)) return;
  try {
    await state.repository.deleteEntry(entry); state.entries = state.entries.filter(item => item.id !== id); state.selected.delete(id); render(); toast('已刪除收藏');
  } catch (error) { toast(error.message); }
}

function previewBatch() {
  state.batch = parseBatchUrls($('#batch-text').value, state.entries);
  const counts = Object.fromEntries(['valid', 'duplicate', 'invalid'].map(key => [key, state.batch.filter(row => row.status === key).length]));
  $('#batch-preview').innerHTML = `<p class="preview-summary"><strong>${counts.valid} 筆有效</strong> · ${counts.duplicate} 筆重複 · ${counts.invalid} 筆無效</p><ul class="preview-list">${state.batch.slice(0, 120).map(row => `<li data-status="${row.status}"><b>${row.status === 'valid' ? '可加入' : row.status === 'duplicate' ? '重複' : '無效'}</b><span>${escapeHtml(row.input)}</span>${row.error ? `<small>${escapeHtml(row.error)}</small>` : ''}</li>`).join('')}</ul>${state.batch.length > 120 ? '<p>只顯示前 120 筆，匯入仍會處理全部項目。</p>' : ''}`;
  $('#batch-save').disabled = counts.valid === 0;
}

async function saveBatch(event) {
  event.preventDefault(); previewBatch();
  const entries = state.batch.filter(row => row.status === 'valid').map(row => createEntry({ url: row.normalizedUrl, originalUrl: row.input, type: row.type }));
  try { await state.repository.saveEntries(entries); state.entries = [...entries, ...state.entries]; render(); closeDialog('batch-dialog'); toast(`已加入 ${entries.length} 筆，錯誤與重複項目已略過 ✓`); }
  catch (error) { toast(error.message, 6500); }
}

function normalizedImageFile(file) {
  if (file.type) return file;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const type = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif' })[extension];
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
}

async function prepareImages(fileList) {
  const files = [...fileList].map(normalizedImageFile).slice(0, 100);
  const existingHashes = new Set(state.entries.map(entry => entry.attachment?.hash).filter(Boolean));
  const seen = new Set(); state.images = [];
  for (const file of files) {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) { state.images.push({ file, status: 'invalid', reason: '不支援的圖片格式' }); continue; }
    if (file.size > MAX_IMAGE_BYTES) { state.images.push({ file, status: 'invalid', reason: '超過 25 MB' }); continue; }
    try {
      const header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      if (!hasValidImageSignature(header, file.type)) { state.images.push({ file, status: 'invalid', reason: '檔案內容與圖片格式不符' }); continue; }
      const hash = await sha256(file); const duplicate = existingHashes.has(hash) || seen.has(hash); seen.add(hash);
      state.images.push({ file, hash, status: duplicate ? 'duplicate' : 'valid', reason: duplicate ? '內容重複' : '' });
    } catch { state.images.push({ file, status: 'invalid', reason: '無法讀取檔案' }); }
  }
  const valid = state.images.filter(item => item.status === 'valid').length;
  $('#image-preview').innerHTML = `<p class="preview-summary"><strong>${valid} 張可加入</strong> · ${state.images.length - valid} 張重複或無效</p><ul class="preview-list">${state.images.map(item => `<li data-status="${item.status}"><b>${item.status === 'valid' ? '可加入' : item.status === 'duplicate' ? '重複' : '無效'}</b><span>${escapeHtml(item.file.name)} · ${friendlyBytes(item.file.size)}</span><small>${escapeHtml(item.reason)}</small></li>`).join('')}</ul>`;
  $('#image-save').disabled = valid === 0;
}

async function saveImages(event) {
  event.preventDefault();
  const valid = state.images.filter(item => item.status === 'valid');
  let saved = 0; const failures = [];
  for (const item of valid) {
    try {
      const entry = createImageEntry(item.file, item.hash); await state.repository.saveEntry(entry, item.file); state.entries.unshift(entry); saved += 1;
    } catch (error) { failures.push(`${item.file.name}: ${error.message}`); }
  }
  render();
  if (!failures.length) { closeDialog('image-dialog'); toast(`已保存 ${saved} 張原始圖片 ✓`); }
  else toast(`已保存 ${saved} 張；${failures.length} 張失敗。${failures[0]}`, 8000);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportBackup() {
  try {
    const envelope = createBackupEnvelope(state.entries); const json = JSON.stringify(envelope, null, 2); const date = new Date().toISOString().slice(0, 10);
    const withAttachments = state.entries.filter(entry => entry.attachment);
    if (!withAttachments.length) download(new Blob([json], { type: 'application/json' }), `pocket-archive-backup-${date}.json`);
    else {
      const files = [{ name: 'backup.json', data: json }];
      for (const entry of withAttachments) {
        const blob = await state.repository.getAttachment(entry.attachment.id);
        if (!blob) throw new Error(`附件遺失：${entry.attachment.name}。請先修復再備份。`);
        files.push({ name: entry.attachment.path, data: blob });
      }
      download(await createZip(files), `pocket-archive-backup-${date}.zip`);
    }
    toast(`完整備份已下載（${state.entries.length} 筆）`);
  } catch (error) { toast(`備份失敗：${error.message}`, 7000); }
}

async function inspectBackup(file) {
  if (file.size > 300 * 1024 * 1024) throw new Error('備份檔不可超過 300 MB');
  let parsed; const blobs = new Map();
  if (file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip') {
    const files = await readZip(file); const manifest = files.get('backup.json');
    if (!manifest) throw new Error('ZIP 根目錄缺少 backup.json');
    parsed = readBackup(decodeText(manifest));
    const expected = new Set(['backup.json']);
    for (const entry of parsed.entries) {
      if (!entry.attachment) continue;
      const path = `attachments/${entry.attachment.id}`; expected.add(path);
      const bytes = files.get(path); if (!bytes) throw new Error(`ZIP 缺少附件：${entry.attachment.name}`);
      if (bytes.length !== entry.attachment.size) throw new Error(`附件大小不符：${entry.attachment.name}`);
      if (!hasValidImageSignature(bytes.slice(0, 64), entry.attachment.mimeType)) throw new Error(`附件格式驗證失敗：${entry.attachment.name}`);
      if (entry.attachment.hash && await sha256(bytes) !== entry.attachment.hash) throw new Error(`附件內容雜湊不符：${entry.attachment.name}`);
      blobs.set(entry.attachment.id, new Blob([bytes], { type: entry.attachment.mimeType }));
    }
    for (const path of files.keys()) if (!expected.has(path)) throw new Error(`ZIP 包含未列於清單的檔案：${path}`);
  } else {
    parsed = readBackup(await file.text());
    if (parsed.entries.some(entry => entry.attachment)) throw new Error('此 JSON 有附件清單但沒有圖片；請選擇完整 ZIP 備份');
  }
  const preview = previewMerge(state.entries, parsed.entries);
  return { parsed, blobs, preview };
}

async function importBackupFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try {
    state.pendingImport = await inspectBackup(file); const { add, skip, conflicts } = state.pendingImport.preview;
    $('#confirm-content').innerHTML = `<p class="preview-summary"><strong>${add.length} 筆將合併</strong> · ${skip.length} 筆重複略過 · ${conflicts.length} 筆 ID 衝突略過</p><p>此操作不會覆寫或刪除現有收藏。</p>${conflicts.length ? `<ul class="preview-list">${conflicts.slice(0, 20).map(item => `<li data-status="invalid"><b>衝突</b><span>${escapeHtml(item.entry.title)}</span></li>`).join('')}</ul>` : ''}`;
    $('#confirm-import').disabled = add.length === 0; openDialog('confirm-dialog');
  } catch (error) { toast(`匯入失敗：${error.message}`, 7500); }
}

async function confirmImport() {
  if (!state.pendingImport) return;
  const entries = state.pendingImport.preview.add; const needed = new Map();
  entries.filter(entry => entry.attachment).forEach(entry => needed.set(entry.attachment.id, state.pendingImport.blobs.get(entry.attachment.id)));
  try {
    await state.repository.importBundle(entries, needed); state.entries = [...entries, ...state.entries]; state.pendingImport = null; render(); closeDialog('confirm-dialog'); toast(`已安全合併 ${entries.length} 筆收藏 ✓`);
  } catch (error) { toast(error.message, 7500); }
}

async function exportForCodex() {
  const chosen = state.selected.size ? state.entries.filter(entry => state.selected.has(entry.id)) : state.entries.filter(entry => entry.status === 'inbox');
  if (!chosen.length) { toast('沒有可匯出的待整理項目'); return; }
  try {
    const envelope = createInboxEnvelope(chosen); const date = new Date().toISOString().slice(0, 10); const json = JSON.stringify(envelope, null, 2);
    const exportIds = await state.repository.getMeta('ai-export-ids', []); await state.repository.setMeta('ai-export-ids', [envelope.export_id, ...exportIds].slice(0, 50));
    if (chosen.some(entry => entry.attachment)) {
      const files = [{ name: 'inbox.json', data: json }];
      for (const entry of chosen.filter(entry => entry.attachment)) {
        const blob = await state.repository.getAttachment(entry.attachment.id); if (!blob) throw new Error(`附件遺失：${entry.attachment.name}`);
        files.push({ name: entry.attachment.path, data: blob });
      }
      download(await createZip(files), `pocket-archive-inbox-${date}.zip`);
    } else download(new Blob([json], { type: 'application/json' }), `pocket-archive-inbox-${date}.json`);
    toast(`已匯出 ${chosen.length} 筆；檔案不會自動上傳`);
  } catch (error) { toast(`匯出失敗：${error.message}`, 7000); }
}

async function importOrganized(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('organized.json 不可超過 8 MB');
    const exportIds = await state.repository.getMeta('ai-export-ids', []);
    state.pendingSuggestions = readOrganized(await file.text(), { exportIds, entries: state.entries });
    const byId = new Map(state.entries.map(entry => [entry.id, entry]));
    const { accepted, rejected } = state.pendingSuggestions;
    $('#ai-preview').innerHTML = `<p class="preview-summary"><strong>${accepted.length} 筆可預覽</strong> · ${rejected.length} 筆拒絕</p><ul class="suggestion-list">${accepted.map(item => `<li><label><input type="checkbox" data-suggestion-id="${escapeHtml(item.id)}" checked /><span><b>${escapeHtml(byId.get(item.id)?.title || item.id)}</b><small>${escapeHtml(item.categories.join('、') || '分類不變')} · ${escapeHtml(item.tags.join('、') || '無新標籤')} · 信心 ${escapeHtml(item.confidence)}</small><em>${escapeHtml(item.summary || item.reason || '無摘要')}</em></span></label></li>`).join('')}</ul>${rejected.length ? `<p class="error-note">${rejected.length} 筆因未知 ID 或欄位錯誤不會套用。</p>` : ''}`;
    $('#apply-ai').hidden = accepted.length === 0;
  } catch (error) { toast(`分類結果拒絕匯入：${error.message}`, 7500); }
}

async function applyOrganized() {
  if (!state.pendingSuggestions) return;
  const selectedIds = $$('[data-suggestion-id]:checked').map(input => input.dataset.suggestionId);
  if (!selectedIds.length) { toast('請至少勾選一筆建議'); return; }
  const result = applySuggestions(state.entries, state.pendingSuggestions.accepted, selectedIds);
  try {
    await state.repository.setMeta('ai-undo-snapshot', { entries: result.snapshot, at: new Date().toISOString() });
    await state.repository.replaceEntries(result.entries); state.entries = result.entries; state.pendingSuggestions = null; render(); $('#ai-preview').innerHTML = ''; $('#apply-ai').hidden = true; closeDialog('ai-dialog'); toast(`已套用 ${result.applied} 筆；可從備份視窗單次復原 ✓`);
  } catch (error) { toast(error.message, 7000); }
}

async function undoAi() {
  const undo = await state.repository.getMeta('ai-undo-snapshot');
  if (!undo?.entries?.length) { toast('目前沒有可復原的 Codex 套用'); return; }
  if (!confirm(`要復原上次 Codex 套用的 ${undo.entries.length} 筆變更嗎？`)) return;
  const restored = restoreSnapshot(state.entries, undo.entries);
  if (await persistEntries(restored, `已復原 ${undo.entries.length} 筆 Codex 變更`)) await state.repository.setMeta('ai-undo-snapshot', null);
}

async function updateStorageSummary() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) $('#storage-summary').innerHTML = `已用約 ${friendlyBytes(estimate.usage)} / ${friendlyBytes(estimate.quota)}。<br />請定期下載完整備份。`;
    const undo = await state.repository.getMeta('ai-undo-snapshot'); $('#undo-ai').disabled = !undo?.entries?.length;
  } catch { /* estimate is best effort */ }
}

async function fetchTitle() {
  let url; try { url = normalizeUrl($('#entry-url').value); } catch (error) { toast(error.message); return; }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = (await response.text()).slice(0, 2_000_000); const documentHtml = new DOMParser().parseFromString(text, 'text/html');
    const title = documentHtml.querySelector('meta[property="og:title"]')?.content || documentHtml.title;
    if (!title?.trim()) throw new Error('頁面沒有可讀標題'); $('#entry-title').value = title.trim().slice(0, 160); toast('已讀取公開頁面標題');
    const image = documentHtml.querySelector('meta[property="og:image"]')?.content;
    if (image) { try { $('#entry-preview-url').value = normalizeUrl(new URL(image, url).href); } catch { /* invalid preview URL */ } }
  } catch { toast('網站未允許跨來源讀取；仍可保存網址並手動填寫標題'); }
  finally { clearTimeout(timeout); }
}

async function readClipboardToBatch() {
  try { const text = await navigator.clipboard.readText(); $('#batch-text').value = text; openDialog('batch-dialog'); previewBatch(); }
  catch { openDialog('batch-dialog'); toast('剪貼簿無法讀取，請長按輸入框貼上'); }
}

function bindEvents() {
  $('#new-button').addEventListener('click', () => openEditor()); $('#mobile-new').addEventListener('click', () => openEditor()); $('#empty-add').addEventListener('click', () => openEditor());
  $('#batch-button').addEventListener('click', () => { $('#batch-form').reset(); state.batch = []; $('#batch-preview').innerHTML = ''; $('#batch-save').disabled = true; openDialog('batch-dialog'); });
  $('#image-button').addEventListener('click', () => { $('#image-form').reset(); state.images = []; $('#image-preview').innerHTML = ''; $('#image-save').disabled = true; openDialog('image-dialog'); });
  $('#backup-button').addEventListener('click', () => { openDialog('backup-dialog'); updateStorageSummary(); }); $('#ai-button').addEventListener('click', () => openDialog('ai-dialog'));
  $$('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.close)));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
  $('#entry-form').addEventListener('submit', saveFromForm); $('#batch-form').addEventListener('submit', saveBatch); $('#image-form').addEventListener('submit', saveImages);
  $('#paste-url').addEventListener('click', async () => { try { $('#entry-url').value = (await navigator.clipboard.readText()).trim(); } catch { toast('剪貼簿無法讀取，請手動貼上'); } });
  $('#paste-inbox').addEventListener('click', readClipboardToBatch); $('#fetch-title').addEventListener('click', fetchTitle); $('#batch-preview-button').addEventListener('click', previewBatch); $('#batch-text').addEventListener('input', previewBatch);
  $('#image-files').addEventListener('change', event => prepareImages(event.target.files));
  const drop = $('#drop-zone'); ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('is-dragging'); })); ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('is-dragging'); })); drop.addEventListener('drop', event => prepareImages(event.dataTransfer.files));
  $('#export-backup').addEventListener('click', exportBackup); $('#import-backup').addEventListener('click', () => $('#backup-file').click()); $('#backup-file').addEventListener('change', importBackupFile); $('#confirm-import').addEventListener('click', confirmImport);
  $('#export-ai').addEventListener('click', exportForCodex); $('#import-ai').addEventListener('click', () => $('#organized-file').click()); $('#organized-file').addEventListener('change', importOrganized); $('#apply-ai').addEventListener('click', applyOrganized); $('#undo-ai').addEventListener('click', undoAi);
  $('#persist-storage').addEventListener('click', async () => { const persisted = await navigator.storage?.persist?.(); toast(persisted ? '瀏覽器已同意保留本機資料' : '瀏覽器未授予保留權限；請定期下載備份'); });
  $('#search-input').addEventListener('input', event => { state.query = event.target.value.trim(); render(); }); $('#type-filter').addEventListener('change', event => { state.type = event.target.value; render(); }); $('#sort-filter').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('#select-visible').addEventListener('change', event => { filteredEntries().forEach(entry => event.target.checked ? state.selected.add(entry.id) : state.selected.delete(entry.id)); render(); }); $('#selection-clear').addEventListener('click', () => { state.selected.clear(); render(); });
  $$('[data-bulk]').forEach(button => button.addEventListener('click', () => { const ids = [...state.selected]; const action = button.dataset.bulk; if (action === 'star') updateEntries(ids, entry => ({ ...entry, starred: !entry.starred }), '已切換星號'); else updateEntries(ids, entry => ({ ...entry, status: action }), '批次狀態已更新'); }));
  $('#bulk-edit-button').addEventListener('click', () => { $('#bulk-form').reset(); openDialog('bulk-dialog'); }); $('#bulk-form').addEventListener('submit', async event => { event.preventDefault(); const category = $('#bulk-category').value.trim(); const tags = cleanTags($('#bulk-tags').value); await updateEntries([...state.selected], entry => ({ ...entry, category: category || entry.category, tags: cleanTags([...entry.tags, ...tags]) }), '批次分類與標籤已更新'); closeDialog('bulk-dialog'); });
  document.addEventListener('change', event => { const input = event.target.closest('[data-select-id]'); if (!input) return; input.checked ? state.selected.add(input.dataset.selectId) : state.selected.delete(input.dataset.selectId); render(); });
  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]'); if (view) { state.view = view.dataset.view; render(); return; }
    const button = event.target.closest('[data-action][data-id]'); if (!button) return; const entry = state.entries.find(item => item.id === button.dataset.id); if (!entry) return;
    if (button.dataset.action === 'edit') openEditor(entry); else if (button.dataset.action === 'delete') deleteEntry(entry.id); else if (button.dataset.action === 'star') updateEntries([entry.id], item => ({ ...item, starred: !item.starred }), entry.starred ? '已移除星號' : '已加上星號'); else updateEntries([entry.id], item => ({ ...item, status: button.dataset.action }), '收藏狀態已更新');
  });
  document.addEventListener('keydown', event => { if ($$('dialog[open]').length || event.ctrlKey || event.metaKey || event.altKey || /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return; if (event.key === '/') { event.preventDefault(); $('#search-input').focus(); } if (event.key.toLowerCase() === 'n') { event.preventDefault(); openEditor(); } });
}

function handleLegacyShareQuery() {
  const params = new URLSearchParams(location.search); if (![...['title', 'text', 'url']].some(key => params.has(key))) return;
  history.replaceState(null, '', location.pathname + location.hash);
  toast('已立即清除分享網址參數；建議改用「複製 → 開啟 App → 讀取剪貼簿」避免伺服器紀錄私人網址', 8000);
}

async function init() {
  bindEvents();
  try {
    const { repository, migration } = await initRepository(); state.repository = repository; state.entries = await repository.listEntries();
    render(); updateStorageSummary(); handleLegacyShareQuery();
    if (migration?.imported) toast(`已安全複製 ${migration.imported} 筆舊版收藏到 IndexedDB；原始資料仍保留`);
    if (migration?.errors?.length || migration?.error) toast('部分舊版資料無法遷移；原始 localStorage 未刪除，請先下載備份', 8000);
    window.__PA_READY__ = true;
  } catch (error) {
    $('#cards').innerHTML = `<div class="fatal-error"><h2>無法開啟本機資料庫</h2><p>${escapeHtml(error.message)}</p><p>請退出私密瀏覽、確認瀏覽器允許網站儲存，再重新載入。舊版 localStorage 不會被刪除。</p></div>`;
    toast(error.message, 10000); window.__PA_READY__ = false;
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    const register = async () => { try { const registration = await navigator.serviceWorker.register('./sw.js'); registration.addEventListener('updatefound', () => toast('Pocket Archive 已下載更新，下次開啟即使用新版')); } catch { toast('離線快取註冊失敗；線上功能仍可使用'); } };
    if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
  }
}

init();
