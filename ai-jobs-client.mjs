// Pure helpers for cloud AI job state shown in the App. Jobs come from the
// Worker (GET /api/ai/jobs) and contain routing IDs and status only.
const LABELS = {
  queued: ['busy', '排隊中'],
  running: ['busy', '整理中…'],
  ready: ['ready', '有結果可查看'],
  failed: ['error', '整理失敗'],
  applied: ['done', '已套用']
};

function timeText(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

export function aiJobStatusView(job) {
  if (!job || !LABELS[job.status]) return { tone: 'idle', label: '', detail: '', canRetry: false };
  const [tone, label] = LABELS[job.status];
  const count = `${job.itemCount || 0} 筆`;
  let detail = count;
  if (job.status === 'queued') detail = `${count}，等前一批整理完成`;
  if (job.status === 'running') detail = `${timeText(job.startedAt || job.createdAt)} 開始，${count}`;
  if (job.status === 'ready') detail = `${count}，請逐項預覽後勾選套用`;
  if (job.status === 'failed') detail = job.failureMessage ? `原因：${job.failureMessage}` : '原因不明，可重試';
  return { tone, label, detail, canRetry: job.status === 'failed' };
}

export function currentAiJob(jobs = []) {
  for (const status of ['ready', 'running', 'queued']) {
    const found = jobs.find(job => job.status === status);
    if (found) return found;
  }
  const failed = jobs.filter(job => job.status === 'failed').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return failed[0] || null;
}

export function hasReadyAiJob(jobs = []) { return jobs.some(job => job.status === 'ready'); }

export function reviewExportIds(localIds = [], job) {
  const ids = localIds.filter(id => id !== job?.exportId).slice(0, 50);
  return job?.exportId ? [...ids, job.exportId] : ids;
}
