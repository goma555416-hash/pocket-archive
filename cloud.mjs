import { createBackupEnvelope, createInboxEnvelope, readOrganized, sha256 } from './lib.mjs';
import { readZip, createZip } from './archive.mjs';
import { encryptBackup, decryptBackup } from './crypto.mjs';
import { createJournal, readJournal, reconcileReplica } from './sync.mjs';

function safeStamp(date = new Date()) { return date.toISOString().replace(/[:.]/g, '-'); }

async function filesForEntries(entries, repository, manifestName, envelope) {
  const json = JSON.stringify(envelope, null, 2);
  const withAttachments = entries.filter(entry => entry.attachment);
  if (!withAttachments.length) return { blob: new Blob([json], { type: 'application/json' }), extension: 'json' };
  const files = [{ name: manifestName, data: json }];
  for (const entry of withAttachments) {
    const blob = await repository.getAttachment(entry.attachment.id);
    if (!blob) throw new Error(`附件遺失：${entry.attachment.name}`);
    files.push({ name: entry.attachment.path, data: blob });
  }
  return { blob: await createZip(files), extension: 'zip' };
}

export async function createBackupArtifact(entries, repository, now = new Date()) {
  const envelope = createBackupEnvelope(entries, now.toISOString());
  const { blob, extension } = await filesForEntries(entries, repository, 'backup.json', envelope);
  return { blob, filename: `pocket-archive-backup-${safeStamp(now)}.${extension}`, envelope };
}

export async function createInboxArtifact(entries, repository, now = new Date()) {
  const envelope = createInboxEnvelope(entries, undefined, now.toISOString());
  const { blob, extension } = await filesForEntries(entries, repository, 'inbox.json', envelope);
  return { blob, filename: `pocket-archive-inbox-${safeStamp(now)}-${envelope.export_id}.${extension}`, envelope };
}

export class CloudBackupService {
  constructor(drive, workspace) { this.drive = drive; this.workspace = workspace; }

  async create(entries, repository, { retention = 5, passphrase = '', now = new Date() } = {}) {
    const artifact = await createBackupArtifact(entries, repository, now);
    let blob = artifact.blob; let filename = artifact.filename; let encrypted = false;
    if (passphrase) {
      blob = await encryptBackup(blob, passphrase, { filename });
      filename += '.paenc'; encrypted = true;
    }
    const digest = await sha256(blob);
    const file = await this.drive.createFile({
      name: filename, parentId: this.workspace.backups, blob, mimeType: blob.type,
      appProperties: { paRole: 'backup', sha256: digest, encrypted: String(encrypted), itemCount: String(entries.length) }
    });
    const check = await this.drive.getFile(file.id);
    if (Number(check.size) !== blob.size) throw new Error('雲端備份大小驗證失敗；已停止輪替舊備份');
    const uploaded = await this.drive.downloadFile(file.id);
    if (await sha256(uploaded) !== digest) throw new Error('雲端備份回讀 SHA-256 驗證失敗；已停止輪替舊備份');
    const all = await this.list();
    const keep = Math.max(1, Math.min(30, Number(retention) || 5));
    for (const old of all.slice(keep)) await this.drive.trashFile(old.id);
    return { ...check, sha256: digest, encrypted, filename };
  }

  async list() {
    const response = await this.drive.listFiles({ parentId: this.workspace.backups, appRole: 'backup', orderBy: 'createdTime desc', pageSize: 100 });
    return response.files || [];
  }

  async download(file, passphrase = '') {
    const blob = await this.drive.downloadFile(file.id);
    const expected = file.appProperties?.sha256;
    if (expected && await sha256(blob) !== expected) throw new Error('雲端備份 SHA-256 完整性驗證失敗');
    if (file.appProperties?.encrypted === 'true' || file.name.endsWith('.paenc')) {
      if (!passphrase) throw new Error('此備份已加密，請先輸入本次工作階段的加密密碼');
      return decryptBackup(blob, passphrase);
    }
    return { blob, filename: file.name };
  }
}

export class CloudAiExchange {
  constructor(drive, workspace) { this.drive = drive; this.workspace = workspace; }

