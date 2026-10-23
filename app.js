import { receiveCaptureJob, imageDimensions } from './capture-client.mjs';
import { identifySocialMediaUrl, identifySocialPlatform } from './social-metadata.mjs';
import { classifyContent, WEBPAGE_KINDS, inputTags, mergeTopicTags, compatibilityPending } from './content-model.mjs';
import { codexLaunchCommand, cloudAiJobForReview } from './ai-launch.mjs';
import { contentEvidenceLabel } from './content-evidence.mjs';
import { createImageViewer } from './image-viewer.mjs';
import {
  ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, normalizeUrl, displayHost,
  validatedEntry, createEntry, createCaptureEntry, createImageEntry, parseBatchUrls, readBackup, createBackupEnvelope,
  previewMerge, createInboxEnvelope, readOrganized, applySuggestions, restoreSnapshot, matchesEntry,
  escapeHtml, sha256, hasValidImageSignature, makeId
} from './lib.mjs';
import { initRepository, StaleDataError } from './db.mjs';
import { createZip, readZip, decodeText } from './archive.mjs';
import { GoogleAuthSession, DriveApi, isValidGoogleClientId, loadGoogleIdentity } from './drive.mjs';
import { BackendDriveApi, PocketBackendClient, authResultFromLocation } from './backend.mjs';
import { createMigrationManifest, readMigrationManifest, mergeMigrationAi } from './migration.mjs';
import { CloudBackupService, CloudAiExchange, CloudSyncService } from './cloud.mjs';
import { pruneResolvedConflicts, recordLocalChanges, reconcileReplica, replicaRecord, resolveConflict } from './sync.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {
  repository: null, entries: [], view: 'inbox', query: '', type: 'all', sort: 'new', selected: new Set(),
  batch: [], images: [], pendingImport: null, pendingSuggestions: null, thumbnailUrls: [],
  deviceId: '', syncJournal: {}, tombstones: {}, cloudConflicts: [], cloudBackups: [], cloudJobs: [],
  cloudSettings: { clientId: '', autoBackup: true, retention: 5, encryption: false },
  cloudPassphrase: '', auth: null, drive: null, workspace: null, backupService: null, aiExchange: null, syncService: null,
  cloudUser: null, cloudBusy: false, backupTimer: null, syncTimer: null,
  backend: null, backendAvailable: false, backendOwner: null, backendSession: null, backendSessions: [],
  captureCredentials: [], captureBusy: false, localWriteBusy: 0, dataRevision: 0, activeAiExportId: '',
  googleIdentityStatus: 'idle', googleIdentityPromise: null, editorDecision: null, editorUrl: '', editorBaseline: null
};
const names = { inbox: ['收件匣', '尚未整理的收藏'], saved: ['已整理', '已經整理好的收藏'], archived: ['已封存', '暫時收起的收藏'], all: ['全部收藏', '這裡收著所有值得留下的事物'] };
let toastTimer; let toastPopoverTimer; let thumbnailGeneration = 0;
const imageViewer = createImageViewer(document.querySelector('#image-viewer'), { getAttachment: id => state.repository.getAttachment(id) });

function openedDialog() { const dialogs = $$('dialog[open]'); return dialogs[dialogs.length - 1] || null; }

function popoverIsOpen(node) {
  try { return node.matches(':popover-open'); } catch { return false; }
}

function presentToast(node) {
  node.classList.remove('in-dialog');
  if (typeof node.showPopover === 'function') {
    if (node.parentElement !== document.body) document.body.append(node);
    try {
      // Re-open an existing popover so it is ordered above a dialog that may
      // have entered the top layer after the previous notification.
      if (popoverIsOpen(node)) node.hidePopover();
      node.showPopover();
      return;
    } catch { /* older Safari fallback below */ }
  }
  const dialog = openedDialog();
  if (dialog) {
    const heading = dialog.querySelector('.modal-heading');
    (heading?.parentElement || dialog).insertBefore(node, heading?.nextSibling || null);
    node.classList.add('in-dialog');
  } else if (node.parentElement !== document.body) document.body.append(node);
}

function hideToast(node = $('#toast')) {
  clearTimeout(toastTimer); clearTimeout(toastPopoverTimer); toastTimer = null;
  node.classList.remove('show'); node.setAttribute('aria-hidden', 'true');
  if (popoverIsOpen(node)) {
    toastPopoverTimer = setTimeout(() => {
      if (!node.classList.contains('show') && popoverIsOpen(node)) {
        try { node.hidePopover(); } catch { /* visibility styles remain authoritative */ }
      }
    }, 230);
  }
}

function toast(message, duration = 4200) {
  const node = $('#toast');
  clearTimeout(toastTimer); clearTimeout(toastPopoverTimer);
  node.textContent = message; node.setAttribute('aria-hidden', 'false');
  presentToast(node); node.classList.add('show');
  toastTimer = setTimeout(() => hideToast(node), duration);
}

function openDialog(id) {
  const dialog = $(`#${id}`);
  if (!dialog.open) dialog.showModal();
  const node = $('#toast'); if (node.classList.contains('show')) presentToast(node);
}
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
  const source = entry.kind === 'link' ? `↗ ${displayHost(entry.url)}${entry.type === '圖片' || entry.previewUrl ? ' · 外部圖片連結，未離線保存' : ''}` : `原圖已存於本機 · ${friendlyBytes(entry.attachment?.size || 0)}`;
  const media = entry.attachment ? `<button type="button" class="card-media original-preview" data-view-image="${id}" aria-label="檢視原圖：${title}"><span class="image-placeholder">載入圖片…</span><img data-attachment-id="${escapeHtml(entry.attachment.id)}" alt="" hidden /></button>` : entry.previewUrl ? `<div class="card-media"><img src="${escapeHtml(entry.previewUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>` : '';
  const note = entry.note ? `<p class="card-note">${escapeHtml(entry.note)}</p>` : '';
  const summary = entry.aiSuggestion?.summary ? `<p class="ai-summary"><strong>Codex 建議</strong>${escapeHtml(entry.aiSuggestion.summary)}</p>` : '';
  const tags = entry.tags.length ? entry.tags.map(tag => `<span class="tag"># ${escapeHtml(tag)}</span>`).join('') : '<span class="tag">尚未標籤</span>';
  const detail = entry.type === '網頁' && WEBPAGE_KINDS[entry.webpageKind] ? `<span class="content-detail">${WEBPAGE_KINDS[entry.webpageKind]}</span>` : '';
  const confirmation = entry.classification.status === 'provisional' ? '<span class="confirmation-label">待確認</span>' : entry.classification.status === 'manual' ? '<span class="content-detail">手動確認</span>' : '';
  const pending = compatibilityPending(entry);
  const compatibility = pending.length ? `<p class="compatibility-note">舊分類或 AI 標籤尚未轉入，原值已保留；可在編輯中整理標籤後補入：${escapeHtml(pending.join('、'))}</p>` : '';
  const date = new Date(entry.createdAt).toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' });
  const statusAction = entry.status === 'inbox' ? `<button class="text-action" data-action="saved" data-id="${id}">✓ 已整理</button>` : entry.status === 'archived' ? `<button class="text-action" data-action="inbox" data-id="${id}">還原</button>` : `<button class="text-action" data-action="archived" data-id="${id}">封存</button>`;
  return `<article class="item-card${entry.starred ? ' is-starred' : ''}">
    <div class="card-head"><label class="card-select"><input type="checkbox" data-select-id="${id}" ${state.selected.has(entry.id) ? 'checked' : ''} /><span class="sr-only">選取 ${title}</span></label><span class="category" data-type="${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</span>${detail}${confirmation}<button class="star-button" type="button" data-action="star" data-id="${id}" aria-label="${entry.starred ? '移除' : '加上'}星號">${entry.starred ? '★' : '☆'}</button></div>
    ${media}<div class="card-body"><div class="card-host">${escapeHtml(source)}</div><h3 class="card-title">${targetTitle}</h3>${note}${summary}${compatibility}</div><div class="card-tags">${tags}</div>
    <div class="card-footer"><span class="card-date">${escapeHtml(date)}</span><div class="card-actions">${statusAction}<button class="text-action" data-action="edit" data-id="${id}">編輯</button><button class="text-action danger" data-action="delete" data-id="${id}">刪除</button></div></div>
  </article>`;
}

