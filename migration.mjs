import { createJournal, readJournal } from './sync.mjs';

export const MIGRATION_FORMAT = 'pocket-archive-origin-migration';
export const MIGRATION_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{4,256}$/;

function safeOrigin(value) {
  try {
    const url = new URL(String(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw new Error('遷移來源 origin 無效'); }
}

function cleanJobs(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs.slice(0, 50).flatMap(item => {
    if (!item || typeof item !== 'object' || !SAFE_ID.test(String(item.exportId || ''))) return [];
    const result = { exportId: String(item.exportId), createdAt: String(item.createdAt || ''), status: ['pending', 'ready', 'applied'].includes(item.status) ? item.status : 'pending' };
    for (const key of ['inboxFileId', 'resultFileId']) if (DRIVE_ID.test(String(item[key] || ''))) result[key] = String(item[key]);
    return [result];
  });
}

function cleanWorkspace(value) {
  const result = {}; if (!value || typeof value !== 'object') return result;
  for (const key of ['root', 'backups', 'aiInbox', 'aiResults', 'sync', 'syncAttachments']) if (DRIVE_ID.test(String(value[key] || ''))) result[key] = String(value[key]);
  return result;
}

function journalRecords(deviceId, records) {
  const envelope = createJournal(deviceId, records || {});
  if (envelope.records.length > 20_000) throw new Error('同步 metadata 超過遷移上限');
  return envelope.records;
}

export function createMigrationManifest({ backupSha256, sourceOrigin, sourceDeviceId, syncJournal = {}, tombstones = {}, exportIds = [], cloudJobs = [], driveWorkspace = {}, createdAt = new Date().toISOString() }) {
  if (!/^[a-f0-9]{64}$/i.test(String(backupSha256 || ''))) throw new Error('備份 SHA-256 無效');
  if (!SAFE_ID.test(String(sourceDeviceId || ''))) throw new Error('來源裝置 ID 無效');
  return {
    format: MIGRATION_FORMAT, schema_version: MIGRATION_VERSION, created_at: createdAt,
    source_origin: safeOrigin(sourceOrigin), source_device_id: sourceDeviceId, backup_sha256: backupSha256.toLowerCase(),
    sync: { journal: journalRecords(sourceDeviceId, syncJournal), tombstones: journalRecords(sourceDeviceId, tombstones).filter(record => record.operation === 'delete') },
    ai: { export_ids: [...new Set(exportIds.filter(value => SAFE_ID.test(String(value))).map(String))].slice(0, 50), jobs: cleanJobs(cloudJobs) },
    drive_workspace: cleanWorkspace(driveWorkspace)
  };
}

export function readMigrationManifest(value) {
  let data;
  try { data = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new Error('migration.json 不是有效 JSON'); }
  if (!data || data.format !== MIGRATION_FORMAT || data.schema_version !== MIGRATION_VERSION) throw new Error('遷移 manifest 格式或版本不受支援');
  if (!/^[a-f0-9]{64}$/i.test(String(data.backup_sha256 || '')) || Number.isNaN(Date.parse(data.created_at))) throw new Error('遷移 manifest 缺少完整性資訊');
  if (!SAFE_ID.test(String(data.source_device_id || ''))) throw new Error('遷移來源裝置 ID 無效');
  const readRecords = (records, tombstonesOnly = false) => {
    if (!Array.isArray(records) || records.length > 20_000) throw new Error('遷移同步 metadata 無效或過大');
    const parsed = readJournal({ format: 'pocket-archive-sync-journal', schema_version: 1, device_id: data.source_device_id, updated_at: data.created_at, records }).records;
    if (tombstonesOnly && parsed.some(record => record.operation !== 'delete')) throw new Error('遷移 tombstone 包含非刪除紀錄');
    return Object.fromEntries(parsed.map(record => [record.itemId, record]));
  };
  return {
    format: MIGRATION_FORMAT, schemaVersion: MIGRATION_VERSION, createdAt: data.created_at,
    sourceOrigin: safeOrigin(data.source_origin), sourceDeviceId: data.source_device_id, backupSha256: data.backup_sha256.toLowerCase(),
    syncJournal: readRecords(data.sync?.journal || []), tombstones: readRecords(data.sync?.tombstones || [], true),
    exportIds: [...new Set((Array.isArray(data.ai?.export_ids) ? data.ai.export_ids : []).filter(value => SAFE_ID.test(String(value))).map(String))].slice(0, 50),
    cloudJobs: cleanJobs(data.ai?.jobs), driveWorkspace: cleanWorkspace(data.drive_workspace)
  };
}

export function mergeMigrationAi(currentIds = [], currentJobs = [], migration) {
  const exportIds = [...new Set([...(migration?.exportIds || []), ...currentIds])].slice(0, 50);
  const jobs = [...currentJobs, ...(migration?.cloudJobs || [])];
  return { exportIds, cloudJobs: [...new Map(jobs.map(job => [job.exportId, job])).values()].slice(0, 50) };
}
