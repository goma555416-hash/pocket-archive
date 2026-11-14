// Local (per-device) AI job helpers kept for legacy jobs and the manual file flow.
export function cloudAiJobForReview(jobs, exportId = '') {
  if (exportId) {
    const job = jobs.find(item => item.exportId === exportId);
    if (!job) throw new Error('指定的 AI 批次不存在；不改選其他工作');
    return job;
  }
  return jobs.find(item => item.status !== 'applied') || null;
}

// After a batch is applied (from Drive or a local organized.json), close its
// cloud job so it no longer shows as pending. Returns a new array.
export function markCloudJobApplied(jobs, exportId) {
  if (!exportId) return { jobs, changed: false };
  let changed = false;
  const next = jobs.map(job => {
    if (job.exportId !== exportId || job.status === 'applied') return job;
    changed = true;
    return { ...job, status: 'applied' };
  });
  return { jobs: next, changed };
}
