#!/usr/bin/env node
// Only runs after explicit Codex batch handoff. Writes private evidence locally
// (private-data/ is gitignored), never the repository or production Worker.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readZip, decodeText } from '../archive.mjs';
import { collectArticleEvidence } from '../codex-article-reader.mjs';

const input=process.argv[2];
if(!input || process.argv.length!==3) {
  process.stderr.write('用法：node scripts/collect-content-evidence.mjs <inbox.json|inbox.zip>\n');
  process.exit(2);
}
try {
  const bytes=await readFile(input);
  if(bytes.byteLength>100*1024*1024) throw new Error('批次檔案超過安全大小上限');
  let json;
  if(input.toLowerCase().endsWith('.zip')) {
    const files=await readZip(new Uint8Array(bytes));
    const file=files.get('inbox.json');
    if(!file) throw new Error('ZIP 缺少根目錄 inbox.json');
    json=decodeText(file);
  } else json=bytes.toString('utf8');
  const inbox=JSON.parse(json);
  if(inbox.format!=='pocket-archive-inbox' || inbox.schema_version!==2 ||
    !/^export-[A-Za-z0-9._:-]{1,110}$/.test(inbox.export_id||'') ||
    !Array.isArray(inbox.items) || inbox.items.length>100 ||
    new Set(inbox.items.map(x=>x.id)).size!==inbox.items.length) {
    throw new Error('批次格式/ID/筆數無效；請拆成最多 100 筆的批次');
  }
  const receipts=[];
  for(const item of inbox.items) {
    if(typeof item?.id!=='string' || typeof item?.url!=='string') throw new Error('項目欄位無效');
    // Images are inspected by Codex using raw ZIP bytes and their SHA-256;
    // this HTML-only helper cannot claim to read pixels or social posts.
    const evidence=item.attachment ?
      {status:'unavailable',kind:'metadata',excerpt:'',source_url:item.url,
        observed_at:new Date().toISOString(),reason:'image_requires_visual_inspection'} :
      await collectArticleEvidence(item);
    receipts.push({id:item.id,evidence});
    process.stderr.write('已檢查 '+receipts.length+'/'+inbox.items.length+'，狀態：'+evidence.status+'\n');
  }
  await mkdir('private-data',{recursive:true,mode:0o700});
  const output=join('private-data','content-evidence-'+inbox.export_id+'.json');
  await writeFile(output,JSON.stringify({
    format:'pocket-archive-content-evidence',schema_version:1,
    source_export_id:inbox.export_id,items:receipts
  },null,2),{mode:0o600,flag:'wx'});
  process.stdout.write('本機證據紀錄：'+output+'（僅供本批 Codex 使用，禁止提交 GitHub）\n');
} catch(error) {
  process.stderr.write('內容取得停止：'+error.message+'\n');
  process.exitCode=1;
}
