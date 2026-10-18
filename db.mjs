import { STORAGE_KEY, validatedEntry } from './lib.mjs';

export const DB_NAME = 'pocket-archive';
export const DB_VERSION = 2;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 操作失敗'));
  });
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

  async saveEntry(entry, blob = null) {
    const value = validatedEntry(entry);
    const stores = blob ? ['entries', 'attachments'] : ['entries'];
    const tx = this.db.transaction(stores, 'readwrite');
    tx.objectStore('entries').put(value);
    if (blob && value.attachment) tx.objectStore('attachments').put({ id: value.attachment.id, blob });
    try { await transactionDone(tx); } catch (error) { throw storageError(error); }
    return value;
  }

  async saveEntries(entries) {
    const values = entries.map(validatedEntry);
    const tx = this.db.transaction('entries', 'readwrite');
    values.forEach(entry => tx.objectStore('entries').put(entry));
    try { await transactionDone(tx); } catch (error) { throw storageError(error); }
    return values;
  }

  async replaceEntries(entries) {
    const values = entries.map(validatedEntry);
    const tx = this.db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    store.clear();
    values.forEach(entry => store.put(entry));
    try { await transactionDone(tx); } catch (error) { throw storageError(error); }
    return values;
  }

  async replaceBundle(entries, attachmentBlobs = new Map()) {
    const values = entries.map(validatedEntry);
    const tx = this.db.transaction(['entries', 'attachments'], 'readwrite');
    try {
      const entryStore = tx.objectStore('entries');
      const attachmentStore = tx.objectStore('attachments');
      entryStore.clear();
      for (const entry of values) {
        entryStore.put(entry);
        const blob = entry.attachment && attachmentBlobs.get(entry.attachment.id);
        if (blob) attachmentStore.put({ id: entry.attachment.id, blob });
      }
      await transactionDone(tx);
    } catch (error) {
      try { tx.abort(); } catch { /* already aborted or completed */ }
      throw storageError(error);
    }
    return values;
  }

  async deleteEntry(entry) {
    const tx = this.db.transaction(['entries', 'attachments'], 'readwrite');
    tx.objectStore('entries').delete(entry.id);
    if (entry.attachment?.id) tx.objectStore('attachments').delete(entry.attachment.id);
    try { await transactionDone(tx); } catch (error) { throw storageError(error); }
  }

  async getAttachment(id) {
    const tx = this.db.transaction('attachments', 'readonly');
    const result = await requestResult(tx.objectStore('attachments').get(id));
    await transactionDone(tx);
    return result?.blob || null;
  }

  async importBundle(entries, attachmentBlobs = new Map()) {
    const values = entries.map(validatedEntry);
    const tx = this.db.transaction(['entries', 'attachments'], 'readwrite');
    for (const entry of values) {
      tx.objectStore('entries').put(entry);
      const blob = entry.attachment && attachmentBlobs.get(entry.attachment.id);
      if (blob) tx.objectStore('attachments').put({ id: entry.attachment.id, blob });
    }
    try { await transactionDone(tx); } catch (error) { throw storageError(error); }
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
