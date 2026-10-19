import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIVE_SCOPE, GoogleAuthSession, DriveApi, DriveApiError } from '../drive.mjs';
import { encryptBackup, decryptBackup } from '../crypto.mjs';
import { createEntry, createImageEntry, sha256, validatedEntry } from '../lib.mjs';
import { compareClocks, createJournal, readJournal, recordLocalChanges, reconcileReplica, resolveConflict } from '../sync.mjs';
import { CloudBackupService, CloudAiExchange, CloudSyncService, createBackupArtifact } from '../cloud.mjs';

test('Google OAuth 預先初始化、同步觸發 popup，token 僅存於工作階段且撤銷會清除', async () => {
  let callback; let requested; let revoked = ''; let initialized;
  const googleObject = { accounts: { oauth2: {
    initTokenClient(options) { initialized = options; callback = options.callback; return { requestAccessToken(value) { requested = value; queueMicrotask(() => callback({ access_token: 'short-lived', expires_in: 120 })); } }; },
    revoke(token, done) { revoked = token; done(); }
  } } };
  let now = 1000;
  const auth = new GoogleAuthSession({ clientId: '123456-test.apps.googleusercontent.com', googleObject, now: () => now });
  assert.equal(initialized.scope, DRIVE_SCOPE); assert.equal(initialized.include_granted_scopes, true);
  const firstConnection = auth.connect();
  assert.deepEqual(requested, { prompt: 'consent' });
  await firstConnection;
  assert.equal(auth.getAccessToken(), 'short-lived');
  now += 61_001;
  assert.throws(() => auth.getAccessToken(), /授權已失效/);
  await auth.connect(); await auth.disconnect();
  assert.equal(revoked, 'short-lived'); assert.equal(auth.status().connected, false);
});

