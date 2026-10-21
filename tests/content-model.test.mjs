import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContent, TYPES, mergeTopicTags, inputTags, compatibilityPending } from '../content-model.mjs';
import { createEntry, validatedEntry, readBackup, createBackupEnvelope, createInboxEnvelope, parseBatchUrls, readOrganized, applySuggestions, restoreSnapshot, matchesEntry, sha256, createImageEntry } from '../lib.mjs';
import { createZip, readZip, decodeText } from '../archive.mjs';
import { createJournal, readJournal, makeUpsertRecord, reconcileReplica, resolveConflict } from '../sync.mjs';

const fixtures = [
  ['https://www.youtube.com/watch?v=abc123&si=share', '影片', 'verified'],
  ['https://youtu.be/abc123?si=share', '影片', 'verified'],
  ['https://m.youtube.com/shorts/abc123', '影片', 'verified'],
  ['https://www.youtube.com/@example', '網頁', 'provisional'],
  ['https://youtube.com/channel/UC123', '網頁', 'provisional'],
  ['https://youtube.com/watch', '網頁', 'provisional'],
  ['https://instagram.com/reel/abc123/', '影片', 'verified'],
  ['https://instagram.com/p/image123/', '社群', 'provisional'],
  ['https://instagram.com/p/carousel123/', '社群', 'provisional'],
  ['https://x.com/example/status/123', '社群', 'provisional'],
  ['https://twitter.com/example/status/123', '社群', 'provisional'],
  ['https://www.threads.net/@example/post/123', '社群', 'provisional'],
  ['https://threads.com/@example/post/123', '社群', 'provisional'],
  ['https://www.tiktok.com/@example/video/123456', '影片', 'verified'],
  ['https://pinterest.com/pin/123', '社群', 'provisional'],
  ['https://i.pinimg.com/originals/public.png', '圖片', 'verified'],
  ['https://example.org/a.jpg?download=1', '圖片', 'verified'],
  ['https://example.org/video.mp4', '影片', 'verified'],
  ['https://example.org/article/story/', '網頁', 'provisional'],
  ['https://example.org/tools/', '網頁', 'provisional'],
  ['https://example.org/', '網頁', 'provisional'],
  ['https://youtube.com.evil.example/watch?v=abc', '網頁', 'provisional'],
  ['https://notyoutube.com/watch?v=abc', '網頁', 'provisional'],
  ['https://x.com.evil.example/status/123', '網頁', 'provisional'],
  ['https://instagram.com@evil.example/reel/123', '網頁', 'provisional'],
  ['javascript:alert(1)', '網頁', 'provisional'],
  ['not a URL', '網頁', 'provisional']
];
for (const [url, type, status] of fixtures) test(`形式辨識 ${url}`, () => {
  const result = classifyContent({ url, title: '影片圖片遊戲', metadata: null });
  assert.equal(result.type, type); assert.equal(result.classification.status, status);
  assert.ok(TYPES.includes(result.type));
});

test('實際讀到結構化主要媒體可確認 IG 圖片與 X 影片；縮圖、輪播、錯頁 metadata 不夠', () => {
  const url = 'https://instagram.com/p/123';
  const metadata = { pageUrl: url, ogType: 'image', mediaUrl: 'https://cdn.example.org/photo.jpg' };
  assert.equal(classifyContent({ url, metadata }).type, '圖片');
  assert.equal(classifyContent({ url, metadata: { ...metadata, mixed: true } }).type, '社群');
  assert.equal(classifyContent({ url, metadata: { ...metadata, pageUrl: 'https://example.org/' } }).type, '社群');
  assert.equal(classifyContent({ url, metadata: { ...metadata, ogType: 'article' } }).type, '社群');
  assert.equal(classifyContent({ url, metadata: { ...metadata, mediaUrl: 'javascript:alert(1)' } }).type, '社群');
  const x = 'https://x.com/example/status/123';
  assert.equal(classifyContent({ url: x, metadata: { pageUrl: x, ogType: 'video.other', mediaUrl: 'https://cdn.example.org/clip.mp4' } }).type, '影片');
  assert.equal(classifyContent({ url: x, title: '影片', metadata: { pageUrl: x, ogType: 'video.other', mediaUrl: '' } }).type, '社群');
});

test('人工類型優先於原圖與 URL，原圖建立在驗證邊界後；還原不把附件 metadata 當作新證據', () => {
  assert.equal(classifyContent({ manualType: '網頁', validatedImage: true, url: 'https://youtu.be/123' }).type, '網頁');
  assert.equal(classifyContent({ validatedImage: true }).classification.status, 'verified');
  assert.equal(validatedEntry({ kind: 'image', type: '圖片' }).classification.status, 'provisional');
});

