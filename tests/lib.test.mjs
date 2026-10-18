import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, normalizeUrl, cleanTags, createEntry, createCaptureEntry, createImageEntry, readBackup,
  createBackupEnvelope, previewMerge, mergeEntries, matchesEntry, extractIncomingShare,
  escapeHtml, parseBatchUrls, createInboxEnvelope, readOrganized, applySuggestions,
  restoreSnapshot, validatedEntry, sha256, hasValidImageSignature
} from '../lib.mjs';
import { readLegacyEntries, storageError } from '../db.mjs';

test('網址規範化會移除憑證、fragment 與追蹤參數，但保留重要參數', () => {
  assert.equal(normalizeUrl('https://me:secret@example.com/p/?utm_source=mail&z=2&a=1#hello'), 'https://example.com/p?a=1&z=2');
  assert.equal(normalizeUrl('example.com/'), 'https://example.com/');
});

test('拒絕非 http(s) 與錯誤網址', () => {
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
  assert.throws(() => normalizeUrl('not a url'));
  assert.throws(() => normalizeUrl(''));
});

test('清理重複標籤並限制數量與長度', () => {
  assert.deepEqual(cleanTags('設計,設計，靈感、遊戲'), ['設計', '靈感', '遊戲']);
  assert.equal(cleanTags(Array.from({ length: 40 }, (_, index) => `tag${index}`)).length, 24);
});

test('分享文字可抽出 URL 與備註', () => {
  const parsed = extractIncomingShare('?title=Hello&text=%E6%94%B6%E8%97%8F%20https%3A%2F%2Fexample.com%2Fpost');
  assert.equal(parsed.url, 'https://example.com/post');
  assert.equal(parsed.title, 'Hello');
  assert.equal(parsed.note, '收藏');
});

test('100 筆批次網址可預覽，有效、批內重複、既有重複和錯誤會分開', () => {
  const existing = [createEntry({ url: 'https://example.com/0' })];
  const rows = Array.from({ length: 100 }, (_, index) => `https://example.com/${index}`);
  rows.push('https://example.com/1?utm_source=x', 'not a url');
  const preview = parseBatchUrls(rows.join('\n'), existing);
  assert.equal(preview.filter(item => item.status === 'valid').length, 99);
  assert.equal(preview.filter(item => item.status === 'duplicate').length, 2);
  assert.equal(preview.filter(item => item.status === 'invalid').length, 1);
});

test('建立連結收藏可搜尋分類、來源、標籤與 Codex 摘要', () => {
  const entry = validatedEntry({
    ...createEntry({ url: 'https://youtube.com/watch?v=a&utm_medium=x', title: '好看的設計', tags: ['設計'] }),
    category: '工作參考', aiSuggestion: { analysisStatus: 'completed', summary: '配色案例', confidence: 'high' }
  });
  assert.equal(entry.normalizedUrl, 'https://youtube.com/watch?v=a');
  assert.equal(entry.type, '影片');
  assert.ok(matchesEntry(entry, '工作 配色 youtube'));
});

test('相同快速收件工作在租約重試與不同裝置上產生相同收藏 ID', () => {
  const job = { id: 'capture_stable-job-1', url: 'https://example.com/story', originalUrl: 'https://example.com/story?utm_source=share', text: '值得收藏 https://example.com/story?utm_source=share', title: '範例', createdAt: Date.parse('2026-10-18T00:00:00Z') };
  const iphone = createCaptureEntry(job); const windows = createCaptureEntry(job);
  assert.equal(iphone.id, job.id); assert.equal(windows.id, job.id); assert.deepEqual(iphone, windows);
  assert.equal(iphone.note, '值得收藏');
});

test('圖片 metadata、雜湊與大小會驗證，原始 Blob 不進 entry', async () => {
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'sample.png', { type: 'image/png' });
  const hash = await sha256(file);
  const entry = createImageEntry(file, hash, 'att-test');
  assert.equal(entry.kind, 'image');
  assert.equal(entry.attachment.size, 4);
  assert.equal(entry.attachment.hash.length, 64);
  assert.equal('blob' in entry, false);
  assert.throws(() => validatedEntry({ kind: 'image', attachment: { id: 'bad', name: 'x.exe', size: 1, mimeType: 'application/octet-stream' } }));
  assert.throws(() => validatedEntry({ kind: 'image', attachment: { id: 'big', name: 'x.png', size: 26 * 1024 * 1024, mimeType: 'image/png' } }));
});

