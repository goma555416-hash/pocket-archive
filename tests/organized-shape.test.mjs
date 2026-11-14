import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOrganizedForJob } from '../organized-shape.mjs';

const exportId = 'export-shape-test';
const at = '2026-11-14T10:00:00.000Z';
const body = '文章逐段討論排版、視覺閱讀順序以及不同版面密度如何影響使用者的閱讀體驗，提供具體設計案例與改善建議。'.repeat(2);
const completed = id => ({
  id, analysis_status: 'completed', suggested_categories: [], suggested_tags: ['排版'],
  summary: '根據正文撰寫的摘要。', reason: '正文', confidence: 'medium',
  evidence: { status: 'content_read', kind: 'article_body', source_url: 'https://any.example/not-the-entry', excerpt: body, observed_at: at }
});
const insufficient = id => ({
  id, analysis_status: 'insufficient_data', suggested_categories: [], suggested_tags: [],
  summary: '', reason: '只有標題', confidence: 'low',
  evidence: { status: 'metadata_only', kind: 'metadata', source_url: '', excerpt: '', observed_at: at }
});
const doc = (items, extra = {}) => JSON.stringify({ format: 'pocket-archive-organized', schema_version: 2, source_export_id: exportId, items, ...extra });
const job = { exportId, itemIds: ['a', 'b'] };
const code = (text, options = job) => { try { checkOrganizedForJob(text, options); return 'ok'; } catch (error) { return error.code; } };

test('valid result passes without comparing against collection content', () => {
  const result = checkOrganizedForJob(doc([completed('a'), insufficient('b')]), job);
  assert.equal(result.items.length, 2);
});

test('size, JSON, schema and export id are enforced', () => {
  assert.equal(code('x'.repeat(2 * 1024 * 1024 + 1)), 'result_too_large');
  assert.equal(code('{'), 'result_invalid_json');
  assert.equal(code(doc([completed('a'), insufficient('b')], { schema_version: 1 })), 'result_schema');
  assert.equal(code(doc([completed('a'), insufficient('b')], { format: 'other' })), 'result_schema');
  assert.equal(code(doc([completed('a'), insufficient('b')], { source_export_id: 'export-other' })), 'result_export_mismatch');
});

test('item ids must match the job one-to-one', () => {
  assert.equal(code(doc([completed('a')])), 'result_ids_mismatch');
  assert.equal(code(doc([completed('a'), insufficient('b'), insufficient('c')])), 'result_ids_mismatch');
  assert.equal(code(doc([completed('a'), insufficient('a')])), 'result_ids_mismatch');
});

test('evidence is required and must be internally consistent', () => {
  const missing = completed('a'); delete missing.evidence;
  assert.equal(code(doc([missing, insufficient('b')])), 'result_evidence');
  const readButInsufficient = { ...completed('a'), analysis_status: 'insufficient_data' };
  assert.equal(code(doc([readButInsufficient, insufficient('b')])), 'result_evidence');
  const metadataWithTags = { ...insufficient('b'), suggested_tags: ['排版'] };
  assert.equal(code(doc([completed('a'), metadataWithTags])), 'result_evidence');
  const shortExcerpt = completed('a'); shortExcerpt.evidence = { ...shortExcerpt.evidence, excerpt: '太短' };
  assert.equal(code(doc([shortExcerpt, insufficient('b')])), 'result_evidence');
});