for (const [old, expected] of [['文章', '網頁'], ['影片', '影片'], ['社群貼文', '社群'], ['圖片', '圖片'], ['遊戲', '網頁'], ['香水', '網頁'], ['工具', '網頁'], ['其他', '網頁']]) {
  test(`舊 ${old} 保留來源、冪等投影與主題標籤`, () => {
    const source = { id: `legacy-${old.length}-${expected.length}`, url: 'https://example.org/page', type: old, category: '工作知識', tags: ['原有'], note: '不可丟失', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z' };
    const value = validatedEntry(source);
    assert.equal(value.type, expected); assert.equal(value.classification.status, 'provisional');
    assert.equal(value.legacyType, ['影片', '圖片'].includes(old) ? '' : old);
    assert.equal(value.category, source.category); assert.ok(value.tags.includes(source.category));
    if (['遊戲', '香水', '工具'].includes(old)) assert.ok(value.tags.includes(old));
    assert.equal(value.note, source.note); assert.equal(value.createdAt, source.createdAt); assert.equal(value.updatedAt, source.updatedAt);
    assert.deepEqual(validatedEntry(value), value); assert.deepEqual(source.tags, ['原有']);
  });
}

test('舊主題不能猜為圖片；可信 URL 才重判，已重複主題不重加', () => {
  const image = validatedEntry({ type: '遊戲', url: 'https://example.org/metrics.png', category: '遊戲', tags: ['遊戲'] });
  assert.equal(image.type, '圖片'); assert.deepEqual(image.tags, ['遊戲']);
  const unknown = validatedEntry({ type: '遊戲', url: 'https://example.org/metrics', title: '數據圖片' });
  assert.equal(unknown.type, '網頁'); assert.equal(unknown.classification.status, 'provisional');
});

test('標籤上限及超長分類不截斷，原欄位可追溯；歷史超限標籤完整保留', () => {
  const tags = Array.from({ length: 24 }, (_, i) => `tag-${i}`);
  const category = '舊'.repeat(81);
  const value = validatedEntry({ type: '工具', category, tags, url: 'https://example.org/' });
  assert.deepEqual(value.tags, tags); assert.equal(value.category, category); assert.equal(value.legacyType, '工具');
  assert.deepEqual(compatibilityPending(value), ['工具', category]);
  assert.deepEqual(validatedEntry(value), value);
  const excess = [...tags, '長'.repeat(50)];
  const historical = validatedEntry({ ...value, tags: excess });
  assert.deepEqual(historical.tags, excess); assert.deepEqual(inputTags(excess, excess), excess);
  assert.throws(() => inputTags([...excess, '新'], excess), /最多/);
  assert.throws(() => inputTags('長'.repeat(33)), /32/);
  assert.deepEqual(mergeTopicTags(tags, ['標籤']).pending, ['標籤']);
});

test('網頁子類型與人工類型在備份、inbox、同步保持 schema v2', () => {
  for (const webpageKind of ['', 'article', 'site', 'other']) {
    const entry = createEntry({ url: 'https://example.org/resource/portal', type: '網頁', webpageKind });
    assert.equal(entry.classification.status, 'manual');
    assert.deepEqual(readBackup(JSON.stringify(createBackupEnvelope([entry]))).entries, [entry]);
    const inbox = createInboxEnvelope([entry], 'synthetic');
    assert.equal(inbox.schema_version, 2); assert.equal(inbox.items[0].webpageKind, webpageKind);
    const replica = makeUpsertRecord(entry, 'iphone');
    const journal = readJournal(JSON.stringify(createJournal('iphone', { [entry.id]: replica.record })));
    const synced = reconcileReplica([], {}, journal.records).entries[0];
    assert.equal(synced.webpageKind, webpageKind); assert.equal(synced.classification.status, 'manual');
  }
});

test('v1 JSON 與 v2 舊 ZIP 還原保留 legacy、分類、AI 摘要及原圖 bytes', async () => {
  const raw = { id: 'old-json', url: 'https://example.org/story', type: '香水', category: '香氛研究', note: '原始筆記', tags: ['心得'], aiSuggestion: { summary: '舊摘要', analysisStatus: 'completed', categories: ['歷史建議'], tags: ['歷史標籤'], appliedAt: '2026-10-17T00:00:00Z' } };
  const legacy = readBackup(JSON.stringify({ app: 'Pocket Archive', version: 1, entries: [raw] })).entries[0];
  assert.equal(legacy.aiSuggestion.summary, '舊摘要'); assert.ok(legacy.tags.includes('香水'));
  const file = new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'synthetic.png', { type: 'image/png' });
  const image = createImageEntry(file, await sha256(file), 'old-image');
  const oldTopicImage = validatedEntry({ ...image, type: '遊戲', classification: undefined });
  assert.equal(oldTopicImage.type, '圖片'); assert.ok(oldTopicImage.tags.includes('遊戲'));
  assert.equal(oldTopicImage.classification.status, 'provisional', '附件 metadata 不冒充重新驗證原檔');
  const { classification, webpageKind, legacyType, ...oldImage } = image;
  const envelope = { format: 'pocket-archive-backup', schema_version: 2, items: [raw, oldImage] };
  const zip = await createZip([{ name: 'backup.json', data: JSON.stringify(envelope) }, { name: image.attachment.path, data: file }]);
  const files = await readZip(zip); const restored = readBackup(decodeText(files.get('backup.json'))).entries;
  assert.equal(restored[0].category, raw.category); assert.equal(restored[0].note, raw.note);
  assert.equal(restored[1].attachment.hash, image.attachment.hash);
  assert.equal(await sha256(files.get(image.attachment.path)), image.attachment.hash);
  assert.deepEqual(validatedEntry(restored[1]), restored[1]);
});