async function loadThumbnails() {
  const generation = ++thumbnailGeneration;
  state.thumbnailUrls.forEach(url => URL.revokeObjectURL(url)); state.thumbnailUrls = [];
  await Promise.all($$('[data-attachment-id]').map(async image => {
    try {
      const blob = await state.repository.getAttachment(image.dataset.attachmentId);
      if (generation !== thumbnailGeneration || !image.isConnected) return;
      if (!blob) { image.previousElementSibling.textContent = '附件遺失 · 點擊查看說明'; image.closest('.item-card').querySelector('.card-host').textContent = '本機原圖遺失 · 請從完整 ZIP 還原'; return; }
      const url = URL.createObjectURL(blob); state.thumbnailUrls.push(url);
      image.onload = () => { image.hidden = false; image.previousElementSibling.hidden = true; };
      image.onerror = () => { image.hidden = true; image.previousElementSibling.hidden = false; image.previousElementSibling.textContent = '無法預覽 · 點擊下載原檔'; };
      image.src = url;
    } catch { if (image.isConnected) image.previousElementSibling.textContent = '無法讀取附件'; }
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

async function persistEntries(nextEntries, message, attachmentBlobs = new Map()) {
  if (state.captureBusy) { toast('正在安全接收收藏，請稍後再儲存變更'); return false; }
  state.localWriteBusy++;
  try {
    const sync = recordLocalChanges(state.entries, nextEntries, { deviceId: state.deviceId, journal: state.syncJournal, tombstones: state.tombstones });
    const retained = new Set(sync.entries.map(entry => entry.id));
    const deleteAttachmentIds = state.entries.filter(entry => !retained.has(entry.id)).map(entry => entry.attachment?.id).filter(Boolean);
    const savedEntries = await state.repository.replaceBundle(sync.entries, attachmentBlobs, {
      deleteAttachmentIds, expectedRevision: state.dataRevision,
      meta: { 'sync-journal': sync.journal, 'sync-tombstones': sync.tombstones, 'cloud-dirty': true }
    });
    state.entries = savedEntries; state.dataRevision = savedEntries.dataRevision;
    state.syncJournal = sync.journal; state.tombstones = sync.tombstones;
    scheduleAutoBackup(); scheduleAutoSync();
    render(); if (message) toast(message); return true;
  } catch (error) {
    if (error instanceof StaleDataError) {
      const snapshot = await state.repository.readSyncSnapshot();
      state.entries = snapshot.entries; state.syncJournal = snapshot.journal; state.tombstones = snapshot.tombstones; state.dataRevision = snapshot.revision;
      render();
    }
    toast(error.message, 6500); return false;
  }
  finally { state.localWriteBusy--; }
}

async function localEntryMutation(action) {
  if (state.captureBusy) { toast('正在安全接收收藏，請稍後再試'); return; }
  state.localWriteBusy++; try { return await action(); } finally { state.localWriteBusy--; }
}

function openEditor(entry = null, incoming = null) {
  $('#entry-form').reset();
  $('#entry-metadata-status').textContent = '';
  const isImage = entry?.kind === 'image';
  const urlLabel = $('#entry-url').closest('label');
  urlLabel.hidden = isImage; $('#fetch-title').hidden = isImage; $('#entry-url').required = !isImage;
  $('#entry-id').value = entry?.id || '';
  $('#entry-preview-url').value = entry?.previewUrl || '';
  $('#entry-url').value = entry?.originalUrl || entry?.url || incoming?.url || '';
  state.editorUrl = $('#entry-url').value;
  state.editorDecision = entry ? { type: entry.type, classification: entry.classification } : classifyContent({ url: state.editorUrl });
  state.editorBaseline = entry ? JSON.stringify(entry) : null;
  $('#entry-title').value = entry?.title || incoming?.title || '';
  $('#entry-note').value = entry?.note || incoming?.note || '';
  $('#entry-category').value = entry?.category || '';
  $('#entry-tags').value = entry?.tags.join(', ') || '';
  $('#entry-type').value = state.editorDecision.type;
  $('#entry-webpage-kind').value = entry?.webpageKind || '';
  $('#entry-legacy').hidden = !entry?.legacyType && !entry?.category;
  $('#entry-legacy-info').textContent = `原有類型：${entry?.legacyType || '無'}。舊分類與原有標籤完整保留；超限時請先整理標籤。`;
  $('#entry-error').hidden = true;
  renderEditorType();
  $('#entry-status').value = entry?.status || 'inbox'; $('#entry-starred').checked = Boolean(entry?.starred);
  $('#dialog-heading').textContent = entry ? (isImage ? '編輯圖片資料' : '編輯收藏') : '新增收藏';
  $('#save-button').textContent = entry ? '儲存變更 →' : '儲存收藏 →';
  openDialog('entry-dialog');
  if (matchMedia('(pointer: fine)').matches) (isImage || incoming?.url || entry?.url ? $('#entry-title') : $('#entry-url')).focus();
  else $('#dialog-heading').focus();
}

function renderEditorType() {
  $('#entry-webpage-kind-row').hidden = $('#entry-type').value !== '網頁';
  const status = state.editorDecision.classification.status;
  $('#entry-classification').textContent = status === 'manual' ? '手動確認 · 重新載入、AI 整理與同步會保留此選擇' : status === 'verified' ? '可靠判斷 · 根據媒體網址結構或已驗證的原始圖片' : '待確認 · 目前證據不足，請確認實際內容後選擇類型';
}

function refreshEditorType(force = false) {
  if (!force && state.editorDecision?.classification.status === 'manual') return;
  if (!force && state.editorUrl === $('#entry-url').value) return;
  state.editorUrl = $('#entry-url').value;
  const current = state.entries.find(entry => entry.id === $('#entry-id').value);
  state.editorDecision = classifyContent({ url: state.editorUrl, validatedImage: current?.classification.evidence === 'validated-image' });
  $('#entry-type').value = state.editorDecision.type; renderEditorType();
}

function confirmEditorType() {
  state.editorDecision = classifyContent({ manualType: $('#entry-type').value });
  renderEditorType();
}

async function saveFromForm(event) {
  event.preventDefault();
  const id = $('#entry-id').value;
  const current = id ? state.entries.find(entry => entry.id === id) : null;
  if (id && (!current || JSON.stringify(current) !== state.editorBaseline)) {
    $('#entry-error').textContent = '編輯期間收藏已被同步或其他操作更新。請重新開啟收藏，以免覆寫較新的資料。';
    $('#entry-error').hidden = false; toast($('#entry-error').textContent, 7000); return;
  }
  let entry;
  try {
    refreshEditorType();
    const fields = { title: $('#entry-title').value, note: $('#entry-note').value, ...state.editorDecision, webpageKind: $('#entry-webpage-kind').value, status: $('#entry-status').value, tags: inputTags($('#entry-tags').value, current?.tags), starred: $('#entry-starred').checked, previewUrl: $('#entry-preview-url').value };
    if (current?.kind === 'image') entry = validatedEntry({ ...current, ...fields, updatedAt: new Date().toISOString() });
    else {
      const url = normalizeUrl($('#entry-url').value);
      const duplicate = state.entries.find(item => item.normalizedUrl === url && item.id !== id);
      if (duplicate) throw new Error('這個網址已收藏過，請直接編輯原有收藏');
      entry = current ? validatedEntry({ ...current, ...fields, url, normalizedUrl: url, originalUrl: $('#entry-url').value, updatedAt: new Date().toISOString() }) : createEntry({ ...fields, url, originalUrl: $('#entry-url').value });
    }
  } catch (error) { $('#entry-error').textContent = error.message; $('#entry-error').hidden = false; $('#entry-error').focus(); toast(error.message); return; }
  const next = current ? state.entries.map(item => item.id === id ? entry : item) : [entry, ...state.entries];
  $('#save-button').disabled = true;
  try { if (await persistEntries(next, current ? '收藏已更新 ✓' : '已收入 Pocket Archive ✓')) closeDialog('entry-dialog'); }
  finally { $('#save-button').disabled = false; }
}

async function updateEntries(ids, updater, message) {
  const selected = new Set(ids); const now = new Date().toISOString();
  const next = state.entries.map(entry => selected.has(entry.id) ? validatedEntry({ ...updater(entry), updatedAt: now }) : entry);
  return persistEntries(next, message);
}

async function deleteEntry(id) {
  const entry = state.entries.find(item => item.id === id); if (!entry) return;
  if (!confirm(`確定永久刪除「${entry.title}」及其本機附件？請先確認已有備份。`)) return;
  try {
    if (!await persistEntries(state.entries.filter(item => item.id !== id))) return;
    state.selected.delete(id); render(); toast('已刪除收藏；同步時會保留刪除紀錄');
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
  const entries = state.batch.filter(row => row.status === 'valid').map(row => createEntry({ url: row.normalizedUrl, originalUrl: row.input }));
  try { if (await persistEntries([...entries, ...state.entries])) { closeDialog('batch-dialog'); toast(`已加入 ${entries.length} 筆，錯誤與重複項目已略過 ✓`); } }
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
  let saved = 0; const failures = []; const added = []; const blobs = new Map();
  for (const item of valid) {
    try {
      const entry = createImageEntry(item.file, item.hash); entry.attachment = { ...entry.attachment, ...await imageDimensions(item.file) }; blobs.set(entry.attachment.id, item.file); added.unshift(entry); saved += 1;
    } catch (error) { failures.push(`${item.file.name}: ${error.message}`); }
  }
  if (added.length && !await persistEntries([...added, ...state.entries], '', blobs)) return;
  else if (!added.length) render();
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

async function exportMigrationPackage() {
  try {
    let migrationEntries = state.entries; let migrationJournal = state.syncJournal;
    if (migrationEntries.some(entry => !entry.sync)) {
      const bootstrap = recordLocalChanges(migrationEntries.filter(entry => entry.sync), migrationEntries, { deviceId: state.deviceId, journal: state.syncJournal, tombstones: state.tombstones });
      migrationEntries = bootstrap.entries; migrationJournal = bootstrap.journal;
    }
    const envelope = createBackupEnvelope(migrationEntries); const backupJson = JSON.stringify(envelope, null, 2);
    const [exportIds, cloudJobs, driveWorkspace] = await Promise.all([
      state.repository.getMeta('ai-export-ids', []), state.repository.getMeta('cloud-ai-jobs', []), state.repository.getMeta('drive-workspace', {})
    ]);
    const migration = createMigrationManifest({
      backupSha256: await sha256(new TextEncoder().encode(backupJson)), sourceOrigin: location.origin, sourceDeviceId: state.deviceId,
      syncJournal: migrationJournal, tombstones: state.tombstones, exportIds, cloudJobs, driveWorkspace
    });
    const files = [{ name: 'backup.json', data: backupJson }, { name: 'migration.json', data: JSON.stringify(migration, null, 2) }];
    for (const entry of migrationEntries.filter(item => item.attachment)) {
      const blob = await state.repository.getAttachment(entry.attachment.id);
      if (!blob) throw new Error(`附件遺失：${entry.attachment.name}。遷移已停止，原站資料未變更。`);
      if (await sha256(blob) !== entry.attachment.hash) throw new Error(`附件 SHA-256 不符：${entry.attachment.name}。遷移已停止。`);
      files.push({ name: entry.attachment.path, data: blob });
    }
    const date = new Date().toISOString().slice(0, 10); download(await createZip(files), `pocket-archive-migration-${date}.zip`);
    $('#migration-status').textContent = `已建立 ${state.entries.length} 筆、${files.length - 2} 個附件的遷移 ZIP。舊站資料未刪除。`;
    toast('遷移 ZIP 已下載；請保留舊站並在新網址先做匯入預覽 ✓');
  } catch (error) { $('#migration-status').textContent = `遷移匯出失敗：${error.message}`; toast(`遷移匯出失敗：${error.message}`, 8000); }
}

async function inspectBackup(file) {
  if (file.size > 300 * 1024 * 1024) throw new Error('備份檔不可超過 300 MB');
  let parsed; const blobs = new Map();
  if (file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip') {
    const files = await readZip(file); const manifest = files.get('backup.json');
    if (!manifest) throw new Error('ZIP 根目錄缺少 backup.json');
    parsed = readBackup(decodeText(manifest));
    const expected = new Set(['backup.json']);
    let migration = null; const migrationBytes = files.get('migration.json');
    if (migrationBytes) {
      if (migrationBytes.length > 5 * 1024 * 1024) throw new Error('migration.json 超過 5 MB');
      migration = readMigrationManifest(decodeText(migrationBytes)); expected.add('migration.json');
      if (await sha256(manifest) !== migration.backupSha256) throw new Error('遷移 manifest 與 backup.json 的 SHA-256 不符');
    }
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
    const preview = previewMerge(state.entries, parsed.entries);
    return { parsed, blobs, preview, migration };
  } else {
    parsed = readBackup(await file.text());
    if (parsed.entries.some(entry => entry.attachment)) throw new Error('此 JSON 有附件清單但沒有圖片；請選擇完整 ZIP 備份');
  }
  const preview = previewMerge(state.entries, parsed.entries);
  return { parsed, blobs, preview, migration: null };
}

async function importBackupFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try {
    state.pendingImport = await inspectBackup(file); const { add, skip, conflicts } = state.pendingImport.preview;
    const migrationNote = state.pendingImport.migration ? `<p><strong>已驗證跨來源遷移：</strong>${escapeHtml(state.pendingImport.migration.sourceOrigin)} · ${Object.keys(state.pendingImport.migration.tombstones).length} 筆 tombstone。將保留新網址的 device ID；同 ID 差異會依因果時鐘套用或進入衝突面板，不會盲目覆寫。</p>` : '<p>此操作不會覆寫或刪除現有收藏。</p>';
    $('#confirm-content').innerHTML = `<p class="preview-summary"><strong>${add.length} 筆將合併</strong> · ${skip.length} 筆重複略過 · ${conflicts.length} 筆 ID 衝突略過</p>${migrationNote}${conflicts.length ? `<ul class="preview-list">${conflicts.slice(0, 20).map(item => `<li data-status="invalid"><b>衝突</b><span>${escapeHtml(item.entry.title)}</span></li>`).join('')}</ul>` : ''}`;
    $('#confirm-import').disabled = add.length === 0 && !state.pendingImport.migration; openDialog('confirm-dialog');
  } catch (error) { toast(`匯入失敗：${error.message}`, 7500); }
}

async function confirmImport() {
  if (!state.pendingImport) return;
  const entries = state.pendingImport.preview.add; const needed = new Map();
  const attachmentEntries = state.pendingImport.migration ? state.pendingImport.parsed.entries : entries;
  attachmentEntries.filter(entry => entry.attachment && state.pendingImport.blobs.has(entry.attachment.id)).forEach(entry => needed.set(entry.attachment.id, state.pendingImport.blobs.get(entry.attachment.id)));
  try {
    if (state.pendingImport.migration) {
      const migration = state.pendingImport.migration; const combined = [...entries, ...state.entries];
      const local = recordLocalChanges(state.entries, combined, { deviceId: state.deviceId, journal: state.syncJournal, tombstones: state.tombstones });
      const allowedRemoteIds = new Set([
        ...entries.map(entry => entry.id),
        ...state.pendingImport.preview.conflicts.map(item => item.entry.id),
        ...state.pendingImport.preview.skip.filter(item => item.reason === 'same-id').map(item => item.entry.id)
      ]);
      const remoteEntries = state.pendingImport.parsed.entries.filter(entry => allowedRemoteIds.has(entry.id)).map(entry => replicaRecord(entry, null)).filter(Boolean);
      const reconciled = reconcileReplica(local.entries, local.tombstones, [...remoteEntries, ...Object.values(migration.tombstones)], local.journal);
      const nextJournal = {};
      for (const entry of reconciled.entries) { const record = replicaRecord(entry, null); if (record) nextJournal[entry.id] = record; }
      for (const [id, tombstone] of Object.entries(reconciled.tombstones)) { const record = replicaRecord(null, tombstone); if (record) nextJournal[id] = record; }
      const nextConflicts = pruneResolvedConflicts([...state.cloudConflicts, ...reconciled.conflicts], reconciled.entries, reconciled.tombstones).slice(-100);
      const currentIds = await state.repository.getMeta('ai-export-ids', []); const ai = mergeMigrationAi(currentIds, state.cloudJobs, migration);
      const history = await state.repository.getMeta('migration-history', []); const nextHistory = [{ sourceOrigin: migration.sourceOrigin, sourceDeviceId: migration.sourceDeviceId, importedAt: new Date().toISOString(), entryCount: entries.length, tombstoneCount: Object.keys(migration.tombstones).length }, ...history].slice(0, 20);
      const retained = new Set(reconciled.entries.map(entry => entry.id)); const deleteAttachmentIds = state.entries.filter(entry => !retained.has(entry.id)).map(entry => entry.attachment?.id).filter(Boolean);
      const meta = { 'sync-journal': nextJournal, 'sync-tombstones': reconciled.tombstones, 'sync-conflicts': nextConflicts, 'ai-export-ids': ai.exportIds, 'cloud-ai-jobs': ai.cloudJobs, 'migration-history': nextHistory, 'cloud-dirty': true };
      if (Object.keys(migration.driveWorkspace).length) meta['drive-workspace'] = migration.driveWorkspace;
      state.entries = await state.repository.replaceBundle(reconciled.entries, needed, { deleteAttachmentIds, meta, expectedRevision: state.dataRevision });
      state.dataRevision = state.entries.dataRevision;
      state.syncJournal = nextJournal; state.tombstones = reconciled.tombstones; state.cloudConflicts = nextConflicts; state.cloudJobs = ai.cloudJobs;
      const imported = entries.length; state.pendingImport = null; render(); renderCloudStatus(); closeDialog('confirm-dialog'); scheduleAutoBackup(); scheduleAutoSync();
      toast(`跨來源遷移完成：新增 ${imported} 筆、保留 ${Object.keys(reconciled.tombstones).length} 筆刪除紀錄${nextConflicts.length ? `，${nextConflicts.length} 筆衝突待確認` : ''} ✓`, 8500);
      return;
    }
    if (!await persistEntries([...entries, ...state.entries], '', needed)) return;
    state.pendingImport = null; render(); closeDialog('confirm-dialog'); toast(`已安全合併 ${entries.length} 筆收藏 ✓`);
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
    showSuggestionPreview(readOrganized(await file.text(), { exportIds, entries: state.entries }));
  } catch (error) { toast(`分類結果拒絕匯入：${error.message}`, 7500); }
}

function showSuggestionPreview(result) {
  state.pendingSuggestions = result;
  const byId = new Map(state.entries.map(entry => [entry.id, entry]));
  const { accepted, rejected } = result;
  $('#ai-preview').innerHTML = `<p class="preview-summary"><strong>${accepted.length} 筆可預覽</strong> · ${rejected.length} 筆拒絕</p><p>只合併主題標籤；類型、內容形式與舊分類保留。沒有內容證據的建議不會預設勾選。</p><ul class="suggestion-list">${accepted.map(item => {
    const entry = byId.get(item.id);
    const merged = mergeTopicTags(entry.tags, [...item.categories, ...item.tags]);
    const added = merged.tags.filter(tag => !entry.tags.includes(tag));
    const evidence = item.evidence;
    const verified = ['content_read', 'image_read'].includes(evidence.status);
    const defaultChecked = verified && item.analysisStatus === 'completed' ? ' checked' : '';
    const evidenceText = contentEvidenceLabel(evidence.status);
    const sourceText = evidence.excerpt ? `<small>Codex 提供的內容證據：${escapeHtml(evidence.excerpt.slice(0, 400))}</small>` : '';
    return `<li><label><input type="checkbox" data-suggestion-id="${escapeHtml(item.id)}"${defaultChecked} /><span><b>${escapeHtml(entry.title)}</b><small>現有標籤：${escapeHtml(entry.tags.join('、') || '無')} → 新增：${escapeHtml(added.join('、') || '無')} · ${item.analysisStatus === 'insufficient_data' ? '資料不足' : '已分析'} · 信心 ${escapeHtml(item.confidence)}</small><small>${escapeHtml(evidenceText)}（證據由 Codex 回報，App 不會自行重新爬取驗證）</small>${sourceText}${merged.pending.length ? `<small class="error-note">超過上限，保留於 AI 建議、不加入標籤：${escapeHtml(merged.pending.join('、'))}</small>` : ''}<em>${escapeHtml(item.summary || item.reason || '無摘要')}</em></span></label></li>`;
  }).join('')}</ul>${rejected.length ? `<p class="error-note">${rejected.length} 筆因未知 ID 或欄位錯誤不會套用。</p>` : ''}`;
  $('#apply-ai').hidden = accepted.length === 0;
}

async function applyOrganized() {
  if (!state.pendingSuggestions) return;
  const selectedIds = $$('[data-suggestion-id]:checked').map(input => input.dataset.suggestionId);
  if (!selectedIds.length) { toast('請至少勾選一筆建議'); return; }
  const result = applySuggestions(state.entries, state.pendingSuggestions.accepted, selectedIds);
  try {
    await state.repository.setMeta('ai-undo-snapshot', { entries: result.snapshot, at: new Date().toISOString() });
    if (!await persistEntries(result.entries)) return;
    const readyJob = state.cloudJobs.find(job => job.exportId === state.pendingSuggestions.sourceExportId && job.status === 'ready');
    if (readyJob) { readyJob.status = 'applied'; await state.repository.setMeta('cloud-ai-jobs', state.cloudJobs); }
    state.pendingSuggestions = null; render(); $('#ai-preview').innerHTML = ''; $('#apply-ai').hidden = true; closeDialog('ai-dialog'); toast(`已套用 ${result.applied} 筆；可從備份視窗單次復原 ✓`);
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
  const social = identifySocialMediaUrl(url);
  if (social) {
    // Only an explicit provider oEmbed request can read this media URL. Never
    // silently fall back to an HTML fetch blocked by YouTube/TikTok CORS.
    if (!state.backendAvailable || !state.backendSession) {
      try {
        const detected = await state.backend?.detectSession();
        state.backendAvailable = Boolean(detected?.available);
        state.backendSession = detected?.session || null;
      } catch (error) {
        $('#entry-metadata-status').textContent = `無法確認 Pocket Archive 登入狀態：${error.message}；仍可手動收藏網址。`;
        return;
      }
    }
    if (!state.backendAvailable) {
      $('#entry-metadata-status').textContent = '目前無法連線至 Pocket Archive 影片資訊讀取服務。請確認使用 Cloudflare 正式網站及網路連線；仍可手動收藏。';
      return;
    }
    if (!state.backendSession) {
      $('#entry-metadata-status').textContent = '讀取公開影片資訊前，請先在 Google Drive 設定登入 Pocket Archive；仍可手動收藏。';
      return;
    }
    const editorId = $('#entry-id').value;
    $('#entry-metadata-status').textContent = '正在向公開影片平台讀取標題與作者…';
    $('#fetch-title').disabled = true;
    try {
      const { metadata } = await state.backend.readSocialMetadata(url);
      // An editor may have closed, changed records, or pasted a different URL meanwhile.
      if (!$('#entry-dialog').open || editorId !== $('#entry-id').value ||
          normalizeUrl($('#entry-url').value) !== url) return;
      $('#entry-title').value = metadata.title;
      if (metadata.thumbnailUrl) $('#entry-preview-url').value = metadata.thumbnailUrl;
      const provider = metadata.provider === 'youtube' ? 'YouTube' : 'TikTok';
      $('#entry-metadata-status').textContent =
        `已讀取 ${provider} 公開資料：標題${metadata.author ? `、作者（${metadata.author}）` : ''}。未讀取影片正文、字幕或畫面；儲存前請確認標題。`;
      toast('已取得公開影片標題；未讀取影片內容或字幕');
    } catch (error) {
      if ($('#entry-dialog').open && editorId === $('#entry-id').value) {
        $('#entry-metadata-status').textContent = error.message || '公開資訊讀取失敗；仍可手動收藏。';
      }
    } finally { $('#fetch-title').disabled = false; }
    return;
  }
  const socialPlatform = identifySocialPlatform(url);
  if (socialPlatform) {
    $('#entry-metadata-status').textContent = `${socialPlatform} 這種網址目前不支援公開資料讀取；可以直接儲存連結並手動填寫標題。尚未擷取貼文正文。`;
    return;
  }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = (await response.text()).slice(0, 2_000_000); const documentHtml = new DOMParser().parseFromString(text, 'text/html');
    if ($('#entry-url').value.trim() !== url && normalizeUrl($('#entry-url').value) !== url) return;
    const title = documentHtml.querySelector('meta[property="og:title"]')?.content || documentHtml.title;
    if (title?.trim()) $('#entry-title').value = title.trim().slice(0, 160);
    if (state.editorDecision.classification.status !== 'manual' && (!response.url || response.url === url)) {
      const ogType = documentHtml.querySelector('meta[property="og:type"]')?.content;
      // Multiple primary media declarations are ambiguous (carousel/mixed).
      const media = [...documentHtml.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:image"]')];
      const urls = [...new Set(media.filter(node => ogType === 'image' ? node.getAttribute('property') === 'og:image' : node.getAttribute('property').startsWith('og:video')).map(node => node.content))];
      state.editorDecision = classifyContent({ url, metadata: { pageUrl: url, ogType, mediaUrl: urls[0], mixed: urls.length !== 1 } });
      $('#entry-type').value = state.editorDecision.type; renderEditorType();
    }
    toast(title?.trim() ? '已讀取公開頁面標題；請確認內容形式' : '沒有可讀標題；仍可保存網址');
    const image = documentHtml.querySelector('meta[property="og:image"]')?.content;
    if (image) { try { $('#entry-preview-url').value = normalizeUrl(new URL(image, url).href); } catch { /* invalid preview URL */ } }
  } catch { toast('網站未允許跨來源讀取；仍可保存網址並手動填寫標題'); }
  finally { clearTimeout(timeout); }
}

async function readClipboardToBatch() {
  try { const text = await navigator.clipboard.readText(); $('#batch-text').value = text; openDialog('batch-dialog'); previewBatch(); }
  catch { openDialog('batch-dialog'); toast('剪貼簿無法讀取，請長按輸入框貼上'); }
}

function cloudConnected() { return Boolean(state.drive && state.workspace && ((state.backendSession && !state.backendSession.reauthRequired) || state.auth?.status().connected)); }

function renderCloudStatus() {
  const connected = cloudConnected();
  const status = $('#cloud-status'); if (!status) return;
  const lastSync = state.cloudSettings.lastSyncAt ? new Date(state.cloudSettings.lastSyncAt).toLocaleString('zh-TW') : '尚未同步';
  const lastBackup = state.cloudSettings.lastBackupAt ? new Date(state.cloudSettings.lastBackupAt).toLocaleString('zh-TW') : '尚未備份';
  status.className = `cloud-status ${connected ? 'is-connected' : ''}`;
  status.innerHTML = connected
    ? `<strong>已連結 ${escapeHtml(state.cloudUser?.emailAddress || 'Google Drive')}</strong><span>最近同步：${escapeHtml(lastSync)} · 最近備份：${escapeHtml(lastBackup)}</span>`
    : `<strong>${state.backendSession ? 'Google Drive 需要重新驗證' : state.backendAvailable ? '尚未登入 Google Drive' : '尚未連結 Google Drive'}</strong><span>本機收藏仍可完整使用；不會假裝已同步。</span>`;
  const connectButton = $('#cloud-connect'); connectButton.hidden = connected; connectButton.disabled = !connected && (state.cloudBusy || (!state.backendAvailable && state.googleIdentityStatus === 'loading'));
  if (state.backendAvailable && state.backendOwner && !state.backendOwner.configured) connectButton.disabled = true;
  connectButton.textContent = state.backendAvailable ? '登入並連結 Google Drive' : state.googleIdentityStatus === 'loading' ? '正在準備 Google 登入…' : '連結 Google Drive';
  $('#cloud-disconnect').hidden = !connected;
  $('#cloud-revoke-grant').hidden = !(connected && state.backendAvailable);
  $('#legacy-google-settings').hidden = state.backendAvailable;
  $('#device-sessions-section').hidden = !state.backendAvailable || !state.backendSession;
  $('#shortcut-section').hidden = !state.backendAvailable || !state.backendSession;
  const ownerSetup = $('#owner-bootstrap-section');
  if (ownerSetup) {
    ownerSetup.hidden = !state.backendAvailable || !state.backendOwner || state.backendOwner.configured;
    const note = $('#owner-bootstrap-note');
    const button = $('#owner-bootstrap');
    if (!ownerSetup.hidden) {
      button.hidden = !state.backendOwner.bootstrapAvailable;
      $('#owner-bootstrap-token-row').hidden = !state.backendOwner.bootstrapAvailable;
      note.textContent = state.backendOwner.bootstrapAvailable
        ? '輸入部署時設定的一次性綁定碼；驗證後會立即前往 Google，並以簽章驗證過的 sub 綁定唯一擁有者。'
        : '登入預設關閉。請先依部署文件設定 OWNER_GOOGLE_SUB，或設定一次性 OWNER_BOOTSTRAP_TOKEN。';
    }
  }
  $$('[data-requires-cloud]').forEach(button => { button.disabled = !connected || state.cloudBusy; });
  $('#cloud-passphrase-row').hidden = !$('#cloud-encryption')?.checked;
  renderConflicts();
}

function renderConflicts() {
  const panel = $('#sync-conflicts'); if (!panel) return;
  if (!state.cloudConflicts.length) { panel.innerHTML = '<p class="privacy-note">目前沒有待處理的同步衝突。</p>'; return; }
  panel.innerHTML = `<p class="error-note">${state.cloudConflicts.length} 筆同時修改已保留。系統先採用不刪資料的決定，你可選擇版本。</p><ul class="preview-list">${state.cloudConflicts.slice(0, 30).map((conflict, index) => {
    const localTitle = conflict.local.entry?.title || (conflict.local.operation === 'delete' ? '刪除' : conflict.itemId);
    const remoteTitle = conflict.remote.entry?.title || (conflict.remote.operation === 'delete' ? '刪除' : conflict.itemId);
    return `<li><b>衝突</b><span>${escapeHtml(localTitle)} ↔ ${escapeHtml(remoteTitle)}<span class="conflict-actions"><button type="button" data-conflict-index="${index}" data-conflict-choice="local">保留本機側</button><button type="button" data-conflict-index="${index}" data-conflict-choice="remote">採用另一裝置</button></span></span></li>`;
  }).join('')}</ul>`;
}

function cloudSettingsFromForm() {
  const clientId = $('#google-client-id').value.trim();
  const settings = {
    ...state.cloudSettings, clientId,
    autoBackup: $('#cloud-auto-backup').checked,
    retention: Math.max(1, Math.min(30, Number($('#cloud-retention').value) || 5)),
    encryption: $('#cloud-encryption').checked
  };
  state.cloudSettings = settings; state.cloudPassphrase = $('#cloud-passphrase').value;
  return settings;
}

async function saveCloudSettingsFromForm() {
  const settings = cloudSettingsFromForm();
  await state.repository.setMeta('cloud-settings', settings);
  return settings;
}

function prepareGoogleAuth(clientId = $('#google-client-id')?.value.trim() || state.cloudSettings.clientId) {
  if (!isValidGoogleClientId(clientId) || !globalThis.google?.accounts?.oauth2) return null;
  if (!state.auth || state.auth.clientId !== clientId) state.auth = new GoogleAuthSession({ clientId, googleObject: globalThis.google });
  else state.auth.prepare(globalThis.google);
  return state.auth;
}

function preloadGoogleIdentity() {
  if (state.googleIdentityStatus === 'ready') {
    prepareGoogleAuth();
    return Promise.resolve(globalThis.google);
  }
  if (state.googleIdentityStatus === 'loading' && state.googleIdentityPromise) return state.googleIdentityPromise;
  state.googleIdentityStatus = 'loading'; renderCloudStatus();
  const loading = loadGoogleIdentity().then(googleObject => {
    state.googleIdentityStatus = 'ready';
    prepareGoogleAuth();
    renderCloudStatus();
    return googleObject;
  }).catch(error => {
    state.googleIdentityStatus = 'error'; state.googleIdentityPromise = null;
    renderCloudStatus();
    throw error;
  });
  state.googleIdentityPromise = loading;
  loading.catch(() => { /* connect button retries and reports the actionable error */ });
  return loading;
}

function connectDrive() {
  if (state.backendAvailable) {
    state.backend.beginAuthorization(`${location.pathname}${location.search}`);
    return;
  }
  let authorization; let settingsSaved; let auth;
  try {
    const settings = cloudSettingsFromForm();
    if (!isValidGoogleClientId(state.cloudSettings.clientId)) throw new Error('請先填入 Google OAuth Web Client ID');
    auth = prepareGoogleAuth(state.cloudSettings.clientId);
    if (!auth) {
      preloadGoogleIdentity();
      throw new Error('Google 登入元件仍在載入，請稍候後再點一次連結');
    }
    state.cloudBusy = true; renderCloudStatus();
    // requestAccessToken runs synchronously here, in the trusted click handler.
    authorization = auth.connect({ prompt: 'consent' });
    settingsSaved = state.repository.setMeta('cloud-settings', settings);
  } catch (error) {
    state.cloudBusy = false; renderCloudStatus(); toast(error.message, 8000);
    return;
  }
  void completeDriveConnection(auth, authorization, settingsSaved);
}

async function bootstrapBackendOwner() {
  const tokenInput = $('#owner-bootstrap-token'); const token = tokenInput.value;
  if (!token) { toast('請輸入一次性擁有者綁定碼'); return; }
  state.cloudBusy = true; renderCloudStatus();
  try {
    const result = await state.backend.bootstrapOwner(token); tokenInput.value = '';
    state.backendOwner = { ...state.backendOwner, bootstrapReady: Boolean(result.ready) };
    state.backend.beginAuthorization(`${location.pathname}${location.search}`);
  } catch (error) { tokenInput.value = ''; toast(error.message, 8500); }
  finally { state.cloudBusy = false; renderCloudStatus(); }
}

async function completeDriveConnection(auth, authorization, settingsSaved) {
  try {
    await Promise.all([authorization, settingsSaved]);
    state.auth = auth;
    state.drive = new DriveApi({ getAccessToken: () => auth.getAccessToken() });
    state.workspace = await state.drive.ensureWorkspace();
    state.backupService = new CloudBackupService(state.drive, state.workspace);
    state.aiExchange = new CloudAiExchange(state.drive, state.workspace);
    state.syncService = new CloudSyncService(state.drive, state.workspace);
    state.cloudUser = (await state.drive.aboutUser()).user || null;
    await state.repository.setMeta('drive-workspace', state.workspace);
    toast('Google Drive 已連結；Token 僅保留在本次頁面記憶體');
    await refreshCloudBackups(); scheduleAutoBackup(800); scheduleAutoSync(1600);
  } catch (error) {
    auth.clear(); state.drive = null; state.workspace = null;
    toast(error.message, 8000);
  } finally { state.cloudBusy = false; renderCloudStatus(); }
}

async function disconnectDrive() {
  if (state.backendAvailable && state.backendSession) {
    try { await state.backend.logout(); } catch (error) { toast(error.message, 8000); return; }
    state.backendSession = null;
  } else {
  try { await state.auth?.disconnect(); } catch { /* local disconnect still succeeds */ }
  }
  clearTimeout(state.backupTimer); clearTimeout(state.syncTimer); state.auth = null; state.drive = null; state.workspace = null;
  state.backupService = null; state.aiExchange = null; state.syncService = null; state.cloudUser = null;
  renderCloudStatus(); toast('已中斷 Google Drive；本機收藏完整保留');
}

async function revokeCloudGrant() {
  if (!state.backendSession || !confirm('撤銷 Google Drive 授權並登出所有網頁裝置？本機收藏不會刪除；iPhone 捷徑憑證仍需在下方單獨撤銷。')) return;
  try {
    await state.backend.revokeGrant(); state.backendSession = null; state.backendSessions = [];
    state.drive = null; state.workspace = null; state.backupService = null; state.aiExchange = null; state.syncService = null; state.cloudUser = null;
    renderCloudStatus(); toast('已撤銷 Google 授權與所有網頁工作階段；iPhone 捷徑憑證未變更，本機收藏完整保留');
  } catch (error) { toast(`撤銷失敗：${error.message}`, 8000); }
}

async function refreshBackendSessions() {
  if (!state.backendSession) return;
  try {
    const result = await state.backend.listSessions(); state.backendSessions = result.sessions || [];
    $('#device-sessions').innerHTML = state.backendSessions.length ? `<ul class="preview-list">${state.backendSessions.map(session => `<li><b>${escapeHtml(session.deviceName)}</b><span>${escapeHtml(new Date(session.lastSeenAt).toLocaleString('zh-TW'))}${session.id === result.currentSessionId ? ' · 此裝置' : ''}<button type="button" class="inline-button" data-revoke-session="${escapeHtml(session.id)}">撤銷</button></span></li>`).join('')}</ul>` : '<p class="privacy-note">沒有有效裝置工作階段。</p>';
  } catch (error) { $('#device-sessions').textContent = `無法取得裝置清單：${error.message}`; }
}

async function refreshCaptureCredentials() {
  if (!state.backendSession) return;
  try {
    const result = await state.backend.listCaptureCredentials(); state.captureCredentials = result.credentials || [];
    $('#shortcut-credentials').innerHTML = state.captureCredentials.length ? `<ul class="preview-list">${state.captureCredentials.map(item => `<li><b>${escapeHtml(item.name)}</b><span>${item.revoked ? '已撤銷' : new Date(item.expiresAt).getTime() <= Date.now() ? '已到期' : `到期：${escapeHtml(new Date(item.expiresAt).toLocaleDateString('zh-TW'))}`}${!item.revoked ? `<button type="button" class="inline-button" data-revoke-capture="${escapeHtml(item.id)}">撤銷</button>` : ''}</span></li>`).join('')}</ul>` : '<p class="privacy-note">尚未建立快捷收藏憑證。</p>';
  } catch (error) { $('#shortcut-credentials').textContent = `無法取得快捷憑證：${error.message}`; }
}

async function createCaptureCredential() {
  const name = $('#shortcut-device-name').value.trim() || '我的 iPhone';
  try {
    const result = await state.backend.createCaptureCredential(name, 180);
    $('#shortcut-token').value = result.token; $('#shortcut-token-once').hidden = false;
    await refreshCaptureCredentials(); toast('已建立只能新增收件工作的捷徑憑證；請立即安全地放入捷徑');
  } catch (error) { toast(`建立捷徑憑證失敗：${error.message}`, 8000); }
}

async function importCaptureJobs() {
  if (!state.backendSession || state.captureBusy) return;
  if (state.cloudBusy || state.localWriteBusy) { setTimeout(importCaptureJobs, 1500); return; }
  state.captureBusy = true; state.cloudBusy = true; let saved = 0; let duplicates = 0;
  try {
    // Claim one at a time so large/multiple images do not spend their lease waiting.
    for (let index = 0; index < 20; index++) {
      const response = await state.backend.claimCaptureJobs(1); const job = response.jobs?.[0]; if (!job) break;
      try {
        const result = await receiveCaptureJob(job, state.backend, state.repository, state.deviceId);
        if (result === 'saved') saved++; else duplicates++;
      } catch (error) {
        await state.backend.retryCaptureJob(job.id, 'local_receive_failed', job.attemptCount).catch(() => {});
        throw error;
      } finally {
        const snapshot = await state.repository.readSyncSnapshot();
          state.entries = snapshot.entries; state.syncJournal = snapshot.journal; state.tombstones = snapshot.tombstones; state.dataRevision = snapshot.revision; render();
      }
    }
    if (saved || duplicates) toast(`快速收件已入庫 ${saved} 筆；${duplicates} 筆重複。Drive 同步將接續執行。`);
  } catch (error) { $('#cloud-backup-note').textContent = `快速收件待重試：${error.message}`; }
  finally { state.captureBusy = false; state.cloudBusy = false; scheduleAutoBackup(); scheduleAutoSync(700); renderCloudStatus(); }
}

async function restoreBackendSession() {
  state.backend = new PocketBackendClient();
  try {
    state.backendOwner = await state.backend.ownerStatus(); state.backendAvailable = true;
  } catch (error) {
    if (error.code !== 'backend_unavailable' && !(error instanceof TypeError)) throw error;
    state.backendAvailable = false; state.backendOwner = null;
    $('#migration-banner').hidden = false;
    if (isValidGoogleClientId(state.cloudSettings.clientId)) preloadGoogleIdentity();
    return;
  }
  $('#migration-banner').hidden = true;
  if (!state.backendOwner.configured) { state.backendSession = null; renderCloudStatus(); return; }
  const detected = await state.backend.detectSession(); state.backendAvailable = detected.available; state.backendSession = detected.session;
  if (!detected.session) { renderCloudStatus(); return; }
  state.cloudUser = { emailAddress: detected.session.user?.email, displayName: detected.session.user?.displayName };
  state.drive = new BackendDriveApi(state.backend);
  try {
    state.workspace = await state.drive.ensureWorkspace(); state.backupService = new CloudBackupService(state.drive, state.workspace); state.aiExchange = new CloudAiExchange(state.drive, state.workspace); state.syncService = new CloudSyncService(state.drive, state.workspace);
    await state.repository.setMeta('drive-workspace', state.workspace); scheduleAutoBackup(900); scheduleAutoSync(1500);
  } catch (error) { state.drive = null; state.workspace = null; $('#cloud-backup-note').textContent = `Drive 授權需處理：${error.message}`; }
  await Promise.all([refreshBackendSessions(), refreshCaptureCredentials()]); renderCloudStatus(); await importCaptureJobs();
  if (cloudConnected() && state.cloudJobs.some(job => job.status !== 'applied')) setTimeout(() => checkCloudAi(), 2600);
}

function scheduleAutoBackup(delayMs = 6000) {
  clearTimeout(state.backupTimer);
  if (!cloudConnected() || !state.cloudSettings.autoBackup) return;
  state.backupTimer = setTimeout(() => runCloudBackup(true), delayMs);
}

function scheduleAutoSync(delayMs = 9000) {
  clearTimeout(state.syncTimer);
  if (!cloudConnected()) return;
  state.syncTimer = setTimeout(() => syncNow(true), delayMs);
}

async function runCloudBackup(automatic = false) {
  if (!cloudConnected() || state.cloudBusy) return;
  if (state.cloudSettings.encryption && !state.cloudPassphrase) {
    $('#cloud-backup-note').textContent = '自動備份等待解鎖：加密密碼不會永久儲存，請在本次工作階段重新輸入。';
    if (!automatic) toast('請輸入加密密碼後再備份');
    return;
  }
  state.cloudBusy = true; renderCloudStatus();
  try {
    const file = await state.backupService.create(state.entries, state.repository, {
      retention: state.cloudSettings.retention,
      passphrase: state.cloudSettings.encryption ? state.cloudPassphrase : ''
    });
    state.cloudSettings.lastBackupAt = new Date().toISOString();
    await Promise.all([state.repository.setMeta('cloud-settings', state.cloudSettings), state.repository.setMeta('cloud-dirty', false)]);
    $('#cloud-backup-note').textContent = `備份成功：${file.filename} · ${friendlyBytes(Number(file.size))} · 完整性已驗證`;
    await refreshCloudBackups(); if (!automatic) toast('Google Drive 完整備份成功 ✓');
  } catch (error) {
    $('#cloud-backup-note').textContent = `備份失敗：${error.message}`;
    if (!automatic) toast(`雲端備份失敗：${error.message}`, 8000);
  } finally { state.cloudBusy = false; renderCloudStatus(); if (cloudConnected()) scheduleAutoSync(700); }
}

async function refreshCloudBackups() {
  if (!cloudConnected()) return;
  try {
    state.cloudBackups = await state.backupService.list();
    $('#cloud-backup-list').innerHTML = state.cloudBackups.length ? `<ul class="preview-list">${state.cloudBackups.map((file, index) => `<li><b>${file.appProperties?.encrypted === 'true' ? '已加密' : '備份'}</b><span>${escapeHtml(new Date(file.createdTime).toLocaleString('zh-TW'))} · ${friendlyBytes(Number(file.size))}<button type="button" class="inline-button" data-cloud-restore="${index}">預覽還原</button></span></li>`).join('')}</ul>` : '<p class="privacy-note">還沒有雲端備份。</p>';
  } catch (error) { $('#cloud-backup-list').textContent = `無法取得備份清單：${error.message}`; }
}

async function previewCloudRestore(index) {
  const file = state.cloudBackups[index]; if (!file) return;
  state.cloudBusy = true; renderCloudStatus();
  try {
    const downloaded = await state.backupService.download(file, state.cloudPassphrase);
    const backupFile = new File([downloaded.blob], downloaded.filename, { type: downloaded.blob.type });
    state.pendingImport = await inspectBackup(backupFile);
    const { add, skip, conflicts } = state.pendingImport.preview;
    $('#confirm-content').innerHTML = `<p class="preview-summary"><strong>${add.length} 筆將合併</strong> · ${skip.length} 筆重複略過 · ${conflicts.length} 筆 ID 衝突略過</p><p>已驗證 SHA-256；確認前不會清除或覆寫現有資料。</p>`;
    $('#confirm-import').disabled = add.length === 0; openDialog('confirm-dialog');
  } catch (error) { toast(`雲端還原預覽失敗：${error.message}`, 8000); }
  finally { state.cloudBusy = false; renderCloudStatus(); }
}

async function syncNow(automatic = false) {
  if (!cloudConnected()) return;
  // Editing is allowed while a network request is in flight. Its local commit
  // advances the revision, so this sync must discard its obsolete snapshot.
  if (state.cloudBusy || state.localWriteBusy || (automatic && $('#entry-dialog').open)) {
    if (automatic) scheduleAutoSync(1800);
    return;
  }
  state.cloudBusy = true; renderCloudStatus();
  let retryStale = false;
  try {
    let snapshot = await state.repository.readSyncSnapshot();
    if (snapshot.entries.some(entry => !entry.sync)) {
      const bootstrap = recordLocalChanges(snapshot.entries.filter(entry => entry.sync), snapshot.entries, { deviceId: state.deviceId, journal: snapshot.journal, tombstones: snapshot.tombstones });
      const bootstrapped = await state.repository.replaceBundle(bootstrap.entries, new Map(), {
        expectedRevision: snapshot.revision,
        meta: { 'sync-journal': bootstrap.journal, 'sync-tombstones': bootstrap.tombstones }
      });
      state.entries = bootstrapped; state.dataRevision = bootstrapped.dataRevision;
      state.syncJournal = bootstrap.journal; state.tombstones = bootstrap.tombstones;
      snapshot = await state.repository.readSyncSnapshot();
    }
    const result = await state.syncService.sync({ entries: snapshot.entries, repository: state.repository, deviceId: state.deviceId, journal: snapshot.journal, tombstones: snapshot.tombstones });
    const conflictMap = new Map([...state.cloudConflicts, ...result.conflicts].map(conflict => [`${conflict.itemId}:${JSON.stringify(conflict.local.clock)}:${JSON.stringify(conflict.remote.clock)}`, conflict]));
    const nextConflicts = pruneResolvedConflicts([...conflictMap.values()], result.entries, result.tombstones).slice(-100);
    const nextSettings = { ...state.cloudSettings, lastSyncAt: new Date().toISOString() };
    // Atomic compare-and-commit prevents a stale background sync from replacing
    // edits saved during Drive I/O; it also protects against other tabs.
    const savedEntries = await state.repository.replaceBundle(result.entries, result.attachmentBlobs, {
      expectedRevision: snapshot.revision,
      meta: {
        'sync-journal': result.journal,
        'sync-tombstones': result.tombstones,
        'sync-conflicts': nextConflicts,
        'cloud-settings': nextSettings
      }
    });
    state.entries = savedEntries; state.dataRevision = savedEntries.dataRevision;
    state.syncJournal = result.journal; state.tombstones = result.tombstones;
    state.cloudConflicts = nextConflicts; state.cloudSettings = nextSettings;
    render(); renderCloudStatus(); if (!automatic || result.applied || result.conflicts.length) toast(`同步完成：套用 ${result.applied} 筆，${result.conflicts.length} 筆衝突待確認`);
  } catch (error) {
    if (error instanceof StaleDataError) {
      retryStale = true;
      const latest = await state.repository.readSyncSnapshot();
      state.entries = latest.entries; state.syncJournal = latest.journal;
      state.tombstones = latest.tombstones; state.dataRevision = latest.revision;
      render();
      if (!automatic) toast('同步期間有新的本機編輯，過期結果已安全略過；正在重新安排同步');
    } else if (!automatic) toast(`同步失敗：${error.message}`, 9000);
    else $('#cloud-backup-note').textContent = `自動同步待重試：${error.message}`;
  } finally {
    state.cloudBusy = false; renderCloudStatus();
    if (retryStale && cloudConnected()) scheduleAutoSync(1200);
  }
}

async function handleConflictChoice(index, choice) {
  const conflict = state.cloudConflicts[index]; if (!conflict) return;
  if (!pruneResolvedConflicts([conflict], state.entries, state.tombstones).length) {
    state.cloudConflicts.splice(index, 1);
    await state.repository.setMeta('sync-conflicts', state.cloudConflicts);
    renderCloudStatus(); toast('此衝突已被較新的同步版本解決'); return;
  }
  const current = replicaRecord(state.entries.find(entry => entry.id === conflict.itemId), state.tombstones[conflict.itemId]);
  const resolution = resolveConflict(conflict, choice, state.deviceId, new Date().toISOString(), current);
  let nextEntries = state.entries.filter(entry => entry.id !== conflict.itemId);
  const nextTombstones = { ...state.tombstones };
  if (resolution.entry) {
    nextEntries.unshift(resolution.entry); delete nextTombstones[conflict.itemId];
  } else {
    nextTombstones[conflict.itemId] = resolution.record;
  }
  const nextJournal = { ...state.syncJournal, [conflict.itemId]: resolution.record };
  const nextConflicts = pruneResolvedConflicts(state.cloudConflicts.filter((_, position) => position !== index), nextEntries, nextTombstones);
  const deletedAttachment = !resolution.entry && state.entries.find(entry => entry.id === conflict.itemId)?.attachment?.id;
  const savedEntries = await state.repository.replaceBundle(nextEntries, new Map(), {
    deleteAttachmentIds: deletedAttachment ? [deletedAttachment] : [],
    meta: { 'sync-journal': nextJournal, 'sync-tombstones': nextTombstones, 'sync-conflicts': nextConflicts, 'cloud-dirty': true }
  });
  state.entries = savedEntries; state.dataRevision = savedEntries.dataRevision; state.tombstones = nextTombstones; state.syncJournal = nextJournal; state.cloudConflicts = nextConflicts;
  scheduleAutoBackup(); scheduleAutoSync();
  render(); renderCloudStatus(); toast('衝突選擇已保存，請再次同步傳送結果');
}

async function enqueueCloudAi() {
  if (!cloudConnected() || state.cloudBusy) return;
  const chosen = state.selected.size ? state.entries.filter(entry => state.selected.has(entry.id)) : state.entries.filter(entry => entry.status === 'inbox');
  if (!chosen.length) { toast('沒有可送出的待整理項目'); return; }
  state.cloudBusy = true; renderCloudStatus();
  try {
    const job = await state.aiExchange.enqueue(chosen, state.repository);
    const evidence = await state.aiExchange.launchEvidence({ exportId: job.exportId, inboxFileId: job.inboxFile.id, resultFileId: job.resultFile?.id || job.resultFileId, itemIds: job.itemIds });
    const exportIds = await state.repository.getMeta('ai-export-ids', []);
    if (job.exportId && !exportIds.includes(job.exportId)) await state.repository.setMeta('ai-export-ids', [job.exportId, ...exportIds].slice(0, 50));
    if (!job.duplicate || (job.resultFileId && !state.cloudJobs.some(item => item.exportId === job.exportId))) {
      state.cloudJobs.unshift({ exportId: job.exportId, inboxFileId: job.inboxFile.id, resultFileId: job.resultFile?.id || job.resultFileId, itemIds: job.itemIds, launchEvidence: evidence, createdAt: new Date().toISOString(), status: 'pending' });
      state.cloudJobs = state.cloudJobs.slice(0, 50);
    } else {
      const retainedJob = state.cloudJobs.find(item => item.exportId === job.exportId);
      retainedJob.launchEvidence = evidence; retainedJob.itemIds = job.itemIds;
    }
    await state.repository.setMeta('cloud-ai-jobs', state.cloudJobs);
    $('#ai-cloud-status').textContent = job.duplicate ? '相同批次已存在，未重複建立。請複製此批次指令。' : `已送出 ${chosen.length} 筆。請複製此批次指令到 Codex。`;
    state.activeAiExportId = job.exportId; await state.repository.setMeta('active-ai-export-id', job.exportId);
    $('#codex-launch-command').value = codexLaunchCommand(job.exportId, evidence); $('#codex-launch').hidden = false;
    toast(job.duplicate ? '相同 AI 工作已存在' : '已建立 Drive AI-Inbox 與結果占位檔 ✓');
  } catch (error) { toast(`送到 AI-Inbox 失敗：${error.message}`, 8500); }
  finally { state.cloudBusy = false; renderCloudStatus(); }
}

async function checkCloudAi() {
  if (!cloudConnected() || state.cloudBusy) return;
  let job;
  try { job = cloudAiJobForReview(state.cloudJobs, state.activeAiExportId); } catch (error) { toast(error.message); return; }
  if (job?.status === 'applied') { toast('此批次已套用，未重複處理'); return; }
  if (!job) { toast('沒有由此裝置建立的待檢查 AI 工作'); return; }
  state.cloudBusy = true; renderCloudStatus();
  try {
    const exportIds = await state.repository.getMeta('ai-export-ids', []);
    const checked = await state.aiExchange.readResult(job, state.entries, exportIds);
    if (checked.pending) { $('#ai-cloud-status').textContent = '最新結果仍是待處理占位檔；Codex 完成後再檢查。'; toast('Codex 結果尚未寫回'); return; }
    job.status = 'ready'; await state.repository.setMeta('cloud-ai-jobs', state.cloudJobs);
    showSuggestionPreview(checked.result); $('#ai-cloud-status').textContent = '已取得並驗證雲端結果，請逐項預覽後套用。';
  } catch (error) { toast(`取得 AI 結果失敗：${error.message}`, 8500); }
  finally { state.cloudBusy = false; renderCloudStatus(); }
}

function bindEvents() {
  $('#new-button').addEventListener('click', () => openEditor()); $('#mobile-new').addEventListener('click', () => openEditor()); $('#empty-add').addEventListener('click', () => openEditor());
  $('#batch-button').addEventListener('click', () => { $('#batch-form').reset(); state.batch = []; $('#batch-preview').innerHTML = ''; $('#batch-save').disabled = true; openDialog('batch-dialog'); });
  $('#image-button').addEventListener('click', () => { $('#image-form').reset(); state.images = []; $('#image-preview').innerHTML = ''; $('#image-save').disabled = true; openDialog('image-dialog'); });
  $('#backup-button').addEventListener('click', () => { openDialog('backup-dialog'); updateStorageSummary(); }); $('#ai-button').addEventListener('click', () => { const job = state.cloudJobs.find(item => item.exportId === state.activeAiExportId) || state.cloudJobs.find(item => item.status !== 'applied'); if (job) { state.activeAiExportId = job.exportId; $('#codex-launch-command').value = codexLaunchCommand(job.exportId, job.launchEvidence); $('#codex-launch').hidden = false; } openDialog('ai-dialog'); });
  $('#cloud-button').addEventListener('click', () => { openDialog('cloud-dialog'); if (!state.backendAvailable) preloadGoogleIdentity(); renderCloudStatus(); if (cloudConnected()) { refreshCloudBackups(); refreshBackendSessions(); } });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.close)));
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
      const node = $('#toast');
      if (node.parentElement === dialog || dialog.contains(node)) document.body.append(node);
    });
  });
  $('#entry-form').addEventListener('submit', saveFromForm); $('#batch-form').addEventListener('submit', saveBatch); $('#image-form').addEventListener('submit', event => localEntryMutation(() => saveImages(event)));
  $('#image-form').addEventListener('submit', event => event.preventDefault());
  $('#entry-url').addEventListener('input', () => { $('#entry-metadata-status').textContent = ''; refreshEditorType(); });
  $('#entry-type').addEventListener('change', confirmEditorType);
  $('#confirm-type').addEventListener('click', confirmEditorType);
  $('#auto-type').addEventListener('click', () => refreshEditorType(true));
  $('#paste-url').addEventListener('click', async () => { try { $('#entry-url').value = (await navigator.clipboard.readText()).trim(); refreshEditorType(); } catch { toast('剪貼簿無法讀取，請手動貼上'); } });
  $('#paste-inbox').addEventListener('click', readClipboardToBatch); $('#fetch-title').addEventListener('click', fetchTitle); $('#batch-preview-button').addEventListener('click', previewBatch); $('#batch-text').addEventListener('input', previewBatch);
  $('#image-files').addEventListener('change', event => prepareImages(event.target.files));
  const drop = $('#drop-zone'); ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('is-dragging'); })); ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('is-dragging'); })); drop.addEventListener('drop', event => prepareImages(event.dataTransfer.files));
  $('#export-backup').addEventListener('click', exportBackup); $('#export-migration').addEventListener('click', exportMigrationPackage); $('#import-backup').addEventListener('click', () => $('#backup-file').click()); $('#backup-file').addEventListener('change', importBackupFile); $('#confirm-import').addEventListener('click', () => localEntryMutation(confirmImport));
  $('#migration-banner-backup').addEventListener('click', () => openDialog('backup-dialog'));
  $('#export-ai').addEventListener('click', exportForCodex); $('#import-ai').addEventListener('click', () => $('#organized-file').click()); $('#organized-file').addEventListener('change', importOrganized); $('#apply-ai').addEventListener('click', applyOrganized); $('#undo-ai').addEventListener('click', undoAi);
  $('#cloud-connect').addEventListener('click', connectDrive); $('#cloud-disconnect').addEventListener('click', disconnectDrive);
  $('#owner-bootstrap').addEventListener('click', bootstrapBackendOwner);
  $('#cloud-revoke-grant').addEventListener('click', revokeCloudGrant); $('#refresh-device-sessions').addEventListener('click', refreshBackendSessions);
  $('#create-shortcut-credential').addEventListener('click', createCaptureCredential);
  $('#copy-shortcut-token').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#shortcut-token').value); toast('捷徑憑證已複製；請勿貼到聊天、網址或公開筆記'); } catch { $('#shortcut-token').select(); toast('無法自動複製，已選取憑證文字'); } });
  $('#google-client-id').addEventListener('input', event => { if (state.googleIdentityStatus === 'ready' && isValidGoogleClientId(event.target.value.trim())) prepareGoogleAuth(event.target.value.trim()); });
  $('#cloud-save-settings').addEventListener('click', async () => { await saveCloudSettingsFromForm(); renderCloudStatus(); toast('雲端設定已保存；密碼只保留到本頁關閉'); });
  $('#cloud-backup-now').addEventListener('click', () => runCloudBackup(false)); $('#cloud-sync-now').addEventListener('click', () => syncNow(false));
  $('#cloud-refresh-backups').addEventListener('click', refreshCloudBackups); $('#cloud-encryption').addEventListener('change', renderCloudStatus);
  $('#cloud-passphrase').addEventListener('input', event => { state.cloudPassphrase = event.target.value; });
  $('#copy-codex-launch').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#codex-launch-command').value); toast('已複製此批次 Codex 指令'); } catch { $('#codex-launch-command').focus(); $('#codex-launch-command').select(); toast('已選取指令，請複製'); } });
  $('#ai-cloud-export').addEventListener('click', enqueueCloudAi); $('#ai-cloud-check').addEventListener('click', checkCloudAi);
  $('#persist-storage').addEventListener('click', async () => { const persisted = await navigator.storage?.persist?.(); toast(persisted ? '瀏覽器已同意保留本機資料' : '瀏覽器未授予保留權限；請定期下載備份'); });
  $('#search-input').addEventListener('input', event => { state.query = event.target.value.trim(); render(); }); $('#type-filter').addEventListener('change', event => { state.type = event.target.value; render(); }); $('#sort-filter').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('#select-visible').addEventListener('change', event => { filteredEntries().forEach(entry => event.target.checked ? state.selected.add(entry.id) : state.selected.delete(entry.id)); render(); }); $('#selection-clear').addEventListener('click', () => { state.selected.clear(); render(); });
  $$('[data-bulk]').forEach(button => button.addEventListener('click', () => { const ids = [...state.selected]; const action = button.dataset.bulk; if (action === 'star') updateEntries(ids, entry => ({ ...entry, starred: !entry.starred }), '已切換星號'); else updateEntries(ids, entry => ({ ...entry, status: action }), '批次狀態已更新'); }));
  $('#bulk-edit-button').addEventListener('click', () => { $('#bulk-form').reset(); $('#bulk-error').hidden = true; openDialog('bulk-dialog'); });
  $('#bulk-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const tags = inputTags($('#bulk-tags').value);
      const saved = await updateEntries([...state.selected], entry => {
        const merged = mergeTopicTags(entry.tags, tags);
        if (merged.pending.length) throw new Error(`「${entry.title}」超過標籤上限，請先整理；本次整批未變更。`);
        return { ...entry, tags: merged.tags };
      }, '批次標籤已更新');
      if (saved) closeDialog('bulk-dialog');
    } catch (error) { $('#bulk-error').textContent = error.message; $('#bulk-error').hidden = false; $('#bulk-error').focus(); }
  });
  document.addEventListener('change', event => { const input = event.target.closest('[data-select-id]'); if (!input) return; input.checked ? state.selected.add(input.dataset.selectId) : state.selected.delete(input.dataset.selectId); render(); });
  document.addEventListener('click', event => {
    const revokeCaptureButton = event.target.closest('[data-revoke-capture]'); if (revokeCaptureButton) { state.backend.revokeCaptureCredential(revokeCaptureButton.dataset.revokeCapture).then(() => { toast('快捷收藏憑證已撤銷'); return refreshCaptureCredentials(); }).catch(error => toast(`撤銷失敗：${error.message}`, 8000)); return; }
    const revokeSessionButton = event.target.closest('[data-revoke-session]'); if (revokeSessionButton) { state.backend.revokeSession(revokeSessionButton.dataset.revokeSession).then(() => { toast('裝置工作階段已撤銷'); return refreshBackendSessions(); }).catch(error => toast(`撤銷失敗：${error.message}`, 8000)); return; }
    const restoreButton = event.target.closest('[data-cloud-restore]'); if (restoreButton) { previewCloudRestore(Number(restoreButton.dataset.cloudRestore)); return; }
    const conflictButton = event.target.closest('[data-conflict-choice]'); if (conflictButton) { handleConflictChoice(Number(conflictButton.dataset.conflictIndex), conflictButton.dataset.conflictChoice); return; }
    const preview = event.target.closest('[data-view-image]'); if (preview) { const entry = state.entries.find(item => item.id === preview.dataset.viewImage); if (entry) imageViewer.open(entry, preview); return; }
    const view = event.target.closest('[data-view]'); if (view) { state.view = view.dataset.view; render(); return; }
    const button = event.target.closest('[data-action][data-id]'); if (!button) return; const entry = state.entries.find(item => item.id === button.dataset.id); if (!entry) return;
    if (button.dataset.action === 'edit') openEditor(entry); else if (button.dataset.action === 'delete') deleteEntry(entry.id); else if (button.dataset.action === 'star') updateEntries([entry.id], item => ({ ...item, starred: !item.starred }), entry.starred ? '已移除星號' : '已加上星號'); else updateEntries([entry.id], item => ({ ...item, status: button.dataset.action }), '收藏狀態已更新');
  });
  document.addEventListener('keydown', event => { if ($$('dialog[open]').length || event.ctrlKey || event.metaKey || event.altKey || /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return; if (event.key === '/') { event.preventDefault(); $('#search-input').focus(); } if (event.key.toLowerCase() === 'n') { event.preventDefault(); openEditor(); } });
  window.addEventListener('pagehide', () => { imageViewer.dispose(); thumbnailGeneration++; state.thumbnailUrls.forEach(url => URL.revokeObjectURL(url)); state.thumbnailUrls = []; });
  window.addEventListener('pageshow', event => { if (event.persisted) loadThumbnails(); });
  window.addEventListener('online', () => { if (state.backendSession) importCaptureJobs(); if (cloudConnected()) { scheduleAutoBackup(1200); scheduleAutoSync(1700); toast('網路已恢復，將補傳待備份與同步變更'); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.backendSession) importCaptureJobs(); if (document.visibilityState === 'visible' && cloudConnected()) { scheduleAutoBackup(1500); scheduleAutoSync(2100); } });
}

