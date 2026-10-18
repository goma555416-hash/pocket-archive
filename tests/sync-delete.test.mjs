import test from 'node:test';
import assert from 'node:assert/strict';
import { validatedEntry } from '../lib.mjs';
import { CloudSyncService } from '../cloud.mjs';
import {
  pruneResolvedConflicts, recordLocalChanges, reconcileReplica, replicaRecord, resolveConflict
} from '../sync.mjs';

function zipEntry(id = 'zip-shared') {
  return validatedEntry({
    id, url: `https://example.com/${id}`, title: 'ZIP 共同收藏', note: '相同原始資料',
    createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z'
  });
}

function memoryDrive() {
  const files = new Map(); let sequence = 0;
  return {
    files,
    async listFiles({ parentId, name, appRole }) {
      return { files: [...files.values()].filter(file =>
        (!parentId || file.parentId === parentId) && (!name || file.name === name) && (!appRole || file.appProperties?.paRole === appRole)) };
    },
    async createFile(value) {
      const file = { id: `drive-${++sequence}`, ...value, createdTime: new Date().toISOString(), size: String(value.blob?.size || 0) };
      files.set(file.id, file); return file;
    },
    async updateContent(id, blob) {
      const file = files.get(id); file.blob = blob; file.size = String(blob.size); return file;
    },
    async downloadFile(id) { return files.get(id).blob; }
  };
}

function device(id, copiedEntries) {
  const bootstrap = recordLocalChanges([], structuredClone(copiedEntries), {
    deviceId: id, now: `2026-10-18T00:00:0${id === 'windows' ? 1 : 2}.000Z`
  });
  return { id, entries: bootstrap.entries, journal: bootstrap.journal, tombstones: bootstrap.tombstones, conflicts: [] };
}

function repository() { return { getAttachment: async () => null }; }

async function syncDevice(service, replica) {
  const result = await service.sync({ ...replica, deviceId: replica.id, repository: repository() });
  replica.entries = result.entries;
  replica.journal = result.journal;
  replica.tombstones = result.tombstones;
  const keys = new Map([...replica.conflicts, ...result.conflicts].map(conflict => [
    `${conflict.itemId}:${JSON.stringify(conflict.local.clock)}:${JSON.stringify(conflict.remote.clock)}`, conflict
  ]));
  replica.conflicts = pruneResolvedConflicts([...keys.values()], replica.entries, replica.tombstones);
  return result;
}

function mutate(replica, entries, now) {
  const result = recordLocalChanges(replica.entries, entries, {
    deviceId: replica.id, journal: replica.journal, tombstones: replica.tombstones, now
  });
  replica.entries = result.entries; replica.journal = result.journal; replica.tombstones = result.tombstones;
}

async function zipReplicas() {
  const drive = memoryDrive();
  const service = new CloudSyncService(drive, { sync: 'sync', syncAttachments: 'attachments' });
  const copied = [zipEntry()];
  const windows = device('windows', copied); const iphone = device('iphone', copied);
  await syncDevice(service, windows); await syncDevice(service, iphone);
  return { drive, service, windows, iphone, originalWindowsRecord: structuredClone(windows.journal[copied[0].id]), itemId: copied[0].id };
}

test('ZIP 複製的相同收藏合併因果時鐘，不產生假衝突', async () => {
  const { service, windows, iphone, itemId } = await zipReplicas();
  assert.equal(iphone.conflicts.length, 0);
  assert.deepEqual(iphone.entries[0].sync.clock, { iphone: 1, windows: 1 });
  await syncDevice(service, windows);
  assert.equal(windows.conflicts.length, 0);
  assert.deepEqual(windows.entries[0].sync.clock, { iphone: 1, windows: 1 });
  assert.equal(windows.journal[itemId].operation, 'upsert');
});

test('ZIP 初始複製後立即修改可吸收另一端未變更的 bootstrap 版本', async () => {
  const { service, windows, iphone } = await zipReplicas();
  const edited = validatedEntry({ ...windows.entries[0], title: 'Windows 修改', updatedAt: '2026-10-18T00:00:30.000Z' });
  mutate(windows, [edited], '2026-10-18T00:00:30.000Z');
  await syncDevice(service, windows);
  assert.equal(windows.conflicts.length, 0);
  await syncDevice(service, iphone);
  assert.equal(iphone.entries[0].title, 'Windows 修改');
  assert.equal(iphone.conflicts.length, 0);
  assert.deepEqual(iphone.entries[0].sync.clock, { iphone: 1, windows: 2 });
});