test('舊客戶端因果較新或並行的自動類型都不能無聲覆寫人工類型', () => {
  const original = createEntry({ url: 'https://instagram.com/p/123', type: '圖片', webpageKind: 'site' });
  const local = makeUpsertRecord(original, 'iphone');
  const { classification, webpageKind, legacyType, ...old } = local.entry;
  const oldRemote = makeUpsertRecord({ ...old, type: '社群貼文', title: '舊版修改' }, 'windows');
  for (const clock of [oldRemote.record.clock, { windows: 1 }]) {
    const remote = { ...oldRemote.record, clock };
    const merged = reconcileReplica([local.entry], {}, [remote]);
    assert.equal(merged.entries[0].type, '圖片'); assert.equal(merged.entries[0].webpageKind, 'site');
    assert.equal(merged.conflicts.length, 1); assert.equal(merged.conflicts[0].chosen, 'local');
    const resolved = resolveConflict(merged.conflicts[0], 'local', 'iphone');
    assert.equal(resolved.entry.classification.status, 'manual');
  }
});

test('AI v2.3.1 結果相容：主題進標籤、手動形式與原欄位保留、逐項套用可復原', () => {
  const entry = createEntry({ url: 'https://example.org/', type: '網頁', webpageKind: 'site', note: '原始', category: '舊分類' });
  const envelope = { format: 'pocket-archive-organized', schema_version: 2, source_export_id: 'old-export', items: [{ id: entry.id, analysis_status: 'completed', suggested_categories: ['舊 AI 主題'], suggested_tags: ['新主題'], suggested_type: '圖片', url: 'https://evil.example/', note: '不應套用', summary: '合成摘要', reason: '可見標題', confidence: 'low' }] };
  const parsed = readOrganized(envelope, { exportIds: ['old-export'], entries: [entry] });
  assert.equal(parsed.rejected.length, 0);
  assert.equal(applySuggestions([entry], parsed.accepted, []).applied, 0);
  const applied = applySuggestions([entry], parsed.accepted);
  const value = applied.entries[0];
  assert.equal(value.type, entry.type); assert.deepEqual(value.classification, entry.classification); assert.equal(value.webpageKind, 'site');
  assert.equal(value.category, entry.category); assert.equal(value.url, entry.url); assert.equal(value.note, entry.note);
  assert.deepEqual(value.tags, ['舊分類', '舊 AI 主題', '新主題']);
  assert.ok(matchesEntry(value, '舊 AI 主題'));
  assert.deepEqual(restoreSnapshot(applied.entries, applied.snapshot), [entry]);
});

test('AI 標籤超限保留整份建議；insufficient_data 不改已整理狀態', () => {
  const entry = createEntry({ url: 'https://example.org/', tags: Array.from({ length: 24 }, (_, i) => `tag${i}`) });
  const suggestion = { id: entry.id, categories: ['保留分類'], tags: ['保留標籤'], analysisStatus: 'insufficient_data', reason: 'CORS', confidence: 'low' };
  const applied = applySuggestions([entry], [suggestion]).entries[0];
  assert.equal(applied.status, 'inbox'); assert.deepEqual(applied.tags, entry.tags);
  assert.deepEqual(applied.aiSuggestion.categories, suggestion.categories); assert.deepEqual(applied.aiSuggestion.tags, suggestion.tags);
  assert.deepEqual(compatibilityPending(applied), ['保留分類', '保留標籤']);
});

test('單筆與批次採相同四類語意，不把推斷當人工選擇', () => {
  const rows = parseBatchUrls(fixtures.filter(([url]) => url.startsWith('https:') && !url.includes('@evil')).map(([url]) => url).join('\n'));
  for (const row of rows.filter(row => row.status === 'valid')) {
    const entry = createEntry({ url: row.normalizedUrl, originalUrl: row.input });
    assert.equal(entry.type, row.type); assert.notEqual(entry.classification.status, 'manual');
  }
});
