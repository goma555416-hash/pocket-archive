#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { INBOX_FORMAT, SCHEMA_VERSION, readOrganized } from '../lib.mjs';
import { readZip, decodeText } from '../archive.mjs';

const [organizedPath, inboxPath] = process.argv.slice(2);
if (!organizedPath || !inboxPath) {
  process.stderr.write('用法：node scripts/validate-organized.mjs organized.json inbox.json|inbox.zip\n');
  process.exit(2);
}

try {
  const organizedText = await readFile(organizedPath, 'utf8');
  let inboxText;
  if (inboxPath.toLowerCase().endsWith('.zip')) {
    const files = await readZip(new Uint8Array(await readFile(inboxPath)));
    const manifest = files.get('inbox.json');
    if (!manifest) throw new Error('inbox ZIP 根目錄缺少 inbox.json');
    inboxText = decodeText(manifest);
  } else inboxText = await readFile(inboxPath, 'utf8');
  const inbox = JSON.parse(inboxText);
  if (inbox.format !== INBOX_FORMAT || inbox.schema_version !== SCHEMA_VERSION || typeof inbox.export_id !== 'string' || !Array.isArray(inbox.items)) throw new Error('inbox 格式或 schema_version 不正確');
  const result = readOrganized(organizedText, { exportIds: [inbox.export_id], entries: inbox.items });
  if (result.rejected.length) throw new Error(`${result.rejected.length} 筆結果被拒絕：${result.rejected.slice(0, 5).map(item => `${item.id || '(no id)'} (${item.reason})`).join(', ')}`);
  const inputIds = new Set(inbox.items.map(item => item.id));
  const outputIds = new Set(result.accepted.map(item => item.id));
  const missing = [...inputIds].filter(id => !outputIds.has(id));
  if (missing.length) throw new Error(`缺少 ${missing.length} 筆輸出：${missing.slice(0, 10).join(', ')}`);
  if (outputIds.size !== inputIds.size) throw new Error('輸出含重複或額外 ID');
  process.stdout.write(`驗證通過：${basename(organizedPath)}，${result.accepted.length} 筆，source_export_id=${inbox.export_id}\n`);
} catch (error) {
  process.stderr.write(`驗證失敗：${error.message}\n`);
  process.exit(1);
}