  async slot(exportId, fileId, inboxFileId) {
    if (!fileId) throw new Error('結果占位檔缺失；停止，不另建結果檔');
    const file = await this.drive.getFile(fileId);
    if (file.trashed || file.name !== `organized-${exportId}.json` || !file.parents?.includes(this.workspace.aiResults) || file.appProperties?.exportId !== exportId || file.appProperties?.inboxFileId !== inboxFileId || file.appProperties?.paRole !== 'aiResult') throw new Error('結果占位原檔不匹配；停止處理');
    const blob = await this.drive.downloadFile(fileId);
    if (blob.size > 8 * 1024 * 1024) throw new Error('雲端 organized.json 超過 8 MB');
    const raw = JSON.parse(await blob.text());
    if (raw.format !== 'pocket-archive-organized' || raw.schema_version !== 2 || raw.source_export_id !== exportId || !Array.isArray(raw.items)) throw new Error('結果 export_id 或 schema 不匹配');
    if (raw.status === 'pending' && raw.items.length) throw new Error('占位檔包含不匹配的結果');
    return { file, raw };
  }

  async enqueue(entries, repository, now = new Date()) {
    const artifact = await createInboxArtifact(entries, repository, now);
    const jobKey = await sha256(new TextEncoder().encode(entries.map(entry => `${entry.id}:${entry.updatedAt}`).sort().join('|')));
    const existing = await this.drive.listFiles({ parentId: this.workspace.aiInbox, appRole: 'aiInbox', jobKey, pageSize: 100 });
    if (existing.nextPageToken) throw new Error('同批次來源檔過多；停止以免重複建立');
    const duplicates = existing.files?.filter(file => file.appProperties?.jobKey === jobKey) || [];
    if (duplicates.length > 1) throw new Error('同批次有多個來源檔；停止以免選錯');
    const duplicate = duplicates[0];
    if (duplicate) {
      const exportId = duplicate.appProperties?.exportId; const resultFileId = duplicate.appProperties?.resultFileId;
      await this.slot(exportId, resultFileId, duplicate.id);
      return { duplicate: true, inboxFile: duplicate, exportId, resultFileId, itemIds: entries.map(entry => entry.id) };
    }
    const inboxFile = await this.drive.createFile({
      name: artifact.filename, parentId: this.workspace.aiInbox, blob: artifact.blob, mimeType: artifact.blob.type,
      appProperties: { paRole: 'aiInbox', exportId: artifact.envelope.export_id, jobKey, itemCount: String(entries.length) }
    });
    const placeholder = { format: 'pocket-archive-organized', schema_version: 2, source_export_id: artifact.envelope.export_id, status: 'pending', items: [], note: 'Codex 必須覆寫此檔案，不可另建結果檔。' };
    const resultFile = await this.drive.createFile({
      name: `organized-${artifact.envelope.export_id}.json`, parentId: this.workspace.aiResults,
      blob: new Blob([JSON.stringify(placeholder, null, 2)], { type: 'application/json' }), mimeType: 'application/json',
      appProperties: { paRole: 'aiResult', exportId: artifact.envelope.export_id, inboxFileId: inboxFile.id, status: 'pending' }
    });
    await this.drive.updateMetadata(inboxFile.id, { appProperties: { ...inboxFile.appProperties, paRole: 'aiInbox', exportId: artifact.envelope.export_id, jobKey, itemCount: String(entries.length), resultFileId: resultFile.id } });
    return { duplicate: false, inboxFile, resultFile, exportId: artifact.envelope.export_id, jobKey, itemIds: entries.map(entry => entry.id) };
  }

