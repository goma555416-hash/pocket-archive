import assert from 'node:assert/strict';
import test from 'node:test';
import { createEntry, sha256 } from '../lib.mjs';
import { createMigrationManifest, mergeMigrationAi, readMigrationManifest } from '../migration.mjs';
import { makeDeleteRecord, makeUpsertRecord } from '../sync.mjs';

test('migration manifest round-trips causal metadata without credentials', async () => {
  const entry = createEntry({ url: 'https://example.com/item', title: '保留', type: '文章' });
  const upsert = makeUpsertRecord(entry, 'old-device', '2026-10-18T00:00:00.000Z');
  const deletion = makeDeleteRecord(upsert.entry, 'old-device', '2026-10-18T00:01:00.000Z');
  const backup = new TextEncoder().encode('{"format":"pocket-archive-backup"}');
  const manifest = createMigrationManifest({
    backupSha256: await sha256(backup), sourceOrigin: 'https://old.example', sourceDeviceId: 'old-device',
    syncJournal: { [entry.id]: upsert.record }, tombstones: { [entry.id]: deletion }, exportIds: ['export-1'],
    cloudJobs: [{ exportId: 'export-1', resultFileId: 'result_1234', status: 'ready', createdAt: '2026-10-18T00:00:00Z', token: 'must-drop' }],
    driveWorkspace: { root: 'root_1234', secret: 'must-drop' }
  });
  const restored = readMigrationManifest(JSON.stringify(manifest));
  assert.equal(restored.sourceOrigin, 'https://old.example'); assert.equal(restored.tombstones[entry.id].operation, 'delete');
  assert.equal(restored.cloudJobs[0].token, undefined); assert.equal(restored.driveWorkspace.secret, undefined);
  assert.deepEqual(restored.exportIds, ['export-1']);
});

test('migration manifest rejects unsupported schema and unsafe origin', async () => {
  assert.throws(() => readMigrationManifest({ format: 'wrong', schema_version: 1 }), /格式或版本/);
  assert.throws(() => createMigrationManifest({ backupSha256: 'a'.repeat(64), sourceOrigin: 'javascript:alert(1)', sourceDeviceId: 'device' }), /origin/);
});

test('migration AI metadata merges by export id and preserves newest source record', () => {
  const merged = mergeMigrationAi(['old-export'], [{ exportId: 'same', status: 'pending' }], { exportIds: ['new-export'], cloudJobs: [{ exportId: 'same', status: 'ready' }] });
  assert.deepEqual(merged.exportIds, ['new-export', 'old-export']); assert.equal(merged.cloudJobs[0].status, 'ready'); assert.equal(merged.cloudJobs.length, 1);
});
