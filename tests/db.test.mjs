import test from 'node:test';
import assert from 'node:assert/strict';
import { PocketRepository, StaleDataError } from '../db.mjs';
import { createEntry, createImageEntry, sha256 } from '../lib.mjs';
import { recordLocalChanges } from '../sync.mjs';

class AtomicFakeDatabase {
  constructor({ entries = [], attachments = [], attachmentError = null } = {}) {
    this.entries = new Map(entries.map(value => [value.id, structuredClone(value)]));
    this.attachments = new Map(attachments.map(value => [value.id, value]));
    this.meta = new Map();
    this.attachmentError = attachmentError;
    this.lastStores = [];
  }

  transaction(storeNames, mode) {
    assert.ok(['readwrite', 'readonly'].includes(mode));
    this.lastStores = [...storeNames];
    const stagedEntries = new Map(this.entries);
    const stagedAttachments = new Map(this.attachments);
    const stagedMeta = new Map(this.meta);
    const database = this;
    let finished = false;
    const tx = {
      error: null, oncomplete: null, onabort: null, onerror: null,
      objectStore(name) {
        assert.ok(storeNames.includes(name));
        const target = name === 'entries' ? stagedEntries : name === 'attachments' ? stagedAttachments : stagedMeta;
        return {
          clear() { assert.equal(mode, 'readwrite'); target.clear(); },
          delete(id) { assert.equal(mode, 'readwrite'); target.delete(id); },
          get(id) {
            const request = {};
            queueMicrotask(() => { request.result = target.get(id); request.onsuccess?.(); });
            return request;
          },
          getAll() {
            const request = {};
            queueMicrotask(() => { request.result = [...target.values()]; request.onsuccess?.(); });
            return request;
          },
          put(value) {
            assert.equal(mode, 'readwrite');
            if (name === 'attachments' && database.attachmentError) {
              tx.error = database.attachmentError;
              queueMicrotask(() => { if (!finished) { finished = true; tx.onabort?.(); } });
              return;
            }
            target.set(name === 'meta' ? value.key : value.id, value);
          }
        };
      },
      abort() {
        if (finished) throw new DOMException('Transaction inactive', 'InvalidStateError');
        finished = true; queueMicrotask(() => tx.onabort?.());
      }
    };
    setTimeout(() => {
      if (finished || tx.error) return;
      finished = true;
      if (mode === 'readwrite') {
        database.entries = stagedEntries; database.attachments = stagedAttachments; database.meta = stagedMeta;
      }
      tx.oncomplete?.();
    });
    return tx;
  }
}

async function imageFixture() {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const blob = new Blob([bytes], { type: 'image/png' });
  const file = new File([bytes], 'synced.png', { type: 'image/png' });
  return { entry: createImageEntry(file, await sha256(blob), 'att-atomic'), blob };
}

test('deleted capture image can be received with a new job ID while its old tombstone is preserved', async () => {
  const database = new AtomicFakeDatabase();
  const repository = new PocketRepository(database);
  const { entry, blob } = await imageFixture();
  const old = { ...entry, id: 'capture-old-image', attachment: { ...entry.attachment, id: `att-${entry.attachment.hash}` } };
  assert.equal(await repository.commitCapture(old, blob, 'device-a'), 'saved');
  assert.equal(await repository.commitCapture(old, blob, 'device-a'), 'duplicate', 'retry of same job is idempotent');

  const beforeDelete = await repository.readSyncSnapshot();
  const deleted = recordLocalChanges(beforeDelete.entries, [], {
    deviceId: 'device-a', journal: beforeDelete.journal, tombstones: beforeDelete.tombstones
  });
  await repository.replaceBundle(deleted.entries, new Map(), {
    expectedRevision: beforeDelete.revision,
    deleteAttachmentIds: [old.attachment.id],
    meta: { 'sync-journal': deleted.journal, 'sync-tombstones': deleted.tombstones }
  });
  assert.equal(database.entries.size, 0);
  assert.equal(database.attachments.size, 0);

  const fresh = { ...old, id: 'capture-new-image' };
  assert.equal(await repository.commitCapture(fresh, blob, 'device-a'), 'saved', 'new job after deletion may create a new item');
  assert.equal(await repository.commitCapture(fresh, blob, 'device-a'), 'duplicate', 'repeat of new job must not duplicate');
  const final = await repository.readSyncSnapshot();
  assert.deepEqual(final.entries.map(row => row.id), [fresh.id]);
  assert.equal(final.tombstones[old.id]?.operation, 'delete', 'old tombstone must not be resurrected');
  assert.equal(final.tombstones[fresh.id], undefined, 'new image must not be a tombstone');
  assert.equal(database.attachments.has(old.attachment.id), true);
});

test('replaceBundle 在同一個 entries + attachments transaction 原子寫入', async () => {
  const original = createEntry({ url: 'https://example.com/original' });
  const database = new AtomicFakeDatabase({ entries: [original] });
  const repository = new PocketRepository(database);
  const { entry, blob } = await imageFixture();
  const saved = await repository.replaceBundle([entry], new Map([[entry.attachment.id, blob]]));
  assert.deepEqual(database.lastStores, ['entries', 'attachments', 'meta']);
  assert.deepEqual([...database.entries.keys()], [entry.id]);
  assert.equal(database.attachments.get(entry.attachment.id).blob, blob);
  assert.deepEqual(saved, [entry]);
});

