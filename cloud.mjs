import { createBackupEnvelope, createInboxEnvelope, readOrganized, sha256 } from './lib.mjs';
import { createZip } from './archive.mjs';
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

  async enqueue(entries, repository, now = new Date()) {
    const artifact = await createInboxArtifact(entries, repository, now);
    const jobKey = await sha256(new TextEncoder().encode(entries.map(entry => `${entry.id}:${entry.updatedAt}`).sort().join('|')));
    const existing = await this.drive.listFiles({ parentId: this.workspace.aiInbox, appRole: 'aiInbox', pageSize: 100 });
    const duplicate = existing.files?.find(file => file.appProperties?.jobKey === jobKey);
    if (duplicate) return { duplicate: true, inboxFile: duplicate, exportId: duplicate.appProperties?.exportId, resultFileId: duplicate.appProperties?.resultFileId };
    const inboxFile = await this.drive.createFile({
      name: artifact.filename, parentId: this.workspace.aiInbox, blob: artifact.blob, mimeType: artifact.blob.type,
      appProperties: { paRole: 'aiInbox', exportId: artifact.envelope.export_id, jobKey, itemCount: String(entries.length) }
    });
    const placeholder = {
      format: 'pocket-archive-organized', schema_version: 2, source_export_id: artifact.envelope.export_id,
      status: 'pending', items: [], note: 'Codex 必須覆寫此檔案，不可另建結果檔。'
    };
    const resultFile = await this.drive.createFile({
      name: `organized-${artifact.envelope.export_id}.json`, parentId: this.workspace.aiResults,
      blob: new Blob([JSON.stringify(placeholder, null, 2)], { type: 'application/json' }), mimeType: 'application/json',
      appProperties: { paRole: 'aiResult', exportId: artifact.envelope.export_id, inboxFileId: inboxFile.id, status: 'pending' }
    });
    await this.drive.updateMetadata(inboxFile.id, { appProperties: { ...inboxFile.appProperties, paRole: 'aiInbox', exportId: artifact.envelope.export_id, jobKey, itemCount: String(entries.length), resultFileId: resultFile.id } });
    return { duplicate: false, inboxFile, resultFile, exportId: artifact.envelope.export_id, jobKey };
  }

  async readResult(job, entries, exportIds) {
    const fileId = job.resultFile?.id || job.resultFileId;
    if (!fileId) throw new Error('AI 工作缺少結果檔 ID');
    const file = await this.drive.getFile(fileId); const blob = await this.drive.downloadFile(fileId);
    if (blob.size > 8 * 1024 * 1024) throw new Error('雲端 organized.json 超過 8 MB');
    const text = await blob.text();
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error('雲端結果不是有效 JSON'); }
    if (raw.status === 'pending') return { pending: true, file };
    return { pending: false, file, result: readOrganized(raw, { entries, exportIds }) };
  }
}

export class CloudSyncService {
  constructor(drive, workspace) { this.drive = drive; this.workspace = workspace; }

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
    const envelope = createJournal(deviceId, journal);
    const name = `journal-${deviceId}.json`;
    const own = await this.drive.listFiles({ parentId: this.workspace.sync, name, appRole: 'syncJournal', pageSize: 10 });
    const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
    let journalFile;
    if (own.files?.[0]) { await this.drive.updateContent(own.files[0].id, blob, { mimeType: 'application/json' }); journalFile = own.files[0]; }
    else journalFile = await this.drive.createFile({ name, parentId: this.workspace.sync, blob, mimeType: 'application/json', appProperties: { paRole: 'syncJournal', deviceId } });

    const listing = await this.drive.listFiles({ parentId: this.workspace.sync, appRole: 'syncJournal', pageSize: 100 });
    const remoteRecords = [];
    for (const file of listing.files || []) {
      const content = await this.drive.downloadFile(file.id);
      const parsed = readJournal(await content.text()); remoteRecords.push(...parsed.records);
    }
    const result = reconcileReplica(entries, tombstones, remoteRecords);
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
    return { ...result, attachmentBlobs, journalFile, remoteJournalCount: listing.files?.length || 0 };
  }
}
