import { executeBatch } from '../../scripts/windows/execute-batch.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
if (process.env.PA_TEST_PROCESS_MARKER) {
  if(process.env.PA_TEST_REAL_CODEX){
    const marker=process.env.PA_TEST_PROCESS_MARKER;
    const hold=marker+'.hold.mjs';
    await writeFile(hold,'import {writeFileSync} from "node:fs"; writeFileSync('+JSON.stringify(marker+'.tool')+', JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);');
    const child=spawn(process.env.PA_CODEX_EXECUTABLE || 'codex',['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','-s','workspace-write','-c','approval_policy="never"','-c','windows.sandbox="elevated"','-o',marker+'.response.txt','-'],{windowsHide:true,stdio:['pipe','ignore','pipe']});
    child.stderr.pipe(createWriteStream(marker+'.codex.log'));
    child.once('exit',code=>writeFile(marker+'.exit',String(code)));
    child.on('error',()=>process.exit(8));
    await writeFile(marker,JSON.stringify({parent:process.pid,child:child.pid}));
    child.stdin.end('This is an authorized local process-lifecycle test. Use your shell tool to run exactly: node "'+hold+'" . It writes only a synthetic PID marker and waits. Let it run; the external test harness will terminate it. Do not read any other files, browse, call a broker, or access accounts.');
    await new Promise(()=>{});
  }
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