  // The App has access to full Drive metadata even when a downstream Codex
  // connector omits appProperties. Verify the binding here, then transfer only
  // file IDs, folder IDs and byte hashes (never collection content or tokens).
  async launchEvidence(job) {
    const exportId = job.exportId;
    const inboxId = job.inboxFileId;
    const resultId = job.resultFileId;
    if (!/^export-[A-Za-z0-9._:-]{1,110}$/.test(exportId || '') || !inboxId || !resultId) throw new Error('AI 批次識別或 file ID 缺失');
    const [inbox, checked] = await Promise.all([
      this.drive.getFile(inboxId),
      this.slot(exportId, resultId, inboxId)
    ]);
    const result = checked.file;
    if (checked.raw.status !== 'pending' || checked.raw.items.length) throw new Error('結果原檔不是未處理占位檔，禁止覆寫');
    const sourceName = new RegExp(`^pocket-archive-inbox-[A-Za-z0-9T-]+-${exportId.replace(/[.*+?^${}()|[\]\\]/g, '\\  async readResult(job, entries, exportIds) {')}\\.(json|zip)import { createBackupEnvelope, createInboxEnvelope, readOrganized, sha256 } from './lib.mjs';
import { readZip, createZip } from './archive.mjs';
import { encryptBackup, decryptBackup } from './crypto.mjs';
import { createJournal, readJournal, reconcileReplica } from './sync.mjs';

function safeStamp(date = new Date()) { return date.toISOString().replace(/[:.]/g, '-'); }

async function filesForEntries(entries, repository, manifestName, envelope) {
  const json = JSON.stringify(envelope, null, 2);
  const withAttachments = entries.filter(entry => entry.attachment);
  if (!withAttachments.length) return { blob: new Blob([json], { type: 'application/json' }), extension: 'json' };
  const files = [{ name: manifestName, data: json }];
  for (const entry of withAttachments) {
    const blob = await repository.getAttachment(entry.attachment.id);
    if (!blob) throw new Error(`附件遺失：${entry.attachment.name}`);
    files.push({ name: entry.attachment.path, data: blob });
  }
  return { blob: await createZip(files), extension: 'zip' };
}

export async function createBackupArtifact(entries, repository, now = new Date()) {
  const envelope = createBackupEnvelope(entries, now.toISOString());
  const { blob, extension } = await filesForEntries(entries, repository, 'backup.json', envelope);
  return { blob, filename: `pocket-archive-backup-${safeStamp(now)}.${extension}`, envelope };
}

export async function createInboxArtifact(entries, repository, now = new Date()) {
  const envelope = createInboxEnvelope(entries, undefined, now.toISOString());
  const { blob, extension } = await filesForEntries(entries, repository, 'inbox.json', envelope);
  return { blob, filename: `pocket-archive-inbox-${safeStamp(now)}-${envelope.export_id}.${extension}`, envelope };
}

export class CloudBackupService {
  constructor(drive, workspace) { this.drive = drive; this.workspace = workspace; }

  async create(entries, repository, { retention = 5, passphrase = '', now = new Date() } = {}) {
    const artifact = await createBackupArtifact(entries, repository, now);
    let blob = artifact.blob; let filename = artifact.filename; let encrypted = false;
    if (passphrase) {
      blob = await encryptBackup(blob, passphrase, { filename });
      filename += '.paenc'; encrypted = true;
    }
    const digest = await sha256(blob);
    const file = await this.drive.createFile({
      name: filename, parentId: this.workspace.backups, blob, mimeType: blob.type,
      appProperties: { paRole: 'backup', sha256: digest, encrypted: String(encrypted), itemCount: String(entries.length) }
    });
    const check = await this.drive.getFile(file.id);
    if (Number(check.size) !== blob.size) throw new Error('雲端備份大小驗證失敗；已停止輪替舊備份');
    const uploaded = await this.drive.downloadFile(file.id);
    if (await sha256(uploaded) !== digest) throw new Error('雲端備份回讀 SHA-256 驗證失敗；已停止輪替舊備份');
    const all = await this.list();
    const keep = Math.max(1, Math.min(30, Number(retention) || 5));
    for (const old of all.slice(keep)) await this.drive.trashFile(old.id);
    return { ...check, sha256: digest, encrypted, filename };
  }

  async list() {
    const response = await this.drive.listFiles({ parentId: this.workspace.backups, appRole: 'backup', orderBy: 'createdTime desc', pageSize: 100 });
    return response.files || [];
  }

  async download(file, passphrase = '') {
    const blob = await this.drive.downloadFile(file.id);
    const expected = file.appProperties?.sha256;
    if (expected && await sha256(blob) !== expected) throw new Error('雲端備份 SHA-256 完整性驗證失敗');
    if (file.appProperties?.encrypted === 'true' || file.name.endsWith('.paenc')) {
      if (!passphrase) throw new Error('此備份已加密，請先輸入本次工作階段的加密密碼');
      return decryptBackup(blob, passphrase);
    }
    return { blob, filename: file.name };
  }
}

export class CloudAiExchange {
  constructor(drive, workspace) { this.drive = drive; this.workspace = workspace; }

  async slot(exportId, fileId, inboxFileId) {
    if (!fileId) throw new Error('結果占位檔缺失；停止，不另建結果檔');
    const file = await this.drive.getFile(fileId);
    if (file.trashed || file.name !== `organized-${exportId}.json` || !file.parents?.includes(this.workspace.aiResults) || file.appProperties?.exportId !== exportId || file.appProperties?.inboxFileId !== inboxFileId || file.appProperties?.paRole !== 'aiResult') throw new Error('結果占位原檔不匹配；停止處理');
    const blob = await this.drive.downloadFile(fileId);
    if (blob.size > 8 * 1024 * 1024) throw new Error('雲端 organized.json 超過 8 MB');
    const raw = JSON.parse(await blob.text());
    if (raw.format !== 'pocket-archive-organized' || raw.schema_version !== 2 || raw.source_export_id !== exportId || !Array.isArray(raw.items)) throw new Error('結果 export_id 或 schema 不匹配');
    if (raw.status === 'pending' && raw.items.length) throw new Error('占位檔包含不匹配的結果');
    return { file, raw };
  }

  async enqueue(entries, repository, now = new Date()) {
    const artifact = await createInboxArtifact(entries, repository, now);
    const jobKey = await sha256(new TextEncoder().encode(entries.map(entry => `${entry.id}:${entry.updatedAt}`).sort().join('|')));
    const existing = await this.drive.listFiles({ parentId: this.workspace.aiInbox, appRole: 'aiInbox', jobKey, pageSize: 100 });
    if (existing.nextPageToken) throw new Error('同批次來源檔過多；停止以免重複建立');
    const duplicates = existing.files?.filter(file => file.appProperties?.jobKey === jobKey) || [];
    if (duplicates.length > 1) throw new Error('同批次有多個來源檔；停止以免選錯');
    const duplicate = duplicates[0];
    if (duplicate) {
      const exportId = duplicate.appProperties?.exportId; const resultFileId = duplicate.appProperties?.resultFileId;
      await this.slot(exportId, resultFileId, duplicate.id);
      return { duplicate: true, inboxFile: duplicate, exportId, resultFileId, itemIds: entries.map(entry => entry.id) };
    }
    const inboxFile = await this.drive.createFile({
      name: artifact.filename, parentId: this.workspace.aiInbox, blob: artifact.blob, mimeType: artifact.blob.type,
      appProperties: { paRole: 'aiInbox', exportId: artifact.envelope.export_id, jobKey, itemCount: String(entries.length) }
    });
    const placeholder = { format: 'pocket-archive-organized', schema_version: 2, source_export_id: artifact.envelope.export_id, status: 'pending', items: [], note: 'Codex 必須覆寫此檔案，不可另建結果檔。' };
    const resultFile = await this.drive.createFile({
      name: `organized-${artifact.envelope.export_id}.json`, parentId: this.workspace.aiResults,
      blob: new Blob([JSON.stringify(placeholder, null, 2)], { type: 'application/json' }), mimeType: 'application/json',
      appProperties: { paRole: 'aiResult', exportId: artifact.envelope.export_id, inboxFileId: inboxFile.id, status: 'pending' }
    });
    await this.drive.updateMetadata(inboxFile.id, { appProperties: { ...inboxFile.appProperties, paRole: 'aiInbox', exportId: artifact.envelope.export_id, jobKey, itemCount: String(entries.length), resultFileId: resultFile.id } });
    return { duplicate: false, inboxFile, resultFile, exportId: artifact.envelope.export_id, jobKey, itemIds: entries.map(entry => entry.id) };
  }

);
    if (inbox.trashed || !sourceName.test(inbox.name) || !inbox.parents?.includes(this.workspace.aiInbox) ||
        !['application/json', 'application/zip'].includes(inbox.mimeType) ||
        inbox.appProperties?.paRole !== 'aiInbox' || inbox.appProperties?.exportId !== exportId ||
        inbox.appProperties?.resultFileId !== resultId ||
        result.mimeType !== 'application/json') throw new Error('來源批次 metadata 與結果檔綁定不匹配；停止');
    const [sources, slots] = await Promise.all([
      this.drive.listFiles({ parentId: this.workspace.aiInbox, name: inbox.name, pageSize: 10 }),
      this.drive.listFiles({ parentId: this.workspace.aiResults, name: result.name, pageSize: 10 })
    ]);
    if (sources.nextPageToken || slots.nextPageToken ||
        sources.files?.length !== 1 || sources.files[0].id !== inboxId ||
        slots.files?.length !== 1 || slots.files[0].id !== resultId) throw new Error('AI 批次／占位檔不唯一或不可列舉；停止');
    const [inboxBlob, pendingBlob] = await Promise.all([
      this.drive.downloadFile(inboxId), this.drive.downloadFile(resultId)
    ]);
    if (inboxBlob.size > 100 * 1024 * 1024 || pendingBlob.size > 8 * 1024 * 1024) throw new Error('批次或占位檔過大，停止驗證');
    const inboxText = inbox.name.endsWith('.zip')
      ? new TextDecoder().decode((await readZip(inboxBlob)).get('inbox.json'))
      : await inboxBlob.text();
    const envelope = JSON.parse(inboxText);
    const ids = envelope.items?.map(item => item.id);
    const expected = job.itemIds || [];
    if (envelope.format !== 'pocket-archive-inbox' || envelope.schema_version !== 2 ||
        envelope.export_id !== exportId || !Array.isArray(ids) || !ids.length ||
        ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length ||
        ids.length !== expected.length || ids.some(id => !expected.includes(id))) throw new Error('AI 來源 schema 或 item ID 不匹配；停止');
    return {
      version: 1, exportId,
      inboxFileId: inboxId, resultFileId: resultId,
      inboxFolderId: this.workspace.aiInbox, resultsFolderId: this.workspace.aiResults,
      inboxName: inbox.name, resultName: result.name,
      inboxSha256: await sha256(inboxBlob), pendingSha256: await sha256(pendingBlob)
    };
  }

  async readResult(job, entries, exportIds) {
    const { file, raw } = await this.slot(job.exportId, job.resultFile?.id || job.resultFileId, job.inboxFileId);
    if (raw.status === 'pending') return { pending: true, file };
    let ids = job.itemIds;
    if (!ids) { // v2.2 jobs: recover the original batch, never use all current entries as the scope.
      const meta = await this.drive.getFile(job.inboxFileId);
      if (!meta.parents?.includes(this.workspace.aiInbox) || meta.appProperties?.exportId !== job.exportId) throw new Error('來源批次不匹配');
      const blob = await this.drive.downloadFile(job.inboxFileId);
      if (blob.size > 100 * 1024 * 1024) throw new Error('來源批次過大');
      const text = meta.name.endsWith('.zip') ? new TextDecoder().decode((await readZip(blob)).get('inbox.json')) : await blob.text();
      const inbox = JSON.parse(text);
      if (inbox.format !== 'pocket-archive-inbox' || inbox.schema_version !== 2 || inbox.export_id !== job.exportId || !Array.isArray(inbox.items)) throw new Error('來源 schema 或 export_id 不匹配');
      ids = inbox.items.map(item => item.id);
    }
    const expected = new Set(ids); const received = new Set(raw.items.map(item => item.id));
    if (!expected.size || expected.size !== ids.length || received.size !== raw.items.length || expected.size !== received.size || [...received].some(id => !expected.has(id))) throw new Error('結果 item ID 必須與來源批次完整一對一');
    const result = readOrganized(raw, { entries, exportIds });
    if (result.rejected.length) throw new Error('結果含錯誤欄位或已不存在的 item ID');
    return { pending: false, file, result };
  }
}

export class CloudSyncService {
  constructor(drive, workspace) { this.drive = drive; this.workspace = workspace; }

  async writeJournal(deviceId, journal, existingFile = null) {
    const envelope = createJournal(deviceId, journal);
    const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
    if (existingFile) {
      await this.drive.updateContent(existingFile.id, blob, { mimeType: 'application/json' });
      return existingFile;
    }
    return this.drive.createFile({
      name: `journal-${deviceId}.json`, parentId: this.workspace.sync, blob, mimeType: 'application/json',
      appProperties: { paRole: 'syncJournal', deviceId }
    });
  }

  async uploadAttachments(records, repository) {
    const known = await this.drive.listFiles({ parentId: this.workspace.syncAttachments, appRole: 'syncAttachment', pageSize: 100 });
    const byHash = new Map((known.files || []).map(file => [file.appProperties?.sha256, file]));
    for (const record of Object.values(records)) {
      const attachment = record.operation === 'upsert' ? record.entry?.attachment : null;
      if (!attachment) continue;
      if (record.attachmentFileId) continue;
      const existing = byHash.get(attachment.hash);
      if (existing) { record.attachmentFileId = existing.id; continue; }
      const blob = await repository.getAttachment(attachment.id);
      if (!blob) throw new Error(`同步附件遺失：${attachment.name}`);
      const file = await this.drive.createFile({
        name: `${attachment.hash}-${attachment.name}`, parentId: this.workspace.syncAttachments, blob, mimeType: attachment.mimeType,
        appProperties: { paRole: 'syncAttachment', sha256: attachment.hash, attachmentId: attachment.id }
      });
      record.attachmentFileId = file.id; byHash.set(attachment.hash, file);
    }
  }

  async sync({ entries, repository, deviceId, journal, tombstones }) {
    await this.uploadAttachments(journal, repository);
    const name = `journal-${deviceId}.json`;
    const own = await this.drive.listFiles({ parentId: this.workspace.sync, name, appRole: 'syncJournal', pageSize: 10 });
    const journalFile = await this.writeJournal(deviceId, journal, own.files?.[0]);

    const listing = await this.drive.listFiles({ parentId: this.workspace.sync, appRole: 'syncJournal', pageSize: 100 });
    const remoteRecords = [];
    for (const file of listing.files || []) {
      const content = await this.drive.downloadFile(file.id);
      const parsed = readJournal(await content.text()); remoteRecords.push(...parsed.records);
    }
    const result = reconcileReplica(entries, tombstones, remoteRecords, journal);
    const nextJournal = { ...journal, ...result.convergedRecords };
    if (Object.keys(result.convergedRecords).length) {
      // Publish causal joins immediately. This is what lets two identical ZIP
      // replicas become one shared history before either side edits or deletes.
      await this.writeJournal(deviceId, nextJournal, journalFile);
    }
    const remoteByItem = new Map(remoteRecords.filter(record => record.operation === 'upsert' && record.attachmentFileId).map(record => [record.itemId, record]));
    const attachmentBlobs = new Map();
    for (const entry of result.entries.filter(item => item.attachment)) {
      if (await repository.getAttachment(entry.attachment.id)) continue;
      const record = remoteByItem.get(entry.id);
      if (!record) throw new Error(`遠端同步附件缺少 Drive 檔案：${entry.attachment.name}`);
      const blobValue = await this.drive.downloadFile(record.attachmentFileId);
      if (blobValue.size !== entry.attachment.size || await sha256(blobValue) !== entry.attachment.hash) throw new Error(`遠端同步附件完整性驗證失敗：${entry.attachment.name}`);
      attachmentBlobs.set(entry.attachment.id, new Blob([await blobValue.arrayBuffer()], { type: entry.attachment.mimeType }));
    }
    return { ...result, journal: nextJournal, attachmentBlobs, journalFile, remoteJournalCount: listing.files?.length || 0 };
  }
}
