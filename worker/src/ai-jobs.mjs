// Cloud AI organize jobs: agent credentials, job queue, Claude routine
// trigger and the agent API. D1 stores routing IDs, hashes and status only.
import { randomToken, safeEqual, sha256Text } from './security.mjs';

const AGENT_TOKEN = /^Bearer\s+pa_agent_([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{32,128})$/;
const DAY = 86_400_000;
const AGENT_RATE_PER_MINUTE = 60;

export function aiJobService({ env, now, driveFetch, fetchImpl, httpError }) {
  const db = env.DB;

  async function createCredential(userId, { name, expiresInDays } = {}) {
    const createdAt = now();
    const label = String(name || 'Claude 雲端整理').trim().slice(0, 80) || 'Claude 雲端整理';
    const requested = Number(expiresInDays ?? 180);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(365, requested)) : 180;
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

  async function agentJobRow(credential, exportId, attempt) {
    const job = await db.prepare('SELECT * FROM ai_jobs WHERE export_id=? AND user_id=?').bind(exportId, credential.user_id).first();
    if (!job) throw httpError(404, 'job_not_found', '找不到此 AI 整理工作');
    return job;
  }

  async function agentGetJob(credential, exportId, attempt) {
    const job = await agentJobRow(credential, exportId, attempt);
    return { exportId: job.export_id };
  }

  return { createCredential, listCredentials, revokeCredential, authenticateAgent, agentGetJob };
}
