import { executeBatch } from '../../scripts/windows/execute-batch.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
if (process.env.PA_TEST_PROCESS_MARKER) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await writeFile(process.env.PA_TEST_PROCESS_MARKER, JSON.stringify({ parent: process.pid, child: child.pid }));
  if(process.env.PA_TEST_EXIT_AFTER_SPAWN)process.exit(7);
  await new Promise(() => {});
}
await executeBatch(process.argv[2], async(directory,input)=>{
  const inbox=JSON.parse(await readFile(input,'utf8'));
  await writeFile(join(directory,'organized.json'),JSON.stringify({
    format:'pocket-archive-organized',schema_version:2,source_export_id:inbox.export_id,
    items:inbox.items.map(x=>({id:x.id,analysis_status:'insufficient_data',suggested_tags:[],suggested_categories:[],
      summary:'',reason:'Fixture has no source reader',confidence:'low',
      evidence:{status:'unavailable',kind:'metadata',source_url:x.url,excerpt:'',observed_at:new Date().toISOString(),reason:'fixture'}}))
  }));
});
