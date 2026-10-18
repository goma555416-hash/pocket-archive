import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = 'http://127.0.0.1:4173';
const DEBUG = 'http://127.0.0.1:9223';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(check, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await check(); if (value) return value; } catch { /* retry */ }
    await delay(80);
  }
  throw new Error(`逾時等待：${label}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.counter = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.counter;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000));
    return Promise.race([result, timeout]);
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

let server; let browser; let profile; let cdp;
try {
  profile = await mkdtemp(join(tmpdir(), 'pocket-archive-e2e-'));
  server = spawn('python', ['-m', 'http.server', '4173', '--bind', '127.0.0.1'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
  await waitFor(async () => (await fetch(HOST)).ok, '本機 HTTP 伺服器');
  browser = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9223', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const version = await waitFor(async () => { const response = await fetch(`${DEBUG}/json/version`); return response.ok && response.json(); }, 'Chromium DevTools');
  assert.ok(version.Browser.includes('Chrome'));
  const target = await fetch(`${DEBUG}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  cdp = new Cdp(target.webSocketDebuggerUrl); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('pocket-archive:entries:v1', JSON.stringify([{id:'legacy-e2e',url:'https://legacy.example.com/item',title:'舊版收藏',note:'保留我',type:'文章',status:'inbox',tags:['舊版']}]))` });
  await cdp.send('Page.navigate', { url: HOST });
  await waitFor(() => cdp.evaluate('window.__PA_READY__ === true'), 'App 初始化');
  process.stdout.write('E2E：App 與 v1 遷移已啟動\n');
  assert.equal(await cdp.evaluate("document.querySelectorAll('.item-card').length"), 1, 'v1 localStorage migration');
  assert.equal(await cdp.evaluate("document.querySelector('.card-title').textContent.includes('舊版收藏')"), true);

  await cdp.evaluate(`(() => {
    document.querySelector('#new-button').click();
    document.querySelector('#entry-url').value='https://example.com/new?utm_source=e2e';
    document.querySelector('#entry-title').value='E2E 新收藏';
    document.querySelector('#entry-category').value='測試分類';
    document.querySelector('#entry-tags').value='測試, 自動化';
    document.querySelector('#entry-form').requestSubmit();
  })()`);
  await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.card-title')].some(n=>n.textContent.includes('E2E 新收藏'))"), '單筆新增');

  await cdp.evaluate(`(() => {
    document.querySelector('#batch-button').click();
    const area=document.querySelector('#batch-text'); area.value='https://example.com/batch-one\\nhttps://example.com/batch-two\\nhttps://example.com/batch-one?utm_source=x\\nwrong'; area.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  assert.equal(await cdp.evaluate("document.querySelector('#batch-preview').textContent.includes('2 筆有效')"), true, '批次預覽');
  await cdp.evaluate("document.querySelector('#batch-form').requestSubmit()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.item-card').length === 4"), '批次新增');

  await cdp.evaluate(`(() => {
    document.querySelector('#image-button').click();
    const file=new File([new Uint8Array([137,80,78,71,13,10,26,10])],'tiny.png',{type:'image/png'}); const transfer=new DataTransfer(); transfer.items.add(file); const input=document.querySelector('#image-files'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor(() => cdp.evaluate("document.querySelector('#image-preview').textContent.includes('1 張可加入')"), '圖片 hash 預覽');
  await cdp.evaluate("document.querySelector('#image-form').requestSubmit()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.item-card').length === 5"), '圖片 IndexedDB 儲存');
  process.stdout.write('E2E：新增、批次與圖片通過\n');
  assert.equal(await cdp.evaluate("document.querySelectorAll('[data-attachment-id]').length"), 1);

  await cdp.evaluate(`(() => { const input=document.querySelector('#search-input'); input.value='測試分類 自動化'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.equal(await cdp.evaluate("document.querySelectorAll('.item-card').length"), 1, '搜尋跨分類與標籤');
  await cdp.evaluate(`(() => { const input=document.querySelector('#search-input'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);

  const imported = JSON.stringify({ format: 'pocket-archive-backup', schema_version: 2, app: 'Pocket Archive', exported_at: '2026-10-17T00:00:00Z', attachments: [], items: [{ id: 'imported-e2e', kind: 'link', url: 'https://example.net/imported', title: '還原收藏', note: '', type: '文章', category: '', status: 'inbox', tags: [], starred: false, source: 'example.net', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' }] });
  await cdp.evaluate(`(() => { const file=new File([${JSON.stringify(imported)}],'backup.json',{type:'application/json'}); const transfer=new DataTransfer(); transfer.items.add(file); const input=document.querySelector('#backup-file'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(() => cdp.evaluate("document.querySelector('#confirm-dialog').open"), '備份匯入預覽');
  assert.equal(await cdp.evaluate("document.querySelector('#confirm-content').textContent.includes('1 筆將合併')"), true);
  await cdp.evaluate("document.querySelector('#confirm-import').click()");
  await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.card-title')].some(n=>n.textContent.includes('還原收藏'))"), '備份合併');
  process.stdout.write('E2E：搜尋與備份匯入通過\n');

  await cdp.evaluate("document.querySelector('#ai-button').click(); document.querySelector('#export-ai').click()");
  const exportId = await waitFor(() => cdp.evaluate(`new Promise(resolve => { const request=indexedDB.open('pocket-archive'); request.onsuccess=()=>{ const tx=request.result.transaction('meta','readonly'); const get=tx.objectStore('meta').get('ai-export-ids'); get.onsuccess=()=>resolve(get.result?.value?.[0]||''); }; })`), 'Codex export_id');
  const organized = JSON.stringify({ format: 'pocket-archive-organized', schema_version: 2, source_export_id: exportId, items: [{ id: 'imported-e2e', analysis_status: 'completed', suggested_categories: ['閱讀'], suggested_tags: ['已分析'], summary: '依可見測試內容產生的摘要', reason: 'visible test title', confidence: 'high' }] });
  await cdp.evaluate(`(() => { const file=new File([${JSON.stringify(organized)}],'organized.json',{type:'application/json'}); const transfer=new DataTransfer(); transfer.items.add(file); const input=document.querySelector('#organized-file'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(() => cdp.evaluate("!document.querySelector('#apply-ai').hidden"), 'Codex 差異預覽');
  await cdp.evaluate("document.querySelector('#apply-ai').click()");
  await waitFor(() => cdp.evaluate("document.body.textContent.includes('依可見測試內容產生的摘要')"), 'Codex 套用');
  await cdp.evaluate("window.confirm=()=>true; document.querySelector('#backup-button').click(); document.querySelector('#undo-ai').click()");
  await waitFor(() => cdp.evaluate("!document.body.textContent.includes('依可見測試內容產生的摘要')"), 'Codex 單次復原');
  process.stdout.write('E2E：Codex 預覽、套用與復原通過\n');

  await cdp.evaluate(`(() => {
    document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    document.querySelector('#cloud-button').click();
    document.querySelector('#google-client-id').value='123456-e2e.apps.googleusercontent.com';
    document.querySelector('#cloud-retention').value='7';
    const encryption=document.querySelector('#cloud-encryption'); encryption.checked=true; encryption.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('#cloud-save-settings').click();
  })()`);
  assert.equal(await cdp.evaluate("document.querySelector('#cloud-status').textContent.includes('尚未連結')"), true, '未授權不得顯示同步成功');
  assert.equal(await cdp.evaluate("document.querySelector('#cloud-sync-now').disabled && document.querySelector('#ai-cloud-export').disabled"), true, '未連線時雲端操作停用');
  assert.equal(await cdp.evaluate("!document.querySelector('#cloud-passphrase-row').hidden"), true, '加密選項顯示工作階段密碼');
  const cloudSettings = await cdp.evaluate(`new Promise(resolve => { const request=indexedDB.open('pocket-archive'); request.onsuccess=()=>{ const tx=request.result.transaction('meta','readonly'); const get=tx.objectStore('meta').get('cloud-settings'); get.onsuccess=()=>resolve(get.result?.value||null); }; })`);
  assert.equal(cloudSettings.clientId, '123456-e2e.apps.googleusercontent.com'); assert.equal(cloudSettings.retention, 7); assert.equal(cloudSettings.encryption, true);
  process.stdout.write('E2E：Drive 未授權狀態、設定與加密 UI 通過\n');

  const atomicRollback = await cdp.evaluate(`(async () => {
    const { PocketRepository } = await import('./db.mjs');
    const { createEntry, validatedEntry } = await import('./lib.mjs');
    const request = indexedDB.open('pocket-archive-atomic-e2e', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('entries', { keyPath: 'id' });
      request.result.createObjectStore('attachments', { keyPath: 'id' });
    };
    const database = await new Promise((resolve, reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
    const repository = new PocketRepository(database);
    const original = createEntry({ url: 'https://example.com/atomic-original', title: '原子交易原始資料' });
    await repository.replaceBundle([original]);
    const remote = validatedEntry({
      id: 'remote-image-e2e', kind: 'image', title: '遠端圖片', type: '圖片',
      attachment: { id: 'att-noncloneable', name: 'remote.png', size: 8, mimeType: 'image/png', hash: 'a'.repeat(64) }
    });
    let failed = false;
    try { await repository.replaceBundle([remote], new Map([['att-noncloneable', () => 'cannot clone']])); } catch { failed = true; }
    const remaining = await repository.listEntries(); database.close(); indexedDB.deleteDatabase('pocket-archive-atomic-e2e');
    return { failed, ids: remaining.map(entry => entry.id) };
  })()`);
  assert.equal(atomicRollback.failed, true, '附件寫入失敗必須拒絕 transaction');
  assert.equal(atomicRollback.ids.length, 1); assert.equal(atomicRollback.ids[0].startsWith('pa-'), true, 'transaction abort 後保留原始收藏');
  process.stdout.write('E2E：IndexedDB 收藏與附件原子回滾通過\n');

  assert.deepEqual(await cdp.evaluate(`(() => [...document.querySelectorAll('button')].filter(button => !(button.textContent.trim() || button.getAttribute('aria-label') || button.title)).map(button => button.id || button.outerHTML))()`), [], '所有按鈕有可存取名稱');
  assert.deepEqual(await cdp.evaluate(`(() => [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(control => !control.closest('label') && !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby')).map(control => control.id))()`), [], '所有表單控制項有標籤');
  await cdp.evaluate("document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()); document.dispatchEvent(new KeyboardEvent('keydown',{key:'/'}))");
  assert.equal(await cdp.evaluate("document.activeElement.id"), 'search-input', '/ 鍵聚焦搜尋');
  await cdp.evaluate("document.querySelector('#search-input').blur(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'n'}))");
  assert.equal(await cdp.evaluate("document.querySelector('#entry-dialog').open"), true, 'N 鍵開啟新增');
  await cdp.evaluate("document.querySelector('#entry-dialog').close()");

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  assert.equal(await cdp.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true, '390px 無水平溢出');
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.mobile-nav')).display === 'grid'"), true, '手機底部導覽');

  await waitFor(() => cdp.evaluate("Boolean(navigator.serviceWorker.controller)"), 'Service Worker 控制頁面', 16000);
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(() => cdp.evaluate("Boolean(document.querySelector('#page-heading'))"), '離線啟動', 12000);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  process.stdout.write('E2E 通過：遷移、單筆、批次、圖片、搜尋、備份、Codex 預覽/套用/復原、390px、離線。\n');
} finally {
  cdp?.close();
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
  }
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
