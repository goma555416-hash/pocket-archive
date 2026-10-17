const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const MAX_FILES = 25000;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[value] = crc >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

function safePath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`ZIP 內含不安全路徑：${name}`);
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`ZIP 內含不安全路徑：${name}`);
  return name;
}

async function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return encoder.encode(value);
  if (value?.arrayBuffer) return new Uint8Array(await value.arrayBuffer());
  throw new Error('ZIP 檔案內容格式不支援');
}

export async function createZip(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('ZIP 不可為空');
  if (files.length > MAX_FILES) throw new Error('ZIP 檔案數量過多');
  const prepared = [];
  let offset = 0;
  let total = 0;
  const names = new Set();
  for (const file of files) {
    const name = safePath(String(file.name || ''));
    if (names.has(name)) throw new Error(`ZIP 路徑重複：${name}`);
    names.add(name);
    const data = await bytesOf(file.data);
    total += data.byteLength;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('ZIP 未壓縮內容超過 300 MB');
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    u32(view, 0, 0x04034b50); u16(view, 4, 20); u16(view, 6, 0x0800); u16(view, 8, 0);
    u16(view, 10, 0); u16(view, 12, 0); u32(view, 14, crc); u32(view, 18, data.length); u32(view, 22, data.length);
    u16(view, 26, nameBytes.length); u16(view, 28, 0);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    prepared.push({ nameBytes, data, crc, offset, local });
    offset += local.length;
  }
  const centralStart = offset;
  const centralParts = [];
  for (const file of prepared) {
    const central = new Uint8Array(46 + file.nameBytes.length);
    const view = new DataView(central.buffer);
    u32(view, 0, 0x02014b50); u16(view, 4, 20); u16(view, 6, 20); u16(view, 8, 0x0800); u16(view, 10, 0);
    u16(view, 12, 0); u16(view, 14, 0); u32(view, 16, file.crc); u32(view, 20, file.data.length); u32(view, 24, file.data.length);
    u16(view, 28, file.nameBytes.length); u16(view, 30, 0); u16(view, 32, 0); u16(view, 34, 0); u16(view, 36, 0);
    u32(view, 38, 0); u32(view, 42, file.offset); central.set(file.nameBytes, 46);
    centralParts.push(central); offset += central.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50); u16(endView, 4, 0); u16(endView, 6, 0);
  u16(endView, 8, prepared.length); u16(endView, 10, prepared.length);
  u32(endView, 12, offset - centralStart); u32(endView, 16, centralStart); u16(endView, 20, 0);
  return new Blob([...prepared.map(file => file.local), ...centralParts, end], { type: 'application/zip' });
}

async function inflateRaw(bytes) {
  if (!globalThis.DecompressionStream) throw new Error('此瀏覽器無法解壓縮這個 ZIP；請使用 Pocket Archive 匯出的未壓縮 ZIP');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(input) {
  const bytes = await bytesOf(input);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ZIP 檔案超過 300 MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let offset = 0;
  let inflatedTotal = 0;
  while (offset + 4 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || offset + 30 > bytes.length) throw new Error('ZIP 結構損毀或不受支援');
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    if (flags & 0x0008) throw new Error('不支援使用 data descriptor 的 ZIP');
    if (![0, 8].includes(method)) throw new Error('ZIP 使用了不支援的壓縮方式');
    const expectedCrc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error('ZIP 內容不完整');
    const name = safePath(decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength)));
    if (files.has(name)) throw new Error(`ZIP 路徑重複：${name}`);
    let content = bytes.slice(dataStart, dataEnd);
    if (method === 8) content = await inflateRaw(content);
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) throw new Error(`ZIP 檔案驗證失敗：${name}`);
    inflatedTotal += content.length;
    if (inflatedTotal > MAX_ARCHIVE_BYTES) throw new Error('ZIP 解壓縮內容超過 300 MB');
    files.set(name, content);
    if (files.size > MAX_FILES) throw new Error('ZIP 檔案數量過多');
    offset = dataEnd;
  }
  if (!files.size) throw new Error('ZIP 中沒有可讀檔案');
  return files;
}

export function decodeText(bytes) { return decoder.decode(bytes); }
