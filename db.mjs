import { recordLocalChanges } from './sync.mjs';
import { STORAGE_KEY, validatedEntry } from './lib.mjs';

export const DB_NAME = 'pocket-archive';
export const DB_VERSION = 2;

const REVISION_KEY = 'data-revision';
const revisionNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export class StaleDataError extends Error {
  constructor() {
    super('本機收藏在操作期間已有新的修改；已阻止舊資料覆寫，請重新開啟收藏後重試。');
    this.name = 'StaleDataError';
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 操作失敗'));
  });
}

async function markDataRevision(transaction) {
  const store = transaction.objectStore('meta');
  const row = await requestResult(store.get(REVISION_KEY));
  store.put({ key: REVISION_KEY, value: revisionNumber(row?.value) + 1 });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('儲存交易已取消'));
    transaction.onerror = () => reject(transaction.error || new Error('儲存交易失敗'));
  });
}

export function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('瀏覽器儲存空間不足；資料未變更。請先匯出完整備份並清理空間。');
  return new Error(`本機資料庫無法寫入（可能是私密瀏覽或權限限制）：${error?.message || '未知錯誤'}`);
}

export function readLegacyEntries(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return { entries: [], error: '舊版資料不是陣列' };
    const entries = [];
    const errors = [];
    parsed.forEach((item, index) => {
      try { entries.push(validatedEntry(item)); }
      catch (error) { errors.push({ index, message: error.message }); }
    });
    return { entries, errors };
  } catch (error) {
    return { entries: [], error: error.message };
  }
}

export async function openDatabase(storage = globalThis.localStorage) {
  if (!globalThis.indexedDB) throw new Error('此瀏覽器不支援 IndexedDB，無法安全保存附件');
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
  };
  const db = await requestResult(request);
  db.onversionchange = () => db.close();

  const check = db.transaction(['entries', 'meta'], 'readonly');
  const [count, migrated] = await Promise.all([
    requestResult(check.objectStore('entries').count()),
    requestResult(check.objectStore('meta').get('legacy-migration'))
  ]);
  await transactionDone(check);
  let migration = migrated?.value || null;
  if (!migrated && count === 0) {
    const legacy = readLegacyEntries(storage);
    const tx = db.transaction(['entries', 'meta'], 'readwrite');
    legacy.entries.forEach(entry => tx.objectStore('entries').put(entry));
    migration = { imported: legacy.entries.length, errors: legacy.errors || [], error: legacy.error || null, at: new Date().toISOString() };
    tx.objectStore('meta').put({ key: 'legacy-migration', value: migration });
    try { await transactionDone(tx); } catch (error) { db.close(); throw storageError(error); }
  }
  return { db, migration };
}

export class PocketRepository {
  constructor(db) { this.db = db; }

  async listEntries() {
    const tx = this.db.transaction('entries', 'readonly');
    const result = await requestResult(tx.objectStore('entries').getAll());
    await transactionDone(tx);
    return result.map(validatedEntry);
  }

  async readSyncSnapshot() {
    const tx = this.db.transaction(['entries', 'meta'], 'readonly');
    const meta = tx.objectStore('meta');
    const [entries, journal, tombstones, revision] = await Promise.all([
      requestResult(tx.objectStore('entries').getAll()),
      requestResult(meta.get('sync-journal')),
      requestResult(meta.get('sync-tombstones')),
      requestResult(meta.get(REVISION_KEY))
    ]);
    await transactionDone(tx);
    return {
      entries: entries.map(validatedEntry),
      journal: journal?.value || {},
      tombstones: tombstones?.value || {},
      revision: revisionNumber(revision?.value)
    };
  }

