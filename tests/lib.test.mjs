import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, cleanTags, createEntry, readBackup, mergeEntries, matchesEntry, extractIncomingShare, escapeHtml } from '../lib.mjs';

test('網址規範化，移除追蹤參數但保留重要參數', () => {
  assert.equal(normalizeUrl('https://example.com/p/?utm_source=mail&z=2&a=1#hello'),'https://example.com/p?a=1&z=2');
  assert.equal(normalizeUrl('example.com/'),'https://example.com/');
});
test('拒絕非 http(s) 與錯誤網址', () => {
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
  assert.throws(() => normalizeUrl('not a url'));
});
test('清理重複標籤', () => {
  assert.deepEqual(cleanTags('設計,設計，靈感、遊戲'),['設計','靈感','遊戲']);
});
test('分享文字可抽出 URL 與備註', () => {
  const p = extractIncomingShare('?title=Hello&text=%E6%94%B6%E8%97%8F%20https%3A%2F%2Fexample.com%2Fpost');
  assert.equal(p.url,'https://example.com/post');
  assert.equal(p.title,'Hello');
  assert.equal(p.note,'收藏');
});
test('建立收藏、搜尋、備份匯入去重', () => {
  const e = createEntry({url:'https://example.com/a?utm_medium=abc', title:'好看的設計',tags:['設計'],type:'圖片'});
  assert.equal(e.normalizedUrl,'https://example.com/a');
  assert.ok(matchesEntry(e,'好看 設計'));
  const backup = JSON.stringify({app:'Pocket Archive',version:1,entries:[e,{...e,id:'other',url:'https://example.com/a',normalizedUrl:'https://example.com/a'}]});
  const imported = readBackup(backup);
  assert.equal(mergeEntries([],imported).added,1);
  assert.equal(mergeEntries([e],imported).added,0);
});
test('拒絕不正確備份', () => {
  assert.throws(() => readBackup('{x')); assert.throws(() => readBackup(JSON.stringify({entries:[]})));
});
test('所有使用者字串需可安全顯示', () => {
  assert.equal(escapeHtml('<img src=x onerror="bad">'), '&lt;img src=x onerror=&quot;bad&quot;&gt;');
});