test('Drive API 對暫時錯誤重試，但 401 立即要求重新連結', async () => {
  let calls = 0; const waits = [];
  const drive = new DriveApi({
    getAccessToken: () => 'token', sleep: async value => waits.push(value), random: () => 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.deepEqual(await drive.listFiles(), { files: [] }); assert.equal(calls, 3); assert.equal(waits.length, 2);
  const unauthorized = new DriveApi({ getAccessToken: () => 'bad', fetchImpl: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(() => unauthorized.listFiles(), error => error instanceof DriveApiError && /重新連結/.test(error.message));
});

test('大型 Drive 檔案使用 resumable session，避免單次簡易上傳限制', async () => {
  const requests = [];
  const drive = new DriveApi({ getAccessToken: () => 'token', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return new Response('', { status: 200, headers: { location: 'https://upload.example/session' } });
    return new Response(JSON.stringify({ id: 'large-file', size: String(options.body.size) }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const blob = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'application/zip' });
  const result = await drive.updateContent('large-file', blob);
  assert.equal(result.id, 'large-file');
  assert.match(requests[0].url, /uploadType=resumable/);
  assert.equal(requests[1].options.headers['Content-Range'], `bytes 0-${blob.size - 1}/${blob.size}`);
});

test('AES-GCM 備份可完整往返，錯誤密碼與竄改都拒絕', async () => {
  const original = new Blob(['private archive'], { type: 'application/json' });
  const encrypted = await encryptBackup(original, 'correct horse battery', { filename: 'backup.json' });
  assert.notEqual(await encrypted.text(), await original.text());
  const restored = await decryptBackup(encrypted, 'correct horse battery');
  assert.equal(await restored.blob.text(), 'private archive'); assert.equal(restored.filename, 'backup.json');
  await assert.rejects(() => decryptBackup(encrypted, 'wrong password long'), /密碼錯誤|損毀/);
  const bytes = new Uint8Array(await encrypted.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(() => decryptBackup(new Blob([bytes]), 'correct horse battery'), /密碼錯誤|損毀/);
});

test('向量時鐘辨識先後與並行修改，刪除衝突優先保留資料並可人工解決', () => {
  assert.equal(compareClocks({ a: 2 }, { a: 1 }), 'dominates');
  assert.equal(compareClocks({ a: 1 }, { b: 1 }), 'concurrent');
  const base = createEntry({ id: 'shared', url: 'https://example.com/shared', title: 'base' });
  const a = recordLocalChanges([], [base], { deviceId: 'device-a', now: '2026-10-18T00:00:00Z' });
  const bBase = { ...a.entries[0], title: 'B edit' };
  const b = recordLocalChanges([a.entries[0]], [bBase], { deviceId: 'device-b', now: '2026-10-18T00:01:00Z' });
  const deleted = recordLocalChanges(a.entries, [], { deviceId: 'device-a', journal: a.journal, now: '2026-10-18T00:02:00Z' });
  const merged = reconcileReplica([], deleted.tombstones, Object.values(b.journal));
  assert.equal(merged.entries.length, 1, 'concurrent edit protects against deletion');
  assert.equal(merged.conflicts.length, 1);
  const resolved = resolveConflict(merged.conflicts[0], 'local', 'device-c', '2026-10-18T00:03:00Z');
  assert.equal(resolved.record.operation, 'delete');
  assert.equal(resolved.record.clock['device-c'], 1);
});

test('同步日誌 schema 往返且拒絕缺少版本向量的紀錄', () => {
  const entry = validatedEntry({ id: 'journal-item', url: 'https://example.com/journal' });
  const mutation = recordLocalChanges([], [entry], { deviceId: 'device-a', now: '2026-10-18T00:00:00Z' });
  const envelope = createJournal('device-a', mutation.journal, '2026-10-18T00:00:01Z');
  assert.equal(readJournal(JSON.stringify(envelope)).records[0].itemId, 'journal-item');
  assert.throws(() => readJournal({ ...envelope, records: [{ itemId: 'bad', operation: 'delete', clock: {} }] }), /版本資訊/);
});

test('雲端完整備份含圖片、驗證大小並只輪替 Pocket Archive 備份', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([bytes], 'tiny.png', { type: 'image/png' });
  const image = createImageEntry(file, await sha256(file), 'att-cloud');
  const repository = { getAttachment: async id => id === 'att-cloud' ? file : null };
  const artifact = await createBackupArtifact([image], repository, new Date('2026-10-18T00:00:00Z'));
  assert.equal(artifact.blob.type, 'application/zip');
  const trashed = []; let createdBlob;
  const drive = {
    async createFile(value) { createdBlob = value.blob; return { id: 'new-backup' }; },
    async getFile() { return { id: 'new-backup', name: 'new.zip', size: String(createdBlob.size), createdTime: '2026-10-18T00:00:00Z', appProperties: { paRole: 'backup' } }; },
    async downloadFile() { return createdBlob; },
    async listFiles() { return { files: [
      { id: 'new-backup', createdTime: '2026-10-18T00:00:00Z', appProperties: { paRole: 'backup' } },
      { id: 'old-backup', createdTime: '2026-10-17T00:00:00Z', appProperties: { paRole: 'backup' } }
    ] }; },
    async trashFile(id) { trashed.push(id); }
  };
  const service = new CloudBackupService(drive, { backups: 'folder' });
  await service.create([image], repository, { retention: 1, now: new Date('2026-10-18T00:00:00Z') });
  assert.deepEqual(trashed, ['old-backup']);
});

test('AI 交換區預先建立結果檔並避免重複工作', async () => {
  const entry = createEntry({ id: 'ai-item', url: 'https://example.com/ai', updatedAt: '2026-10-18T00:00:00Z' });
  const created = []; const updates = [];
  const drive = {
    async listFiles() { return { files: [] }; },
    async createFile(value) { const file = { id: `file-${created.length + 1}`, name: value.name, appProperties: value.appProperties }; created.push({ ...value, file }); return file; },
    async updateMetadata(id, value) { updates.push({ id, value }); }
  };
  const exchange = new CloudAiExchange(drive, { aiInbox: 'inbox-folder', aiResults: 'result-folder' });
  const result = await exchange.enqueue([entry], { getAttachment: async () => null }, new Date('2026-10-18T00:00:00Z'));
  assert.equal(result.duplicate, false); assert.equal(created.length, 2);
  assert.equal(created[1].appProperties.paRole, 'aiResult');
  assert.equal(JSON.parse(await created[1].blob.text()).status, 'pending');
  assert.equal(updates[0].value.appProperties.resultFileId, 'file-2');
});

test('模擬 iPhone/Windows 經 Drive journal 與附件做雙向增量同步', async () => {
  const files = new Map(); let sequence = 0;
  const drive = {
    async listFiles({ parentId, name, appRole }) {
      return { files: [...files.values()].filter(file => (!parentId || file.parentId === parentId) && (!name || file.name === name) && (!appRole || file.appProperties?.paRole === appRole)) };
    },
    async createFile(value) {
      const file = { id: `drive-${++sequence}`, name: value.name, parentId: value.parentId, appProperties: value.appProperties, blob: value.blob, size: String(value.blob.size), createdTime: new Date().toISOString() };
      files.set(file.id, file); return file;
    },
    async updateContent(id, blob) { const file = files.get(id); file.blob = blob; file.size = String(blob.size); return file; },
    async downloadFile(id) { return files.get(id).blob; }
  };
  const workspace = { sync: 'sync-folder', syncAttachments: 'attachment-folder' };
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const imageBlob = new Blob([bytes], { type: 'image/png' });
  const image = createImageEntry(new File([bytes], 'shared.png', { type: 'image/png' }), await sha256(imageBlob), 'att-shared');
  const blobsA = new Map([['att-shared', imageBlob]]); const blobsB = new Map();
  const repoA = { getAttachment: async id => blobsA.get(id) || null };
  const repoB = { getAttachment: async id => blobsB.get(id) || null };
  const localA = recordLocalChanges([], [image], { deviceId: 'iphone', now: '2026-10-18T01:00:00Z' });
  const service = new CloudSyncService(drive, workspace);
  await service.sync({ entries: localA.entries, repository: repoA, deviceId: 'iphone', journal: localA.journal, tombstones: {} });
  const receivedB = await service.sync({ entries: [], repository: repoB, deviceId: 'windows', journal: {}, tombstones: {} });
  assert.equal(receivedB.entries.length, 1); assert.equal(receivedB.attachmentBlobs.size, 1);
  blobsB.set('att-shared', receivedB.attachmentBlobs.get('att-shared'));
  const editedB = { ...receivedB.entries[0], title: 'Windows 已編輯', updatedAt: '2026-10-18T01:02:00Z' };
  const localB = recordLocalChanges(receivedB.entries, [editedB], { deviceId: 'windows', now: '2026-10-18T01:02:00Z' });
  await service.sync({ entries: localB.entries, repository: repoB, deviceId: 'windows', journal: localB.journal, tombstones: receivedB.tombstones });
  const receivedA = await service.sync({ entries: localA.entries, repository: repoA, deviceId: 'iphone', journal: localA.journal, tombstones: {} });
  assert.equal(receivedA.entries[0].title, 'Windows 已編輯'); assert.equal(receivedA.conflicts.length, 0);
  assert.equal([...files.values()].filter(file => file.appProperties?.paRole === 'syncAttachment').length, 1, '附件依 SHA-256 去重');
});

test('AI 啟動指令指定批次與儲存庫、禁止 Notion，拒絕錯誤入口資料', async () => {
  const { codexLaunchCommand } = await import('../ai-launch.mjs');
  const command = codexLaunchCommand('export-anonymous-test');
  for (const text of ['goma555416-hash/pocket-archive', 'AGENTS.md', 'AI-BATCH-SPEC.md', 'CODEX-DRIVE-WORKFLOW.md', 'CODEX-ORGANIZE-PROMPT.md', 'Pocket Archive/AI-Inbox', 'Pocket Archive/AI-Results', '禁止搜尋 Notion', 'fail closed', '原 file ID', 'export-anonymous-test']) assert.ok(command.includes(text), text);
  assert.doesNotMatch(command, /https?:|Bearer|pa_capture_/);
  assert.throws(() => codexLaunchCommand('https://private.example.test/?token=secret'), /無效/);
});

test('AI 結果原檔與完整 ID 驗證 fail closed，重複批次不能另建占位檔', async () => {
  const entry = validatedEntry({ id: 'ai-scoped', url: 'https://example.test/anonymous' }); const exportId = 'export-anonymous';
  const workspace = { aiInbox: 'inbox', aiResults: 'results' }; let creates = 0;
  let file = { id: 'result-file', name: `organized-${exportId}.json`, parents: ['results'], appProperties: { paRole: 'aiResult', exportId, inboxFileId: 'inbox-file' } };
  let raw = { format: 'pocket-archive-organized', schema_version: 2, source_export_id: exportId, status: 'pending', items: [] };
  const drive = { getFile: async () => file, downloadFile: async () => new Blob([JSON.stringify(raw)]), createFile: async () => { creates++; }, listFiles: async () => ({ files: [] }) };
  const exchange = new CloudAiExchange(drive, workspace); const job = { exportId, inboxFileId: 'inbox-file', resultFileId: 'result-file', itemIds: [entry.id] };
  assert.equal((await exchange.readResult(job, [entry], [exportId])).pending, true);
  raw.source_export_id = 'export-wrong'; await assert.rejects(() => exchange.readResult(job, [entry], [exportId]), /不匹配/); raw.source_export_id = exportId;
  file.parents = ['wrong-folder']; await assert.rejects(() => exchange.readResult(job, [entry], [exportId]), /原檔不匹配/); file.parents = ['results'];
  await assert.rejects(() => exchange.readResult({ ...job, resultFileId: null }, [entry], [exportId]), /缺失/);
  delete raw.status; await assert.rejects(() => exchange.readResult(job, [entry], [exportId]), /完整一對一/);
  raw.items = [{ id: entry.id, analysis_status: 'insufficient_data', suggested_categories: [], suggested_tags: [], summary: '', reason: '未取得內容', confidence: 'low' }];
  assert.equal((await exchange.readResult(job, [entry], [exportId])).result.accepted.length, 1);
  raw.items.push({ ...raw.items[0] }); await assert.rejects(() => exchange.readResult(job, [entry], [exportId]), /完整一對一/);
  raw.items = [{ ...raw.items[0], id: 'another-valid-local-item' }]; await assert.rejects(() => exchange.readResult(job, [entry], [exportId]), /完整一對一/);
  const { sha256 } = await import('../lib.mjs'); const jobKey = await sha256(new TextEncoder().encode(`${entry.id}:${entry.updatedAt}`));
  drive.listFiles = async () => ({ files: [{ id: 'inbox-file', appProperties: { jobKey, exportId } }] });
  await assert.rejects(() => exchange.enqueue([entry], {}), /占位檔缺失/); assert.equal(creates, 0);
});


test('AI 檢查保持畫面所選批次，不因重複送出跳到另一個待處理批次', async () => {
  const { cloudAiJobForReview } = await import('../ai-launch.mjs');
  const jobs = [{ exportId: 'export-new', status: 'pending' }, { exportId: 'export-old', status: 'ready' }, { exportId: 'export-applied', status: 'applied' }];
  assert.equal(cloudAiJobForReview(jobs, 'export-old').exportId, 'export-old');
  assert.equal(cloudAiJobForReview(jobs, 'export-applied').status, 'applied');
  assert.throws(() => cloudAiJobForReview(jobs, 'export-missing'), /不改選/);
  assert.equal(cloudAiJobForReview(jobs).exportId, 'export-new');
});
