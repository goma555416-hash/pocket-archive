// Cloud AI organize jobs: agent credentials, job queue, Claude routine
// trigger and the agent API. D1 stores routing IDs, hashes and status only.
import { randomToken, safeEqual, sha256Text } from './security.mjs';
import { checkOrganizedForJob } from '../../organized-shape.mjs';
import { TEXT_KINDS } from '../../content-evidence.mjs';

const AGENT_TOKEN = /^Bearer\s+pa_agent_([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{32,128})$/;
const DAY = 86_400_000;
const AGENT_RATE_PER_MINUTE = 60;
const RUNNING_TIMEOUT = 60 * 60_000;
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,version,appProperties,parents,trashed';
const EXPORT_ID = /^export-[A-Za-z0-9._:-]{1,110}$/;
const FILE_ID = /^[A-Za-z0-9_-]{4,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function publicJob(row) {
  if (!row) return null;
  return {
    exportId: row.export_id, status: row.status, itemCount: row.item_count, itemIds: JSON.parse(row.item_ids),
    inboxFileId: row.inbox_file_id, resultFileId: row.result_file_id, attempt: row.attempt_count,
    failureCode: row.failure_code ?? null, failureMessage: row.failure_message ?? null, sessionUrl: row.session_url ?? null,
    createdByDevice: row.created_by_device, createdAt: row.created_at, startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null
  };
}

export function aiJobService({ env, now, driveFetch, fetchImpl, httpError }) {
  const db = env.DB;

  async function createCredential(userId, { name, expiresInDays } = {}) {
    const createdAt = now();
    const label = String(name || 'Claude 雲端整理').trim().slice(0, 80) || 'Claude 雲端整理';
    const requested = Number(expiresInDays ?? 90);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(365, requested)) : 90;
    const id = randomToken(12); const secret = randomToken(32);
    const expiresAt = createdAt + days * DAY;
    await db.prepare('INSERT INTO ai_agent_credentials (id,user_id,token_hash,name,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .bind(id, userId, await sha256Text(secret), label, createdAt, expiresAt).run();
    return { credential: { id, name: label, createdAt, expiresAt, scope: 'ai:agent' }, token: `pa_agent_${id}.${secret}` };
  }

  async function listCredentials(userId) {
    const result = await db.prepare('SELECT id,name,created_at,last_used_at,expires_at,revoked_at FROM ai_agent_credentials WHERE user_id=? ORDER BY created_at DESC LIMIT 30').bind(userId).all();
    return (result.results || []).map(item => ({ id: item.id, name: item.name, createdAt: item.created_at, lastUsedAt: item.last_used_at, expiresAt: item.expires_at, revoked: Boolean(item.revoked_at) }));
  }

  async function revokeCredential(userId, id) {
    const result = await db.prepare('UPDATE ai_agent_credentials SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').bind(now(), id, userId).run();
    return Boolean(Number(result.meta?.changes || 0));
  }

  async function authenticateAgent(request) {
    if ([...new URL(request.url).searchParams.keys()].some(key => /token|auth|key|secret/i.test(key))) throw httpError(400, 'credential_in_query', '憑證不可放在 URL query');
    const match = AGENT_TOKEN.exec(request.headers.get('Authorization') || '');
    if (!match) throw httpError(401, 'agent_unauthorized', 'AI 代理憑證無效或缺少');
    const at = now();
    const credential = await db.prepare('SELECT * FROM ai_agent_credentials WHERE id=?').bind(match[1]).first();
    if (!credential || credential.revoked_at || Number(credential.expires_at) <= at || !safeEqual(credential.token_hash, await sha256Text(match[2]))) {
      throw httpError(401, 'agent_unauthorized', 'AI 代理憑證已失效，請在 Pocket Archive 重新建立');
    }
    const windowStart = Math.floor(at / 60_000) * 60_000;
    await db.prepare('INSERT INTO ai_agent_rate_limits (credential_id,window_start,request_count) VALUES (?,?,1) ON CONFLICT(credential_id,window_start) DO UPDATE SET request_count=request_count+1').bind(credential.id, windowStart).run();
    const rate = await db.prepare('SELECT request_count FROM ai_agent_rate_limits WHERE credential_id=? AND window_start=?').bind(credential.id, windowStart).first();
    if (Number(rate?.request_count || 0) > AGENT_RATE_PER_MINUTE) throw httpError(429, 'rate_limited', 'AI 代理呼叫過於頻繁，請稍後重試');
    await db.prepare('UPDATE ai_agent_credentials SET last_used_at=? WHERE id=?').bind(at, credential.id).run();
    return credential;
  }

  function configured() { return Boolean(env.AI_ROUTINE_FIRE_URL && env.AI_ROUTINE_FIRE_TOKEN); }

  const jobRow = (userId, exportId) => db.prepare('SELECT * FROM ai_jobs WHERE export_id=? AND user_id=?').bind(exportId, userId).first();

  async function driveMeta(userId, id) {
    const response = await driveFetch({ user_id: userId }, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw httpError(503, 'drive_unavailable', 'Google Drive 暫時無法讀取，請稍後再試');
    return response.json();
  }

  // The placeholder is still the file we registered (or last wrote ourselves).
  function placeholderUnchanged(placeholder, job) {
    const binding = { exportId: job.export_id, inboxFileId: job.inbox_file_id, resultsFolderId: job.results_folder_id };
    return resultBindingOk(placeholder, binding) && placeholder.version === job.result_version && placeholder.md5Checksum === job.result_md5;
  }

  function validateCreateBody(body) {
    const bad = message => httpError(400, 'invalid_ai_job', message);
    if (!body || typeof body !== 'object') throw bad('AI 工作內容無效');
    if (!EXPORT_ID.test(body.exportId || '')) throw bad('export_id 無效');
    for (const key of ['inboxFileId', 'resultFileId', 'inboxFolderId', 'resultsFolderId']) if (!FILE_ID.test(body[key] || '')) throw bad(`${key} 無效`);
    if (!SHA256.test(body.inboxSha256 || '') || !SHA256.test(body.pendingSha256 || '')) throw bad('SHA-256 無效');
    const ids = body.itemIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 128) || new Set(ids).size !== ids.length) throw bad('項目 ID 無效');
    return { ...body, deviceId: typeof body.deviceId === 'string' ? body.deviceId.slice(0, 80) : '' };
  }

  function resultBindingOk(result, job) {
    return Boolean(result && !result.trashed && result.parents?.includes(job.resultsFolderId) && result.name === `organized-${job.exportId}.json` &&
      result.mimeType === 'application/json' && result.appProperties?.paRole === 'aiResult' && result.appProperties?.exportId === job.exportId &&
      result.appProperties?.inboxFileId === job.inboxFileId);
  }

  async function checkBinding(userId, body) {
    const [inboxFolder, resultsFolder, inbox, result] = await Promise.all([
      driveMeta(userId, body.inboxFolderId), driveMeta(userId, body.resultsFolderId), driveMeta(userId, body.inboxFileId), driveMeta(userId, body.resultFileId)
    ]);
    const exportId = body.exportId;
    const inboxName = inbox?.name || '';
    const ok = inboxFolder && !inboxFolder.trashed && inboxFolder.appProperties?.paRole === 'aiInbox' &&
      resultsFolder && !resultsFolder.trashed && resultsFolder.appProperties?.paRole === 'aiResults' &&
      inbox && !inbox.trashed && inbox.parents?.includes(body.inboxFolderId) &&
      inboxName.startsWith('pocket-archive-inbox-') && (inboxName.endsWith(`-${exportId}.json`) || inboxName.endsWith(`-${exportId}.zip`)) &&
      ['application/json', 'application/zip'].includes(inbox.mimeType) &&
      inbox.appProperties?.paRole === 'aiInbox' && inbox.appProperties?.exportId === exportId && inbox.appProperties?.resultFileId === body.resultFileId &&
      resultBindingOk(result, body) && result.appProperties?.status === 'pending';
    if (!ok) throw httpError(422, 'ai_binding_mismatch', 'AI 批次與結果占位檔的 Drive 綁定不符；停止');
    return { inbox, result };
  }

  async function markFailed(exportId, attempt, code, message) {
    const at = now();
    await db.prepare("UPDATE ai_jobs SET status='failed', failure_code=?, failure_message=?, finished_at=?, updated_at=? WHERE export_id=? AND attempt_count=? AND status='running'")
      .bind(code, String(message || '').slice(0, 300), at, at, exportId, attempt).run();
  }

  async function fire(row) {
    const attempt = row.attempt_count;
    try {
      const response = await fetchImpl(env.AI_ROUTINE_FIRE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.AI_ROUTINE_FIRE_TOKEN}`, 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `export_id=${row.export_id} attempt=${attempt}` })
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const url = typeof data.claude_code_session_url === 'string' && data.claude_code_session_url.startsWith('https://claude.ai/') ? data.claude_code_session_url.slice(0, 300) : null;
        await db.prepare('UPDATE ai_jobs SET session_url=?, updated_at=? WHERE export_id=? AND attempt_count=?').bind(url, now(), row.export_id, attempt).run();
        return true;
      }
      const code = [401, 403].includes(response.status) ? 'routine_unauthorized' : response.status === 429 ? 'routine_rate_limited' : 'routine_unavailable';
      await markFailed(row.export_id, attempt, code, `觸發 Claude 雲端任務失敗（HTTP ${response.status}）`);
    } catch {
      await markFailed(row.export_id, attempt, 'routine_unavailable', '無法連線到 Claude 雲端任務');
    }
    return false;
  }

  async function startNext(userId) {
    for (let guard = 0; guard < 25; guard += 1) {
      const next = await db.prepare("SELECT * FROM ai_jobs WHERE user_id=? AND status='queued' ORDER BY created_at, export_id LIMIT 1").bind(userId).first();
      if (!next) return;
      const at = now();
      const claimed = await db.prepare("UPDATE ai_jobs SET status='running', attempt_count=attempt_count+1, started_at=?, finished_at=NULL, failure_code=NULL, failure_message=NULL, session_url=NULL, updated_at=? WHERE export_id=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM ai_jobs WHERE user_id=? AND status='running')")
        .bind(at, at, next.export_id, userId).run();
      if (!Number(claimed.meta?.changes || 0)) return;
      const row = await jobRow(userId, next.export_id);
      if (await fire(row)) return;
    }
  }

  async function createJob(session, rawBody) {
    if (!configured()) throw httpError(503, 'ai_not_configured', '雲端整理尚未設定');
    const body = validateCreateBody(rawBody);
    const userId = session.user_id;
    const existing = await db.prepare('SELECT * FROM ai_jobs WHERE export_id=?').bind(body.exportId).first();
    if (existing) {
      if (existing.user_id !== userId) throw httpError(409, 'job_conflict', 'export_id 已被使用');
      return { job: publicJob(existing), duplicate: true };
    }
    const { inbox, result } = await checkBinding(userId, body);
    const at = now();
    await db.prepare(`INSERT INTO ai_jobs (export_id,user_id,inbox_file_id,result_file_id,inbox_folder_id,results_folder_id,item_ids,item_count,inbox_sha256,pending_sha256,inbox_md5,inbox_version,result_md5,result_version,status,attempt_count,created_by_device,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?,?)`)
      .bind(body.exportId, userId, body.inboxFileId, body.resultFileId, body.inboxFolderId, body.resultsFolderId, JSON.stringify(body.itemIds), body.itemIds.length,
        body.inboxSha256, body.pendingSha256, inbox.md5Checksum || null, inbox.version || null, result.md5Checksum || null, result.version || null, body.deviceId, at, at).run();
    await startNext(userId);
    return { job: publicJob(await jobRow(userId, body.exportId)), duplicate: false };
  }

  async function listJobs(userId) {
    const result = await db.prepare('SELECT * FROM ai_jobs WHERE user_id=? ORDER BY created_at DESC, export_id DESC LIMIT 20').bind(userId).all();
    return (result.results || []).map(publicJob);
  }

  async function retryJob(session, exportId) {
    const row = await jobRow(session.user_id, exportId);
    if (!row) throw httpError(404, 'job_not_found', '找不到此 AI 整理工作');
    if (row.status !== 'failed') throw httpError(409, 'invalid_state', '只有失敗的工作可以重試');
    if (!placeholderUnchanged(await driveMeta(session.user_id, row.result_file_id), row)) {
      const message = '結果占位檔已被改動或刪除，無法重試；請重新送出，或改用備用手動流程匯入';
      await db.prepare("UPDATE ai_jobs SET failure_code='placeholder_changed', failure_message=?, updated_at=? WHERE export_id=? AND status='failed'").bind(message, now(), exportId).run();
      throw httpError(409, 'placeholder_changed', message);
    }
    await db.prepare("UPDATE ai_jobs SET status='queued', failure_code=NULL, failure_message=NULL, finished_at=NULL, session_url=NULL, updated_at=? WHERE export_id=? AND status='failed'").bind(now(), exportId).run();
    await startNext(session.user_id);
    return publicJob(await jobRow(session.user_id, exportId));
  }

  async function markApplied(userId, exportId) {
    const row = await jobRow(userId, exportId);
    if (!row) throw httpError(404, 'job_not_found', '找不到此 AI 整理工作');
    if (row.status === 'applied') return publicJob(row);
    if (row.status !== 'ready') throw httpError(409, 'invalid_state', '只有已有結果的工作可以標記為已套用');
    await db.prepare("UPDATE ai_jobs SET status='applied', updated_at=? WHERE export_id=? AND status='ready'").bind(now(), exportId).run();
    return publicJob(await jobRow(userId, exportId));
  }

  async function sweep() {
    const at = now();
    const stale = await db.prepare("SELECT export_id, attempt_count FROM ai_jobs WHERE status='running' AND started_at < ?").bind(at - RUNNING_TIMEOUT).all();
    for (const row of stale.results || []) await markFailed(row.export_id, row.attempt_count, 'timeout', 'Claude 雲端任務超過 60 分鐘未回報');
    const users = await db.prepare("SELECT DISTINCT user_id FROM ai_jobs WHERE status='queued'").all();
    for (const row of users.results || []) await startNext(row.user_id);
  }

  async function agentJobRow(credential, exportId, attempt) {
    const job = await jobRow(credential.user_id, exportId);
    if (!job) throw httpError(404, 'job_not_found', '找不到此 AI 整理工作');
    if (job.status !== 'running') throw httpError(409, 'invalid_state', '此 AI 整理工作目前不在整理中');
    if (!Number.isInteger(attempt) || attempt !== job.attempt_count) throw httpError(409, 'stale_attempt', '這是舊的整理嘗試，已被取代');
    return job;
  }

  async function agentGetJob(credential, exportId, attempt) {
    const job = await agentJobRow(credential, exportId, attempt);
    const inbox = await driveMeta(job.user_id, job.inbox_file_id);
    if (!inbox) throw httpError(502, 'drive_unavailable', '無法讀取 AI 批次 metadata');
    return { exportId: job.export_id, attempt: job.attempt_count, itemIds: JSON.parse(job.item_ids), inboxName: inbox.name, inboxMimeType: inbox.mimeType, inboxSha256: job.inbox_sha256, evidenceKinds: [...TEXT_KINDS] };
  }

  async function agentInbox(credential, exportId, attempt) {
    const job = await agentJobRow(credential, exportId, attempt);
    const response = await driveFetch({ user_id: job.user_id }, `${DRIVE_API}/files/${encodeURIComponent(job.inbox_file_id)}?alt=media`);
    if (!response.ok) throw httpError(502, 'drive_unavailable', '無法下載 AI 批次');
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': response.headers.get('content-type') || 'application/octet-stream' });
    if (response.headers.get('content-length')) headers.set('Content-Length', response.headers.get('content-length'));
    return new Response(response.body, { status: 200, headers });
  }

  async function agentSubmitResult(credential, exportId, attempt, request) {
    const job = await agentJobRow(credential, exportId, attempt);
    const declared = Number(request.headers.get('content-length') || 0);
    const text = declared > MAX_RESULT_BYTES ? null : await request.text();
    let checked;
    try {
      if (text === null) { const error = new Error('整理結果過大'); error.code = 'result_too_large'; throw error; }
      checked = checkOrganizedForJob(text, { exportId: job.export_id, itemIds: JSON.parse(job.item_ids), maxBytes: MAX_RESULT_BYTES });
    } catch (error) {
      const code = error.code || 'result_invalid';
      await markFailed(job.export_id, job.attempt_count, code, error.message);
      await startNext(job.user_id);
      throw httpError(422, code, error.message);
    }
    const placeholder = await driveMeta(job.user_id, job.result_file_id);
    if (!placeholderUnchanged(placeholder, job)) {
      await markFailed(job.export_id, job.attempt_count, 'placeholder_changed', '結果占位檔在整理期間被改動或刪除，未寫回');
      await startNext(job.user_id);
      throw httpError(409, 'placeholder_changed', '結果占位檔在整理期間被改動或刪除，未寫回');
    }
    const upload = await driveFetch({ user_id: job.user_id }, `${DRIVE_UPLOAD}/files/${encodeURIComponent(job.result_file_id)}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text
    });
    if (!upload.ok) {
      await markFailed(job.export_id, job.attempt_count, 'writeback_failed', 'Google Drive 寫回失敗');
      await startNext(job.user_id);
      throw httpError(502, 'writeback_failed', 'Google Drive 寫回失敗');
    }
    // Remember what we wrote so a later retry/resubmit of this job still
    // recognises the placeholder as ours.
    const written = await upload.json().catch(() => ({}));
    await db.prepare('UPDATE ai_jobs SET result_version=?, result_md5=?, updated_at=? WHERE export_id=? AND attempt_count=?')
      .bind(written.version || null, written.md5Checksum || null, now(), job.export_id, job.attempt_count).run();
    let readText = null;
    try {
      const readBack = await driveFetch({ user_id: job.user_id }, `${DRIVE_API}/files/${encodeURIComponent(job.result_file_id)}?alt=media`);
      readText = readBack.ok ? await readBack.text() : null;
    } catch {
      await markFailed(job.export_id, job.attempt_count, 'writeback_failed', '寫回後無法讀回驗證，可重試');
      await startNext(job.user_id);
      throw httpError(502, 'writeback_failed', '寫回後無法讀回驗證，可重試');
    }
    if (readText === null || await sha256Text(readText) !== await sha256Text(text)) {
      await markFailed(job.export_id, job.attempt_count, 'writeback_mismatch', '寫回後讀回的內容不一致');
      await startNext(job.user_id);
      throw httpError(502, 'writeback_mismatch', '寫回後讀回的內容不一致');
    }
    const finishedAt = now();
    await db.prepare("UPDATE ai_jobs SET status='ready', finished_at=?, updated_at=? WHERE export_id=? AND attempt_count=? AND status='running'")
      .bind(finishedAt, finishedAt, job.export_id, job.attempt_count).run();
    await startNext(job.user_id);
    return { job: publicJob(await jobRow(job.user_id, job.export_id)), items: checked.items.length };
  }

  async function agentFail(credential, exportId, attempt, body) {
    const job = await agentJobRow(credential, exportId, attempt);
    const code = typeof body?.code === 'string' && /^[a-z_]{1,40}$/.test(body.code) ? body.code : 'agent_reported';
    const message = typeof body?.message === 'string' ? body.message.slice(0, 300) : '';
    await markFailed(job.export_id, job.attempt_count, code, message);
    await startNext(job.user_id);
    return publicJob(await jobRow(job.user_id, job.export_id));
  }

  return { createCredential, listCredentials, revokeCredential, authenticateAgent, agentGetJob, agentInbox, agentSubmitResult, agentFail, configured, createJob, listJobs, retryJob, markApplied, sweep, startNext };
}