function handleLegacyShareQuery() {
  const params = new URLSearchParams(location.search); if (![...['title', 'text', 'url']].some(key => params.has(key))) return;
  history.replaceState(null, '', location.pathname + location.hash);
  toast('已立即清除分享網址參數；建議改用「複製 → 開啟 App → 讀取剪貼簿」避免伺服器紀錄私人網址', 8000);
}

async function init() {
  bindEvents();
  try {
    const { repository, migration } = await initRepository(); state.repository = repository;
    const initial = await repository.readSyncSnapshot(); state.entries = initial.entries; state.dataRevision = initial.revision;
    state.deviceId = await repository.getMeta('device-id') || makeId('device'); await repository.setMeta('device-id', state.deviceId);
    state.syncJournal = initial.journal; state.tombstones = initial.tombstones;
    state.cloudConflicts = await repository.getMeta('sync-conflicts', []); state.cloudJobs = await repository.getMeta('cloud-ai-jobs', []); state.activeAiExportId = await repository.getMeta('active-ai-export-id', '');
    state.cloudSettings = { ...state.cloudSettings, ...(await repository.getMeta('cloud-settings', {})) };
    $('#google-client-id').value = state.cloudSettings.clientId || ''; $('#cloud-auto-backup').checked = state.cloudSettings.autoBackup !== false;
    $('#cloud-retention').value = state.cloudSettings.retention || 5; $('#cloud-encryption').checked = Boolean(state.cloudSettings.encryption);
    const authResult = authResultFromLocation();
    try { await restoreBackendSession(); }
    catch (error) { state.backendAvailable = true; state.backendSession = null; toast(`雲端工作階段暫時無法恢復：${error.message}；本機收藏仍可使用`, 8500); }
    render(); renderCloudStatus(); updateStorageSummary(); handleLegacyShareQuery();
    if (authResult === 'success') toast('Google Drive 已安全登入，後續會自動恢復工作階段 ✓');
    else if (authResult) toast(`Google 登入未完成（${authResult}）；本機收藏仍完整保留`, 8500);
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