  async saveEntry(entry, blob = null) {
    const value = validatedEntry(entry);
    const stores = blob ? ['entries', 'attachments', 'meta'] : ['entries', 'meta'];
    const tx = this.db.transaction(stores, 'readwrite');
    const done = transactionDone(tx);
    try {
      await markDataRevision(tx);
      tx.objectStore('entries').put(value);
      if (blob && value.attachment) tx.objectStore('attachments').put({ id: value.attachment.id, blob });
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* already closed */ }
      await done.catch(() => {}); throw storageError(error);
    }
    return value;
  }

  async saveEntries(entries) {
    const values = entries.map(validatedEntry);
    const tx = this.db.transaction(['entries', 'meta'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await markDataRevision(tx);
      values.forEach(entry => tx.objectStore('entries').put(entry));
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* already closed */ }
      await done.catch(() => {}); throw storageError(error);
    }
    return values;
  }

  async replaceEntries(entries) {
    const values = entries.map(validatedEntry);
    const tx = this.db.transaction(['entries', 'meta'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await markDataRevision(tx);
      const store = tx.objectStore('entries');
      store.clear();
      values.forEach(entry => store.put(entry));
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* already closed */ }
      await done.catch(() => {}); throw storageError(error);
    }
    return values;
  }

  async replaceBundle(entries, attachmentBlobs = new Map(), { meta = {}, deleteAttachmentIds = [], expectedRevision = null } = {}) {
    const values = entries.map(validatedEntry);
    // Compare the snapshot version and write the replacement in one IndexedDB
    // transaction, even when another tab is changing the same local database.
    const tx = this.db.transaction(['entries', 'attachments', 'meta'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const entryStore = tx.objectStore('entries');
      const attachmentStore = tx.objectStore('attachments');
      const metaStore = tx.objectStore('meta');
      const [stored, revisionRow] = await Promise.all([
        requestResult(entryStore.getAll()),
        requestResult(metaStore.get(REVISION_KEY))
      ]);
      const revision = revisionNumber(revisionRow?.value);
      if (expectedRevision !== null && revision !== expectedRevision) throw new StaleDataError();
      const previous = new Map(stored.map(entry => [entry.id, entry]));
      const retained = new Set(values.map(entry => entry.id));
      for (const entry of stored) if (!retained.has(entry.id)) entryStore.delete(entry.id);
      for (const entry of values) {
        // A read-time compatibility projection is not a bulk migration. Keep
        // untouched raw rows byte-for-byte, including unknown historical fields.
        let unchanged = false;
        try { unchanged = previous.has(entry.id) && JSON.stringify(validatedEntry(previous.get(entry.id))) === JSON.stringify(entry); } catch { /* explicitly replaced invalid row */ }
        if (!unchanged) entryStore.put(entry);
        const blob = entry.attachment && attachmentBlobs.get(entry.attachment.id);
        if (blob) attachmentStore.put({ id: entry.attachment.id, blob });
      }
      for (const id of deleteAttachmentIds) attachmentStore.delete(id);
      for (const [key, value] of Object.entries(meta)) {
        if (key === REVISION_KEY) throw new Error('資料版本欄位不可直接修改');
        metaStore.put({ key, value });
      }
      metaStore.put({ key: REVISION_KEY, value: revision + 1 });
      await done;
      Object.defineProperty(values, 'dataRevision', { value: revision + 1 });
    } catch (error) {
      try { tx.abort(); } catch { /* already aborted or completed */ }
      await done.catch(() => {});
      if (error instanceof StaleDataError) throw error;
      throw storageError(error);
    }
    return values;
  }

  async commitCapture(entry, blob, deviceId) {
    const value = validatedEntry(entry);
    if (value.kind === 'image' && !blob) throw new Error('缺少原始收件圖片');
    const tx = this.db.transaction(['entries', 'attachments', 'meta'], 'readwrite');
    const done = transactionDone(tx); const entriesStore = tx.objectStore('entries'); const meta = tx.objectStore('meta');
    try {
      const [rawEntries, rawJournal, rawTombstones, rawReceipts, revisionRow] = await Promise.all([
        requestResult(entriesStore.getAll()), requestResult(meta.get('sync-journal')), requestResult(meta.get('sync-tombstones')), requestResult(meta.get('capture-receipts')),
        requestResult(meta.get(REVISION_KEY))
      ]);
      const entries = rawEntries.map(validatedEntry); const receipts = rawReceipts?.value || [];
      const duplicate = receipts.includes(value.id) || entries.some(item => item.id === value.id || (value.attachment ? item.attachment?.hash === value.attachment.hash : item.normalizedUrl === value.normalizedUrl));
      if (!duplicate) {
        const sync = recordLocalChanges(entries, [value, ...entries], { deviceId, journal: rawJournal?.value || {}, tombstones: rawTombstones?.value || {} });
        entriesStore.put(sync.entries.find(item => item.id === value.id));
        if (blob) tx.objectStore('attachments').put({ id: value.attachment.id, blob });
        meta.put({ key: 'sync-journal', value: sync.journal }); meta.put({ key: 'sync-tombstones', value: sync.tombstones }); meta.put({ key: 'cloud-dirty', value: true });
        meta.put({ key: REVISION_KEY, value: revisionNumber(revisionRow?.value) + 1 });
      }
      meta.put({ key: 'capture-receipts', value: [...new Set([value.id, ...receipts])].slice(0, 500) });
      await done; return duplicate ? 'duplicate' : 'saved';
    } catch (error) { try { tx.abort(); } catch { /* already aborted */ } await done.catch(() => {}); throw storageError(error); }
  }

  async deleteEntry(entry) {
    const tx = this.db.transaction(['entries', 'attachments', 'meta'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await markDataRevision(tx);
      tx.objectStore('entries').delete(entry.id);
      if (entry.attachment?.id) tx.objectStore('attachments').delete(entry.attachment.id);
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* already closed */ }
      await done.catch(() => {}); throw storageError(error);
    }
  }

  async getAttachment(id) {
    const tx = this.db.transaction('attachments', 'readonly');
    const result = await requestResult(tx.objectStore('attachments').get(id));
    await transactionDone(tx);
    return result?.blob || null;
  }

  async importBundle(entries, attachmentBlobs = new Map()) {
    const values = entries.map(validatedEntry);
    const tx = this.db.transaction(['entries', 'attachments', 'meta'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await markDataRevision(tx);
      for (const entry of values) {
        tx.objectStore('entries').put(entry);
        const blob = entry.attachment && attachmentBlobs.get(entry.attachment.id);
        if (blob) tx.objectStore('attachments').put({ id: entry.attachment.id, blob });
      }
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* already closed */ }
      await done.catch(() => {}); throw storageError(error);
    }
    return values;
  }

  async getMeta(key, fallback = null) {
    const tx = this.db.transaction('meta', 'readonly');
    const result = await requestResult(tx.objectStore('meta').get(key));
    await transactionDone(tx);
    return result ? result.value : fallback;
  }

  async setMeta(key, value) {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    try { await transactionDone(tx); } catch (error) { throw storageError(error); }
  }
}

export async function initRepository(storage = globalThis.localStorage) {
  const { db, migration } = await openDatabase(storage);
  return { repository: new PocketRepository(db), migration };
}
