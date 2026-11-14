import test from 'node:test';
import assert from 'node:assert/strict';
import { aiJobStatusView, currentAiJob, hasReadyAiJob, reviewExportIds } from '../ai-jobs-client.mjs';

const job = (status, extra = {}) => ({ exportId: `export-${status}`, status, itemCount: 3, createdAt: 1, failureMessage: null, ...extra });

test('aiJobStatusView labels every status and only failed can retry', () => {
  const expect = {
    queued: ['busy', '排隊中', false], running: ['busy', '整理中…', false], ready: ['ready', '有結果可查看', false],
    failed: ['error', '整理失敗', true], applied: ['done', '已套用', false]
  };
  for (const [status, [tone, label, canRetry]] of Object.entries(expect)) {
    const view = aiJobStatusView(job(status));
    assert.equal(view.tone, tone, status);
    assert.equal(view.label, label, status);
    assert.equal(view.canRetry, canRetry, status);
    assert.equal(typeof view.detail, 'string');
  }
  assert.match(aiJobStatusView(job('failed', { failureMessage: '觸發失敗' })).detail, /觸發失敗/);
  assert.equal(aiJobStatusView(null).tone, 'idle');
});

test('currentAiJob prefers ready, then running, then queued, then newest failed', () => {
  assert.equal(currentAiJob([job('failed'), job('running'), job('ready')]).status, 'ready');
  assert.equal(currentAiJob([job('failed'), job('queued'), job('running')]).status, 'running');
  assert.equal(currentAiJob([job('failed'), job('queued')]).status, 'queued');
  assert.equal(currentAiJob([job('failed', { exportId: 'old', createdAt: 1 }), job('failed', { exportId: 'new', createdAt: 9 })]).exportId, 'new');
  assert.equal(currentAiJob([job('applied'), job('applied')]), null);
  assert.equal(currentAiJob([]), null);
});

test('hasReadyAiJob and reviewExportIds', () => {
  assert.equal(hasReadyAiJob([job('running'), job('ready')]), true);
  assert.equal(hasReadyAiJob([job('applied')]), false);
  assert.deepEqual(reviewExportIds(['a'], { exportId: 'a' }), ['a']);
  assert.deepEqual(reviewExportIds(['a'], { exportId: 'b' }), ['a', 'b']);
  assert.equal(reviewExportIds(Array.from({ length: 60 }, (_, i) => `x${i}`), { exportId: 'b' }).length, 51);
  assert.ok(reviewExportIds(Array.from({ length: 60 }, (_, i) => `x${i}`), { exportId: 'b' }).includes('b'));
});
