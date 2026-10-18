import test from 'node:test';
import assert from 'node:assert/strict';
import { PocketRepository } from '../db.mjs';
import { createEntry, createImageEntry, sha256 } from '../lib.mjs';

class AtomicFakeDatabase {
  constructor({ entries = [], attachments = [], attachmentError = null } = {}) {
    this.entries = new Map(entries.map(value => [value.id, structuredClone(value)]));
    this.attachments = new Map(attachments.map(value => [value.id, value]));
    this.attachmentError = attachmentError;
    this.lastStores = [];
  }

  transaction(storeNames, mode) {
    assert.equal(mode, 'readwrite');
    this.lastStores = [...storeNames];
    const stagedEntries = new Map(this.entries);
    const stagedAttachments = new Map(this.attachments);
    const database = this;
    let finished = false;
    const tx = {
      error: null, oncomplete: null, onabort: null, onerror: null,
      objectStore(name) {
        const target = name === 'entries' ? stagedEntries : stagedAttachments;
        return {
          clear() { target.clear(); },
          put(value) {
            if (name === 'attachments' && database.attachmentError) {
              tx.error = database.attachmentError;
              queueMicrotask(() => { if (!finished) { finished = true; tx.onabort?.(); } });
              return;
            }
            target.set(value.id, value);
          }
        };
      },
      abort() {
        if (finished) throw new DOMException('Transaction inactive', 'InvalidStateError');
        finished = true; queueMicrotask(() => tx.onabort?.());
      }
    };
    queueMicrotask(() => {
      if (finished || tx.error) return;
      finished = true; database.entries = stagedEntries; database.attachments = stagedAttachments; tx.oncomplete?.();
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

test('replaceBundle 在同一個 entries + attachments transaction 原子寫入', async () => {
  const original = createEntry({ url: 'https://example.com/original' });
  const database = new AtomicFakeDatabase({ entries: [original] });
  const repository = new PocketRepository(database);
  const { entry, blob } = await imageFixture();
  const saved = await repository.replaceBundle([entry], new Map([[entry.attachment.id, blob]]));
  assert.deepEqual(database.lastStores, ['entries', 'attachments']);
  assert.deepEqual([...database.entries.keys()], [entry.id]);
  assert.equal(database.attachments.get(entry.attachment.id).blob, blob);
  assert.deepEqual(saved, [entry]);
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