for (const [deleterName, receiverName] of [['windows', 'iphone'], ['iphone', 'windows']]) {
  test(`${deleterName} 刪除會同步至 ${receiverName}，相同 ZIP 舊 upsert 不會復活`, async () => {
    const context = await zipReplicas();
    const deleter = context[deleterName]; const receiver = context[receiverName];
    mutate(deleter, [], '2026-10-18T00:01:00.000Z');
    await syncDevice(context.service, deleter);
    await syncDevice(context.service, receiver);
    assert.equal(receiver.entries.length, 0);
    assert.equal(receiver.tombstones[context.itemId].operation, 'delete');
    assert.equal(receiver.conflicts.length, 0);
  });
}

test('裝置離線期間的刪除會在恢復連線後套用', async () => {
  const { service, windows, iphone, itemId } = await zipReplicas();
  mutate(windows, [], '2026-10-18T00:02:00.000Z');
  await syncDevice(service, windows);
  assert.equal(iphone.entries.length, 1, '離線裝置尚未被本機強制清空');
  await syncDevice(service, iphone);
  assert.equal(iphone.entries.length, 0);
  assert.ok(iphone.tombstones[itemId]);
});

test('真正的並行編輯／刪除保留衝突，選擇刪除後兩端收斂', async () => {
  const { service, windows, iphone, itemId } = await zipReplicas();
  await syncDevice(service, windows);
  const edited = validatedEntry({ ...iphone.entries[0], title: 'iPhone 離線編輯', updatedAt: '2026-10-18T00:03:00.000Z' });
  mutate(iphone, [edited], '2026-10-18T00:03:00.000Z');
  mutate(windows, [], '2026-10-18T00:03:01.000Z');
  await syncDevice(service, windows);
  await syncDevice(service, iphone);
  assert.equal(iphone.entries[0].title, 'iPhone 離線編輯', '並行編輯不會被靜默刪除');
  assert.ok(iphone.conflicts.length > 0);

  const conflict = iphone.conflicts.find(value => value.itemId === itemId && (value.local.operation === 'delete' || value.remote.operation === 'delete'));
  const choice = conflict.local.operation === 'delete' ? 'local' : 'remote';
  const oldEditedRecord = conflict.local.operation === 'upsert' ? conflict.local : conflict.remote;
  const current = replicaRecord(iphone.entries[0], iphone.tombstones[itemId]);
  const resolution = resolveConflict(conflict, choice, iphone.id, '2026-10-18T00:04:00.000Z', current);
  const oldEditReplay = reconcileReplica([], { [itemId]: resolution.record }, [oldEditedRecord]);
  assert.equal(oldEditReplay.entries.length, 0, '衝突決議已觀察的舊編輯 journal 不得復活收藏');
  assert.equal(oldEditReplay.conflicts.length, 0);
  iphone.entries = [];
  iphone.tombstones[itemId] = resolution.record;
  iphone.journal[itemId] = resolution.record;
  iphone.conflicts = pruneResolvedConflicts(iphone.conflicts, iphone.entries, iphone.tombstones);
  assert.equal(iphone.conflicts.length, 0);

  await syncDevice(service, iphone); await syncDevice(service, windows); await syncDevice(service, iphone);
  assert.equal(windows.entries.length, 0); assert.equal(iphone.entries.length, 0);
  assert.equal(windows.conflicts.length, 0); assert.equal(iphone.conflicts.length, 0);
});

test('較新的 tombstone 淘汰舊衝突，舊 journal 無法復活已確認刪除', async () => {
  const { service, windows, iphone, itemId, originalWindowsRecord } = await zipReplicas();
  const oldIphoneRecord = structuredClone(iphone.journal[itemId]);
  const staleConflict = {
    itemId, local: originalWindowsRecord, remote: oldIphoneRecord,
    observedClock: { windows: 1, iphone: 1 }, chosen: 'remote'
  };
  mutate(windows, [], '2026-10-18T00:05:00.000Z');
  await syncDevice(service, windows); await syncDevice(service, iphone);
  assert.equal(pruneResolvedConflicts([staleConflict], iphone.entries, iphone.tombstones).length, 0);

  const staleDecision = resolveConflict(staleConflict, 'remote', 'iphone', '2026-10-18T00:06:00.000Z');
  const replay = reconcileReplica([], iphone.tombstones, [oldIphoneRecord, staleDecision.record]);
  assert.equal(replay.entries.length, 0);
  assert.equal(replay.conflicts.length, 0);
  assert.equal(replay.tombstones[itemId].operation, 'delete');
});
