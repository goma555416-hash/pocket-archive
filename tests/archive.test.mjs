import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, readZip, decodeText, crc32 } from '../archive.mjs';
import { createImageEntry, createBackupEnvelope, readBackup, sha256 } from '../lib.mjs';

test('ZIP 儲存格式可離線完整往返 JSON 與二進位附件', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const zip = await createZip([{ name: 'backup.json', data: '{"ok":true}' }, { name: 'attachments/att-1', data: image }]);
  const files = await readZip(zip);
  assert.equal(decodeText(files.get('backup.json')), '{"ok":true}');
  assert.deepEqual(files.get('attachments/att-1'), image);
});

test('含圖片的 Pocket Archive 完整備份可 ZIP 往返還原', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([bytes], 'archive.png', { type: 'image/png' });
  const entry = createImageEntry(file, await sha256(file), 'att-roundtrip');
  const envelope = createBackupEnvelope([entry], '2026-10-17T00:00:00Z');
  const zip = await createZip([{ name: 'backup.json', data: JSON.stringify(envelope) }, { name: entry.attachment.path, data: file }]);
  const contents = await readZip(zip);
  const restored = readBackup(decodeText(contents.get('backup.json')));
  assert.deepEqual(restored.entries, [entry]);
  assert.deepEqual(contents.get(entry.attachment.path), bytes);
});

test('ZIP 拒絕路徑穿越、絕對路徑與重複路徑', async () => {
  await assert.rejects(createZip([{ name: '../secret', data: 'x' }]), /不安全路徑/);
  await assert.rejects(createZip([{ name: '/secret', data: 'x' }]), /不安全路徑/);
  await assert.rejects(createZip([{ name: 'same', data: 'x' }, { name: 'same', data: 'y' }]), /重複/);
});

test('ZIP CRC 損毀會被偵測', async () => {
  const zip = await createZip([{ name: 'backup.json', data: 'hello' }]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  bytes[30 + 'backup.json'.length] ^= 0xff;
  await assert.rejects(readZip(bytes), /驗證失敗/);
});

test('CRC32 使用標準測試向量', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
