import { ALLOWED_IMAGE_TYPES, hasValidImageSignature, sha256 } from '../../lib.mjs';
import { json, randomToken } from './security.mjs';

// Bounded buffering is deliberate: no multipart/base64 copy, no 25 MB Worker buffering.
export const CAPTURE_IMAGE_LIMIT = 4 * 1024 * 1024;
const DAY = 86_400_000; const DAILY_BYTES = 50 * 1024 * 1024; const PENDING_BYTES = 100 * 1024 * 1024;
const API = 'https://www.googleapis.com/drive/v3'; const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }

export async function boundedBytes(body, limit = CAPTURE_IMAGE_LIMIT, timeoutMs = 30_000) {
  if (!body) fail(400, 'empty_image', '沒有圖片內容');
  const reader = body.getReader(); const chunks = []; let size = 0; const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (Date.now() >= deadline) fail(408, 'image_timeout', '圖片傳輸逾時，尚未收件');
      let timer; let part;
      try { part = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('圖片傳輸逾時，尚未收件'), { status: 408, code: 'image_timeout' })), Math.max(1, Math.min(15_000, deadline - Date.now()))); })]); } finally { clearTimeout(timer); }
      const { value, done } = part; if (done) break;
      size += value.byteLength;
      if (size > limit) fail(413, 'image_too_large', '分享收件每張最多 4 MiB；原檔可在 App 直接選取（25 MB）');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (!size) fail(400, 'empty_image', '圖片是空檔案');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function imageCaptureService({ env, now, driveFetch }) {
  const db = env.DB;
  // Fixed Google URLs only; shortcut callers cannot choose an ID, folder or query.
  async function drive(userId, target, options = {}) {
    const response = await driveFetch({ user_id: userId }, target, { ...options, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) fail(response.status >= 500 ? 503 : response.status, 'capture_drive_failed', 'Drive 暫存失敗，尚未安全收件；請稍後重試或重新登入');
    return response;
  }
  async function privateFolder(userId) {
    let storage = await db.prepare('SELECT folder_id FROM capture_image_storage WHERE user_id=?').bind(userId).first();
    if (!storage) {
      const folder = await (await drive(userId, `${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pocket Archive Capture (private)', mimeType: 'application/vnd.google-apps.folder', appProperties: { paRole: 'capturePrivate' } }) })).json();
      await db.prepare('INSERT INTO capture_image_storage (user_id,folder_id) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING').bind(userId, folder.id).run();
      storage = await db.prepare('SELECT folder_id FROM capture_image_storage WHERE user_id=?').bind(userId).first();
    }
    const permissions = await (await drive(userId, `${API}/files/${storage.folder_id}/permissions?fields=permissions(type,role),nextPageToken`)).json();
    if (permissions.nextPageToken || !permissions.permissions?.length || permissions.permissions.some(p => p.type !== 'user' || p.role !== 'owner')) fail(409, 'capture_folder_shared', '收件暫存資料夾已被分享；為保護隱私已停止圖片收件');
    return storage.folder_id;
  }
  async function existingResult(row) {
    if (['ready', 'completed'].includes(row.status) && row.job_id) return json({ ok: true, status: 'duplicate', jobId: row.job_id, message: '此圖片已安全收件，未重複建立；不代表已同步' });
    fail(409, row.status === 'receiving' ? 'upload_in_progress' : 'upload_retry_new_key', '上次圖片尚未安全收件；稍後以新的 UUID 重傳原檔');
  }
  async function submit(request, credential) {
    const key = request.headers.get('Idempotency-Key') || '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) fail(400, 'idempotency_required', '需要 Idempotency-Key');
    const replay = await db.prepare('SELECT * FROM capture_images WHERE credential_id=? AND idempotency_key=?').bind(credential.id, key).first();
    if (replay) return existingResult(replay);
    const mime = (request.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_IMAGE_TYPES.has(mime)) fail(415, 'invalid_image_type', '不支援的圖片 MIME；不可更改副檔名繞過檢查');
    const length = Number(request.headers.get('Content-Length') || 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > CAPTURE_IMAGE_LIMIT) fail(413, 'image_too_large', '分享收件每張最多 4 MiB');
    let name;
    try { name = decodeURIComponent(request.headers.get('X-PA-Filename') || 'image'); } catch { fail(400, 'invalid_filename', '圖片檔名編碼錯誤'); }
    if (!name || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name)) fail(400, 'invalid_filename', '圖片檔名無效或超過 180 字元');
    const id = `upload_${randomToken(18)}`; const time = now();
    // Atomic SQL reservation + unique active-upload index bound concurrent memory and quota.
    let reserved;
    try {
      reserved = await db.prepare(`INSERT INTO capture_images (id,user_id,credential_id,idempotency_key,status,name,mime_type,size,created_at,expires_at)
        SELECT ?,?,?,?,'receiving',?,?,?,?,? WHERE
        (SELECT COALESCE(SUM(size),0) FROM capture_images WHERE user_id=? AND created_at>?) + ? <= ? AND
        (SELECT COUNT(*) FROM capture_images WHERE user_id=? AND created_at>?) < 100 AND
        (SELECT COALESCE(SUM(size),0) FROM capture_images WHERE user_id=? AND (status IN ('receiving','ready') OR (file_id IS NOT NULL AND cleaned_at IS NULL))) + ? <= ?`)
        .bind(id, credential.user_id, credential.id, key, name, mime, CAPTURE_IMAGE_LIMIT, time, time + 10 * 60_000, credential.user_id, time - DAY, CAPTURE_IMAGE_LIMIT, DAILY_BYTES, credential.user_id, time - DAY, credential.user_id, CAPTURE_IMAGE_LIMIT, PENDING_BYTES).run();
    } catch {
      const raced = await db.prepare('SELECT * FROM capture_images WHERE credential_id=? AND idempotency_key=?').bind(credential.id, key).first();
      if (raced) return existingResult(raced);
      fail(409, 'upload_busy', '已有圖片上傳中；請逐張送出並稍後重試');
    }
    if (!reserved.meta?.changes) fail(429, 'capture_quota', '圖片收件已達每日 50 MiB／100 次或暫存 100 MiB 上限；尚未收件');
    try {
      const bytes = await boundedBytes(request.body);
      if (length && length !== bytes.length) fail(400, 'image_size_mismatch', '圖片傳輸不完整');
      if (!hasValidImageSignature(bytes.subarray(0, 64), mime)) fail(415, 'image_signature_mismatch', '圖片內容與 MIME 不符');
      const hash = await sha256(bytes);
      const duplicate = await db.prepare("SELECT * FROM capture_images WHERE user_id=? AND hash=? AND status IN ('ready','completed') ORDER BY created_at LIMIT 1").bind(credential.user_id, hash).first();
      if (duplicate) {
        await db.prepare("UPDATE capture_images SET status='completed',job_id=?,hash=?,size=?,cleaned_at=? WHERE id=?").bind(duplicate.job_id, hash, bytes.length, now(), id).run();
        return existingResult(duplicate);
      }
      const folder = await privateFolder(credential.user_id);
      const generated = await (await drive(credential.user_id, `${API}/files/generateIds?count=1&space=drive&type=files`)).json();
      const fileId = generated.ids?.[0]; if (!/^[A-Za-z0-9_-]{4,256}$/.test(fileId || '')) fail(503, 'capture_drive_failed', '無法配置暫存原檔');
      // Persist the ID BEFORE create: uncertain network outcomes remain garbage-collectable.
      const registered = await db.prepare("UPDATE capture_images SET file_id=?,hash=?,size=? WHERE id=? AND status='receiving' AND expires_at>?").bind(fileId, hash, bytes.length, id, now()).run();
      if (!registered.meta?.changes) fail(409, 'upload_expired', '上傳期限已過，尚未建立暫存原檔');
      await drive(credential.user_id, `${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fileId, name, mimeType: mime, parents: [folder], appProperties: { paRole: 'captureImage', uploadId: id } }) });
      await drive(credential.user_id, `${UPLOAD}/files/${fileId}?uploadType=media&fields=id,size`, { method: 'PATCH', headers: { 'Content-Type': mime }, body: bytes });
      const check = await boundedBytes((await drive(credential.user_id, `${API}/files/${fileId}?alt=media`)).body);
      if (check.length !== bytes.length || await sha256(check) !== hash) fail(503, 'capture_integrity_failed', 'Drive 回讀完整性驗證失敗，尚未收件');
      // Separate table can transition only after a durable queue record exists.
      const jobId = `capture_${hash}`;
      await db.prepare(`INSERT INTO capture_jobs (id,user_id,credential_id,idempotency_key,canonical_url,original_url,source,status,created_at,expires_at)
        SELECT ?,?,?,?,'','','ios-shortcut-image','pending',?,? WHERE EXISTS (SELECT 1 FROM capture_images WHERE id=? AND status='receiving' AND expires_at>?)
        ON CONFLICT(id) DO NOTHING`).bind(jobId, credential.user_id, credential.id, `image:${id}`, time, time + 7 * DAY, id, now()).run();
      const ready = await db.prepare("UPDATE capture_images SET status='ready',job_id=?,expires_at=? WHERE id=? AND status='receiving' AND expires_at>? AND EXISTS(SELECT 1 FROM capture_jobs WHERE id=?)").bind(jobId, time + 7 * DAY, id, now(), jobId).run();
      if (!ready.meta?.changes) fail(409, 'upload_expired', '上傳期限已過，尚未安全收件');
      return json({ ok: true, status: 'accepted', jobId, sha256: hash, size: bytes.length, message: '原始圖片已安全收件；App 尚未入庫／同步' }, 202);
    } catch (error) {
      await db.prepare("UPDATE capture_images SET status='failed',expires_at=? WHERE id=? AND status='receiving'").bind(now(), id).run();
      throw error;
    }
  }
  async function attachment(jobId, userId) {
    return db.prepare("SELECT * FROM capture_images WHERE job_id=? AND user_id=? AND status='ready'").bind(jobId, userId).first();
  }
  async function content(jobId, session, leaseVersion) {
    const job = await db.prepare("SELECT id FROM capture_jobs WHERE id=? AND user_id=? AND status='leased' AND lease_owner=? AND lease_expires_at>? AND expires_at>? AND attempt_count=?").bind(jobId, session.user_id, session.public_id, now(), now(), leaseVersion).first();
    const image = job && await attachment(jobId, session.user_id);
    if (!image) fail(409, 'lease_lost', '圖片租約已失效，請重新領取');
    const response = await drive(session.user_id, `${API}/files/${image.file_id}?alt=media`);
    return new Response(response.body, { headers: { 'Content-Type': image.mime_type, 'Cache-Control': 'no-store' } });
  }
  async function cleanup() {
    const time = now();
    await db.prepare("UPDATE capture_images SET status='expired' WHERE status IN ('receiving','ready') AND expires_at<=?").bind(time).run();
    const rows = await db.prepare("SELECT * FROM capture_images WHERE cleaned_at IS NULL AND (status IN ('failed','expired') OR (status='completed' AND expires_at<=?)) LIMIT 3").bind(time).all();
    for (const row of rows.results || []) {
      try {
        if (row.file_id) {
          const result = await driveFetch({ user_id: row.user_id }, `${API}/files/${row.file_id}?fields=id,appProperties,trashed`, { signal: AbortSignal.timeout(20_000) });
          if (result.status === 404 && time - row.created_at < 15 * 60_000) continue; // Quarantine ambiguous creates before releasing their reservation.
          if (result.status !== 404) {
            if (!result.ok) continue;
            const file = await result.json();
            if (file.appProperties?.paRole !== 'captureImage' || file.appProperties?.uploadId !== row.id) continue;
            if (!file.trashed) await drive(row.user_id, `${API}/files/${row.file_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"trashed":true}' });
          }
        }
        await db.prepare('UPDATE capture_images SET cleaned_at=?,name=\'\' WHERE id=?').bind(time, row.id).run();
        if (row.job_id) await db.prepare("UPDATE capture_jobs SET status='expired' WHERE id=? AND status IN ('pending','leased')").bind(row.job_id).run();
      } catch { /* Grant/network failures retain the ID and quota reservation for the next run. */ }
    }
    await db.prepare('DELETE FROM capture_images WHERE cleaned_at IS NOT NULL AND created_at<?').bind(time - 30 * DAY).run();
    await db.prepare('DELETE FROM capture_rate_limits WHERE window_start<?').bind(time - DAY).run();
  }
  return { submit, attachment, content, cleanup };
}
