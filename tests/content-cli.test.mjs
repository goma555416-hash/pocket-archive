import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute=promisify(execFile);
const collector=fileURLToPath(new URL('../scripts/collect-content-evidence.mjs', import.meta.url));
const validator=fileURLToPath(new URL('../scripts/validate-organized.mjs', import.meta.url));

test('private evidence CLI runs with social URL offline without attempting a platform fetch', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pa-content-'));
 try {
  const inbox={format:'pocket-archive-inbox',schema_version:2,export_id:'export-cli-fixture',items:[
   {id:'video-example',kind:'link',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',title:'public title only',note:'',attachment:null}
  ]};
  await writeFile(join(dir,'inbox.json'),JSON.stringify(inbox));
  await execute(process.execPath,[collector,join(dir,'inbox.json')],{cwd:dir,timeout:5000});
  const results=JSON.parse(await readFile(join(dir,'private-data','content-evidence-export-cli-fixture.json'),'utf8'));
  assert.equal(results.items.length,1);
  assert.equal(results.items[0].evidence.status,'unavailable');
  assert.equal(results.items[0].evidence.kind,'metadata');
  assert.equal(results.source_export_id,inbox.export_id);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test('strict organized validator requires a receipt even for backward-compatible legacy results',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pa-validator-'));
 try {
  const input={format:'pocket-archive-inbox',schema_version:2,export_id:'export-cli-validation',items:[
   {id:'one',kind:'link',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',title:'Title',note:'',tags:[],attachment:null}
  ]};
  const organized={format:'pocket-archive-organized',schema_version:2,source_export_id:input.export_id,items:[
   {id:'one',analysis_status:'insufficient_data',suggested_tags:[],suggested_categories:[],
    summary:'',reason:'只讀到標題',confidence:'low'}
  ]};
  const inputFile=join(dir,'inbox.json'),outputFile=join(dir,'organized.json');
  await writeFile(inputFile,JSON.stringify(input));
  await writeFile(outputFile,JSON.stringify(organized));
  await execute(process.execPath,[validator,outputFile,inputFile],{cwd:dir,timeout:5000});
  await assert.rejects(execute(process.execPath,[validator,outputFile,inputFile,'--require-evidence'],{cwd:dir,timeout:5000}),/未提供內容讀取證據/);
  organized.items[0].evidence={status:'metadata_only',kind:'metadata',source_url:input.items[0].url,excerpt:'',observed_at:'2026-10-23T12:00:00.000Z'};
  await writeFile(outputFile,JSON.stringify(organized));
  await execute(process.execPath,[validator,outputFile,inputFile,'--require-evidence'],{cwd:dir,timeout:5000});
 } finally { await rm(dir,{recursive:true,force:true}); }
});
