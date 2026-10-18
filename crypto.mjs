import { sha256 } from './lib.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAGIC = encoder.encode('PAENC1\n');
const ITERATIONS = 250000;

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function cryptoApi() {
  if (!globalThis.crypto?.subtle) throw new Error('此瀏覽器不支援安全加密，無法建立加密備份');
  return globalThis.crypto;
}

async function deriveKey(passphrase, salt, iterations, usage) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('加密密碼至少需要 12 個字元');
  const base = await cryptoApi().subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return cryptoApi().subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export function isEncryptedBackup(blob) {
  return blob?.type === 'application/vnd.pocket-archive.encrypted' || String(blob?.name || '').endsWith('.paenc');
}

export async function encryptBackup(blob, passphrase, { filename = 'pocket-archive-backup.zip', iterations = ITERATIONS } = {}) {
  const source = new Uint8Array(await blob.arrayBuffer());
  const salt = cryptoApi().getRandomValues(new Uint8Array(16));
  const iv = cryptoApi().getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations, 'encrypt');
  const ciphertext = new Uint8Array(await cryptoApi().subtle.encrypt({ name: 'AES-GCM', iv }, key, source));
  const header = encoder.encode(JSON.stringify({
    format: 'pocket-archive-encrypted-backup', version: 1, cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256', iterations, salt: bytesToBase64(salt), iv: bytesToBase64(iv),
    filename, mime_type: blob.type || 'application/octet-stream', plaintext_sha256: await sha256(source)
  }));
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, header.length, false);
  return new Blob([MAGIC, length, header, ciphertext], { type: 'application/vnd.pocket-archive.encrypted' });
}

export async function decryptBackup(blob, passphrase) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < MAGIC.length + 4 || !MAGIC.every((byte, index) => bytes[index] === byte)) throw new Error('這不是 Pocket Archive 加密備份');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset + MAGIC.length, 4).getUint32(0, false);
  const headerStart = MAGIC.length + 4; const bodyStart = headerStart + headerLength;
  if (headerLength < 2 || bodyStart >= bytes.length || headerLength > 64 * 1024) throw new Error('加密備份標頭損毀');
  let header;
  try { header = JSON.parse(decoder.decode(bytes.slice(headerStart, bodyStart))); } catch { throw new Error('加密備份標頭不是有效 JSON'); }
  if (header.format !== 'pocket-archive-encrypted-backup' || header.version !== 1 || header.cipher !== 'AES-256-GCM') throw new Error('不支援的加密備份格式');
  const salt = base64ToBytes(header.salt); const iv = base64ToBytes(header.iv);
  const key = await deriveKey(passphrase, salt, Number(header.iterations), 'decrypt');
  let plaintext;
  try { plaintext = new Uint8Array(await cryptoApi().subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(bodyStart))); }
  catch { throw new Error('無法解密備份：密碼錯誤或檔案已損毀'); }
  if (await sha256(plaintext) !== header.plaintext_sha256) throw new Error('解密後的完整性驗證失敗');
  return { blob: new Blob([plaintext], { type: header.mime_type }), filename: header.filename, header };
}