test('圖片內容簽章必須符合宣告 MIME', () => {
  assert.equal(hasValidImageSignature(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'), true);
  assert.equal(hasValidImageSignature(new TextEncoder().encode('not really png'), 'image/png'), false);
  assert.equal(hasValidImageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'), true);
});

test('v1 localStorage 遷移保留有效資料且不修改來源', () => {
  const source = JSON.stringify([{ id: 'legacy-1', url: 'https://example.com/a', title: 'Legacy' }, { url: 'bad' }]);
  const storage = { getItem: key => key ? source : null };
  const migration = readLegacyEntries(storage);
  assert.equal(migration.entries.length, 1);
  assert.equal(migration.entries[0].id, 'legacy-1');
  assert.equal(migration.errors.length, 1);
  assert.equal(storage.getItem('still-there'), source);
});

test('容量不足與儲存權限錯誤會轉成可行動提示', () => {
  assert.match(storageError({ name: 'QuotaExceededError' }).message, /空間不足.*資料未變更/);
  assert.match(storageError({ name: 'UnknownError', message: 'denied' }).message, /私密瀏覽|權限限制/);
});

test('v1 與 v2 JSON 備份都能讀取，v2 可完整往返', () => {
  const entry = createEntry({ url: 'https://example.com/a', note: '原始備註' });
  const legacy = readBackup(JSON.stringify({ app: 'Pocket Archive', version: 1, entries: [entry] }));
  assert.equal(legacy.entries.length, 1);
  const envelope = createBackupEnvelope([entry], '2026-10-17T00:00:00Z');
  const restored = readBackup(JSON.stringify(envelope));
  assert.deepEqual(restored.entries, [entry]);
  assert.equal(restored.schema_version, SCHEMA_VERSION);
});

test('備份拒絕錯誤 JSON、版本、重複 ID 與過量筆數', () => {
  assert.throws(() => readBackup('{x'));
  assert.throws(() => readBackup(JSON.stringify({ format: 'pocket-archive-backup', schema_version: 999, items: [] })));
  const entry = createEntry({ url: 'https://example.com/a' });
  assert.throws(() => readBackup(JSON.stringify({ ...createBackupEnvelope([entry]), items: [entry, entry] })), /重複 ID/);
});

test('合併預覽分辨 URL、圖片 hash、相同 ID 與衝突，不覆寫既有資料', () => {
  const first = createEntry({ url: 'https://example.com/a', title: 'First' });
  const sameUrl = createEntry({ url: 'https://example.com/a?utm_source=x' });
  const conflict = { ...first, title: 'Changed' };
  const add = createEntry({ url: 'https://example.com/b' });
  const preview = previewMerge([first], [sameUrl, conflict, add]);
  assert.equal(preview.add.length, 1);
  assert.equal(preview.skip.length, 1);
  assert.equal(preview.conflicts.length, 1);
  const merged = mergeEntries([first], [sameUrl, conflict, add]);
  assert.equal(merged.entries.find(item => item.id === first.id).title, 'First');
});

test('Codex inbox schema 有 export_id 且不含 Blob', () => {
  const entry = createEntry({ url: 'https://example.com/a', note: 'note' });
  const envelope = createInboxEnvelope([entry], 'export-known', '2026-10-17T00:00:00Z');
  assert.equal(envelope.format, 'pocket-archive-inbox');
  assert.equal(envelope.export_id, 'export-known');
  assert.equal(envelope.items[0].id, entry.id);
  assert.equal(JSON.stringify(envelope).includes('blob:'), false);
});

test('organized 結果嚴格檢查版本、export_id、未知 ID、重複 ID 與欄位', () => {
  const entry = createEntry({ url: 'https://example.com/a' });
  const base = { format: 'pocket-archive-organized', schema_version: SCHEMA_VERSION, source_export_id: 'export-known' };
  assert.throws(() => readOrganized({ ...base, items: [] }, { exportIds: ['other'], entries: [entry] }), /source_export_id/);
  assert.throws(() => readOrganized({ ...base, schema_version: 1, items: [] }, { exportIds: ['export-known'], entries: [entry] }), /版本/);
  const result = readOrganized({ ...base, items: [
    { id: entry.id, analysis_status: 'completed', suggested_categories: ['閱讀'], suggested_tags: ['測試'], summary: 'Grounded', reason: 'visible title', confidence: 'high' },
    { id: 'unknown', analysis_status: 'insufficient_data', suggested_categories: [], suggested_tags: [], summary: '', reason: 'unavailable', confidence: 'low' },
    { id: 'broken', analysis_status: 'made-up', confidence: 'high' }
  ] }, { exportIds: ['export-known'], entries: [entry] });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 2);
});

test('Codex 建議只改允許欄位，可單次還原且保留 URL、備註、附件', () => {
  const entry = createEntry({ url: 'https://example.com/a', note: '不可覆寫', tags: ['原有'] });
  const suggestion = { id: entry.id, analysisStatus: 'completed', categories: ['研究'], tags: ['新增'], summary: '摘要', reason: '理由', confidence: 'medium' };
  const result = applySuggestions([entry], [suggestion], [entry.id], '2026-10-17T01:00:00Z');
  const updated = result.entries[0];
  assert.equal(updated.url, entry.url);
  assert.equal(updated.note, '不可覆寫');
  assert.deepEqual(updated.tags, ['原有', '新增']);
  assert.equal(updated.status, 'saved');
  assert.deepEqual(restoreSnapshot(result.entries, result.snapshot), [entry]);
});

test('所有使用者字串可安全放入 HTML', () => {
  assert.equal(escapeHtml('<img src=x onerror="bad">'), '&lt;img src=x onerror=&quot;bad&quot;&gt;');
  assert.equal(escapeHtml("' & <script>"), '&#39; &amp; &lt;script&gt;');
});