test('讀取投影後新增另一筆，不會大量改寫歷史類型、未知欄位或原始標籤', async () => {
  const raw = { id: 'unchanged-legacy', url: 'https://example.org/legacy', type: '工具', category: '舊分類', tags: ['原有'], createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z', historicalField: '保留未知欄位' };
  const { validatedEntry } = await import('../lib.mjs');
  const database = new AtomicFakeDatabase({ entries: [raw] });
  const repository = new PocketRepository(database);
  const added = createEntry({ url: 'https://example.org/new' });
  await repository.replaceBundle([validatedEntry(raw), added]);
  assert.deepEqual(database.entries.get(raw.id), raw);
  assert.equal(database.entries.get(added.id).type, '網頁');
});

test('replaceBundle 附件寫入錯誤時收藏紀錄與附件全部回滾', async () => {
  const original = createEntry({ url: 'https://example.com/original' });
  const database = new AtomicFakeDatabase({ entries: [original], attachmentError: new DOMException('disk failure', 'UnknownError') });
  const repository = new PocketRepository(database);
  const { entry, blob } = await imageFixture();
  await assert.rejects(() => repository.replaceBundle([entry], new Map([[entry.attachment.id, blob]])), /本機資料庫無法寫入/);
  assert.deepEqual([...database.entries.keys()], [original.id]);
  assert.equal(database.attachments.size, 0);
});

test('replaceBundle 容量不足時回滾並提供可行動錯誤', async () => {
  const original = createEntry({ url: 'https://example.com/original' });
  const database = new AtomicFakeDatabase({ entries: [original], attachmentError: new DOMException('quota', 'QuotaExceededError') });
  const repository = new PocketRepository(database);
  const { entry, blob } = await imageFixture();
  await assert.rejects(() => repository.replaceBundle([entry], new Map([[entry.attachment.id, blob]])), /空間不足.*資料未變更/);
  assert.deepEqual([...database.entries.keys()], [original.id]);
  assert.equal(database.attachments.size, 0);
});

test('同步讀取的舊快照不得在手動編輯成功後覆寫本機資料及同步日誌', async () => {
  const before = createEntry({ url: 'https://example.org/article', note: '原備註' });
  const database = new AtomicFakeDatabase({ entries: [before] });
  const repository = new PocketRepository(database);
  const staleSnapshot = await repository.readSyncSnapshot(); // network sync begins here

  const updated = { ...before, note: 'Windows 已儲存的新備註' };
  const saved = await repository.replaceBundle([updated], new Map(), {
    expectedRevision: staleSnapshot.revision,
    meta: { 'sync-journal': { local: { operation: 'upsert' } } }
  });
  assert.equal(saved.dataRevision, 1);
  await assert.rejects(
    () => repository.replaceBundle([before], new Map(), {
      expectedRevision: staleSnapshot.revision,
      meta: { 'sync-journal': { remote: { operation: 'upsert' } } }
    }),
    error => error instanceof StaleDataError
  );
  const after = await repository.readSyncSnapshot();
  assert.equal(after.entries[0].note, 'Windows 已儲存的新備註');
  assert.deepEqual(after.journal, { local: { operation: 'upsert' } });
  assert.equal(after.revision, 1, '失敗的同步不得推進版本或覆寫 journal');
});

test('同步寫入較新資料後，過期的本機編輯也不得整批覆寫收藏', async () => {
  const original = createEntry({ url: 'https://example.org/post', title: '原標題' });
  const database = new AtomicFakeDatabase({ entries: [original] });
  const repository = new PocketRepository(database);
  const staleEditor = await repository.readSyncSnapshot();
  const fresh = { ...original, title: '同步取得的新標題' };
  await repository.replaceBundle([fresh], new Map(), { expectedRevision: staleEditor.revision });
  await assert.rejects(
    () => repository.replaceBundle([{ ...original, note: '舊編輯視窗的新備註' }], new Map(), { expectedRevision: staleEditor.revision }),
    error => error instanceof StaleDataError
  );
  assert.equal((await repository.readSyncSnapshot()).entries[0].title, '同步取得的新標題');
});

test('沒有衝突時同步合併仍可寫入，資料版本在同一交易中前進', async () => {
  const database = new AtomicFakeDatabase();
  const repository = new PocketRepository(database);
  const first = await repository.readSyncSnapshot();
  const row = createEntry({ url: 'https://example.org/first' });
  await repository.replaceBundle([row], new Map(), { expectedRevision: first.revision });
  const next = await repository.readSyncSnapshot();
  assert.equal(next.revision, first.revision + 1);
  const newer = { ...next.entries[0], type: '社群', classification: { status: 'manual', evidence: 'user' } };
  await repository.replaceBundle([newer], new Map(), { expectedRevision: next.revision });
  const final = await repository.readSyncSnapshot();
  assert.equal(final.entries[0].classification.status, 'manual');
  assert.equal(final.entries[0].type, '社群');
  assert.equal(final.revision, next.revision + 1);
});
