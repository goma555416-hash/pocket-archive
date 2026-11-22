import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { executeBatch } from '../scripts/windows/execute-batch.mjs';
import { waitFor } from './helpers/wait.mjs';
test('manual sleep observer permits exit notification after a sleep longer than its watchdog',async()=>{
  let time=0,ticks=0;
  const options={resumeGrace:true,now:()=>time,pause:async()=>{time+=++ticks===1?190000:100;}};
  await waitFor(()=>ticks===3,180000,options);
  ticks=0;time=0;
  await assert.rejects(waitFor(()=>ticks===3,180000,{...options,resumeGrace:false}),/timed out/);
});
test('runner validates binding and evidence before handing bytes to broker',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pa-runner-'));
  try{
    const inbox={format:'pocket-archive-inbox',schema_version:2,export_id:'export-runner',items:[{id:'a',url:'https://example.com',kind:'link'}]};
    const bytes=JSON.stringify(inbox);
    const job={exportId:inbox.export_id,itemIds:['a'],inboxSha256:createHash('sha256').update(bytes).digest('hex'),inboxMimeType:'application/json'};
    await writeFile(join(directory,'inbox.bin'),bytes);
    await writeFile(join(directory,'job.json'),JSON.stringify({job}));
    await assert.rejects(executeBatch(directory,async()=>{
      await writeFile(join(directory,'organized.json'),'{}');
    }));
    job.inboxSha256='0'.repeat(64);
    await writeFile(join(directory,'job.json'),JSON.stringify({job}));
    let called=false;
    await assert.rejects(executeBatch(directory,async()=>{called=true;}),/SHA mismatch/);
    assert.equal(called,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
